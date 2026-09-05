/* ------------------------------------------------------------------
   MonkeyNet — friends, requests and direct messages for Monkey Client.

   Runs on an ordinary Node host (Render) with Postgres (Neon) for
   storage. That matters: Mojang blocks Cloudflare Worker IP ranges, so
   the identity check has to run somewhere with a normal address.

   Identity uses Mojang's joinServer / hasJoined handshake, so this
   server never sees anyone's Minecraft access token.
   ------------------------------------------------------------------ */
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8787;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add your Neon connection string.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },     // Neon terminates TLS at its proxy
  max: 5                                  // free tiers give few connections
});
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      uuid TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, uuid TEXT NOT NULL, created BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (
      server_id TEXT PRIMARY KEY, username TEXT NOT NULL, created BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS friendships (
      a TEXT NOT NULL, b TEXT NOT NULL, since BIGINT NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, from_uuid TEXT NOT NULL, to_uuid TEXT NOT NULL,
      created BIGINT NOT NULL, UNIQUE (from_uuid, to_uuid));
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, from_uuid TEXT NOT NULL, to_uuid TEXT NOT NULL,
      body TEXT NOT NULL, at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (from_uuid, to_uuid, at);
  `);
  console.log('database ready');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

const now = () => Date.now();
const rid = () => crypto.randomBytes(12).toString('hex');
const dash = u => u.replace(/-/g, '');

/* crude per-IP limiter; enough for a friends server */
const hits = new Map();
app.use((req, res, next) => {
  const rec = hits.get(req.ip) || { n: 0, t: now() };
  if (now() - rec.t > 60000) { rec.n = 0; rec.t = now(); }
  rec.n++; hits.set(req.ip, rec);
  if (rec.n > 180) return res.status(429).json({ error: 'Slow down.' });
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const r = await q('SELECT COUNT(*)::int AS n FROM users');
    res.json({ ok: true, users: r.rows[0].n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- identity ---------------- */
app.post('/auth/challenge', async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: 'That is not a valid Minecraft username.' });
  const serverId = crypto.randomBytes(10).toString('hex');
  await q('INSERT INTO challenges (server_id, username, created) VALUES ($1,$2,$3)',
    [serverId, username, now()]);
  await q('DELETE FROM challenges WHERE created < $1', [now() - 300000]);
  res.json({ serverId });
});

app.post('/auth/verify', async (req, res) => {
  const { username, serverId } = req.body || {};
  const found = await q('SELECT * FROM challenges WHERE server_id = $1', [String(serverId || '')]);
  const row = found.rows[0];
  if (!row) return res.status(400).json({ error: 'Unknown or used challenge.' });
  await q('DELETE FROM challenges WHERE server_id = $1', [serverId]);
  if (now() - Number(row.created) > 120000) return res.status(400).json({ error: 'Challenge expired.' });
  if (row.username.toLowerCase() !== String(username || '').toLowerCase())
    return res.status(400).json({ error: 'Username does not match the challenge.' });

  let profile;
  try {
    const r = await fetch('https://sessionserver.mojang.com/session/minecraft/hasJoined'
      + `?username=${encodeURIComponent(row.username)}&serverId=${encodeURIComponent(serverId)}`);
    if (r.status === 204) return res.status(401).json({ error: 'Mojang could not confirm that session.' });
    if (!r.ok) return res.status(502).json({ error: `Mojang session server said ${r.status}.` });
    const body = await r.text();
    if (!body.trim()) return res.status(401).json({ error: 'Mojang could not confirm that session.' });
    profile = JSON.parse(body);
  } catch (e) {
    return res.status(502).json({ error: 'Mojang session server is unreachable.' });
  }

  const uuid = dash(profile.id);
  await q(`INSERT INTO users (uuid, name, last_seen) VALUES ($1,$2,$3)
           ON CONFLICT (uuid) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen`,
    [uuid, profile.name, now()]);
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO sessions (token, uuid, created) VALUES ($1,$2,$3)', [token, uuid, now()]);
  res.json({ token, uuid, name: profile.name });
});

async function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!t) return res.status(401).json({ error: 'Sign in again.' });
  const s = await q('SELECT uuid FROM sessions WHERE token = $1', [t]);
  if (!s.rows[0]) return res.status(401).json({ error: 'Sign in again.' });
  const u = await q('SELECT * FROM users WHERE uuid = $1', [s.rows[0].uuid]);
  req.me = u.rows[0];
  next();
}

/* ---------------- friends ---------------- */
const friendUuids = async (uuid) => (await q(
  `SELECT b AS u FROM friendships WHERE a = $1
   UNION SELECT a AS u FROM friendships WHERE b = $1`, [uuid])).rows.map(r => r.u);

app.get('/friends', auth, async (req, res) => {
  const ids = await friendUuids(req.me.uuid);
  if (!ids.length) return res.json({ friends: [] });
  const r = await q('SELECT uuid, name FROM users WHERE uuid = ANY($1)', [ids]);
  res.json({ friends: r.rows.map(u => ({ ...u, online: online.has(u.uuid) })) });
});

app.get('/friends/requests', auth, async (req, res) => {
  const r = await q(`SELECT r.id, u.uuid, u.name FROM requests r
    JOIN users u ON u.uuid = r.from_uuid WHERE r.to_uuid = $1 ORDER BY r.created DESC`,
    [req.me.uuid]);
  res.json({ requests: r.rows });
});

async function befriend(a, b) {
  const [x, y] = [a, b].sort();
  await q('INSERT INTO friendships (a, b, since) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [x, y, now()]);
}

app.post('/friends/request', auth, async (req, res) => {
  const name = String(req.body.username || '').trim();
  if (name.toLowerCase() === req.me.name.toLowerCase())
    return res.status(400).json({ error: 'You cannot add yourself.' });

  let target = (await q('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [name])).rows[0];
  if (!target) {
    const r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name));
    if (r.status === 404 || r.status === 204)
      return res.status(404).json({ error: `No Minecraft account named ${name}.` });
    if (!r.ok) return res.status(502).json({ error: 'Mojang lookup failed. Try again shortly.' });
    const p = await r.json();
    target = { uuid: dash(p.id), name: p.name };
    await q('INSERT INTO users (uuid, name, last_seen) VALUES ($1,$2,0) ON CONFLICT DO NOTHING',
      [target.uuid, target.name]);
  }

  const ids = await friendUuids(req.me.uuid);
  if (ids.includes(target.uuid))
    return res.status(409).json({ error: `${target.name} is already your friend.` });

  const incoming = (await q('SELECT * FROM requests WHERE from_uuid = $1 AND to_uuid = $2',
    [target.uuid, req.me.uuid])).rows[0];
  if (incoming) {
    await befriend(target.uuid, req.me.uuid);
    await q('DELETE FROM requests WHERE id = $1', [incoming.id]);
    push(target.uuid, { type: 'friend-added', friend: { uuid: req.me.uuid, name: req.me.name } });
    return res.json({ friended: true, friend: target });
  }

  await q(`INSERT INTO requests (id, from_uuid, to_uuid, created) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`, [rid(), req.me.uuid, target.uuid, now()]);
  push(target.uuid, { type: 'friend-request', from: { uuid: req.me.uuid, name: req.me.name } });
  res.json({ sent: true, to: target.name });
});

app.post('/friends/requests/:id/accept', auth, async (req, res) => {
  const r = (await q('SELECT * FROM requests WHERE id = $1 AND to_uuid = $2',
    [req.params.id, req.me.uuid])).rows[0];
  if (!r) return res.status(404).json({ error: 'That request is gone.' });
  await befriend(r.from_uuid, r.to_uuid);
  await q('DELETE FROM requests WHERE id = $1', [r.id]);
  const friend = (await q('SELECT uuid, name FROM users WHERE uuid = $1', [r.from_uuid])).rows[0];
  push(r.from_uuid, { type: 'friend-added', friend: { uuid: req.me.uuid, name: req.me.name } });
  res.json({ friend });
});

app.post('/friends/requests/:id/decline', auth, async (req, res) => {
  await q('DELETE FROM requests WHERE id = $1 AND to_uuid = $2', [req.params.id, req.me.uuid]);
  res.json({ declined: true });
});

app.delete('/friends/:uuid', auth, async (req, res) => {
  const [x, y] = [req.me.uuid, req.params.uuid].sort();
  await q('DELETE FROM friendships WHERE a = $1 AND b = $2', [x, y]);
  push(req.params.uuid, { type: 'friend-removed', uuid: req.me.uuid });
  res.json({ removed: true });
});

app.get('/messages/:uuid', auth, async (req, res) => {
  const other = req.params.uuid;
  const ids = await friendUuids(req.me.uuid);
  if (!ids.includes(other))
    return res.status(403).json({ error: 'You can only read messages with friends.' });
  const r = await q(`SELECT * FROM messages
    WHERE (from_uuid = $1 AND to_uuid = $2) OR (from_uuid = $2 AND to_uuid = $1)
    ORDER BY at ASC LIMIT 300`, [req.me.uuid, other]);
  res.json({ messages: r.rows.map(m => ({ me: m.from_uuid === req.me.uuid, t: m.body, at: Number(m.at) })) });
});

/* ---------------- realtime ---------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const online = new Map();               // uuid -> Set<ws>

function push(uuid, payload) {
  const set = online.get(uuid);
  if (!set) return;
  const raw = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(raw);
}

wss.on('connection', async (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const s = token && (await q('SELECT uuid FROM sessions WHERE token = $1', [token])).rows[0];
  if (!s) return ws.close(4001, 'unauthorized');
  const me = (await q('SELECT * FROM users WHERE uuid = $1', [s.uuid])).rows[0];

  if (!online.has(me.uuid)) online.set(me.uuid, new Set());
  online.get(me.uuid).add(ws);
  (await friendUuids(me.uuid)).forEach(f => push(f, { type: 'presence', uuid: me.uuid, online: true }));
  ws.send(JSON.stringify({ type: 'ready', uuid: me.uuid, name: me.name }));

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'message') return;
    const text = String(m.text || '').slice(0, 1000).trim();
    if (!text) return;
    const ids = await friendUuids(me.uuid);
    if (!ids.includes(m.to)) return;
    const at = now();
    await q('INSERT INTO messages (id, from_uuid, to_uuid, body, at) VALUES ($1,$2,$3,$4,$5)',
      [rid(), me.uuid, m.to, text, at]);
    push(m.to, { type: 'message', from: me.uuid, name: me.name, text, at });
    ws.send(JSON.stringify({ type: 'message-sent', to: m.to, text, at }));
  });

  ws.on('close', async () => {
    const set = online.get(me.uuid);
    if (set) { set.delete(ws); if (!set.size) online.delete(me.uuid); }
    await q('UPDATE users SET last_seen = $1 WHERE uuid = $2', [now(), me.uuid]).catch(() => {});
    if (!online.has(me.uuid))
      (await friendUuids(me.uuid)).forEach(f => push(f, { type: 'presence', uuid: me.uuid, online: false }));
  });
});

/* Render's free tier idles the service out; a ping every few minutes while
   someone is connected keeps a live chat from being cut off mid-conversation. */
setInterval(() => {
  for (const set of online.values()) for (const ws of set) if (ws.readyState === 1) ws.ping();
}, 240000).unref();

migrate()
  .then(() => server.listen(PORT, '0.0.0.0',
    () => console.log(`MonkeyNet listening on :${PORT}`)))
  .catch(e => { console.error('startup failed:', e.message); process.exit(1); });
