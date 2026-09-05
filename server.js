/* ------------------------------------------------------------------
   MonkeyNet — friends, requests and direct messages for Monkey Client.

   Identity: clients prove they own a Minecraft account using Mojang's
   joinServer / hasJoined handshake. The client tells Mojang it joined a
   server ID we generated; we ask Mojang whether that happened. We never
   see the player's Minecraft token.
   ------------------------------------------------------------------ */
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8787;
const db = new Database(process.env.DB_PATH || 'monkeynet.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  uuid TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, uuid TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (
  server_id TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, from_uuid TEXT NOT NULL, to_uuid TEXT NOT NULL, created INTEGER NOT NULL,
  UNIQUE (from_uuid, to_uuid));
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, from_uuid TEXT NOT NULL, to_uuid TEXT NOT NULL,
  body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (from_uuid, to_uuid, at);
`);

const app = express();
app.set('trust proxy', 1);          // behind a hosting provider's proxy
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, users: db.prepare('SELECT COUNT(*) n FROM users').get().n }));

const now = () => Date.now();
const id = () => crypto.randomBytes(12).toString('hex');
const dash = u => u.replace(/-/g, '');

/* --- rate limiting: crude, per-IP, good enough for a friends server --- */
const hits = new Map();
app.use((req, res, next) => {
  const k = req.ip;
  const rec = hits.get(k) || { n: 0, t: now() };
  if (now() - rec.t > 60_000) { rec.n = 0; rec.t = now(); }
  rec.n++; hits.set(k, rec);
  if (rec.n > 120) return res.status(429).json({ error: 'Slow down.' });
  next();
});

/* ---------------- authentication ---------------- */
app.post('/auth/challenge', (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: 'That is not a valid Minecraft username.' });
  const serverId = crypto.randomBytes(10).toString('hex');
  db.prepare('INSERT INTO challenges (server_id, username, created) VALUES (?,?,?)')
    .run(serverId, username, now());
  res.json({ serverId });
});

app.post('/auth/verify', async (req, res) => {
  const { username, serverId } = req.body || {};
  const row = db.prepare('SELECT * FROM challenges WHERE server_id = ?').get(String(serverId || ''));
  if (!row) return res.status(400).json({ error: 'Unknown or used challenge.' });
  db.prepare('DELETE FROM challenges WHERE server_id = ?').run(serverId);
  if (now() - row.created > 120_000) return res.status(400).json({ error: 'Challenge expired.' });
  if (row.username.toLowerCase() !== String(username || '').toLowerCase())
    return res.status(400).json({ error: 'Username does not match the challenge.' });

  // Ask Mojang whether this player really joined our server ID.
  const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined`
            + `?username=${encodeURIComponent(row.username)}&serverId=${encodeURIComponent(serverId)}`;
  let profile;
  try {
    const r = await fetch(url);
    if (r.status === 204) return res.status(401).json({ error: 'Mojang could not confirm that session.' });
    if (!r.ok) return res.status(502).json({ error: 'Mojang session server is unavailable.' });
    profile = await r.json();
  } catch {
    return res.status(502).json({ error: 'Mojang session server is unreachable.' });
  }

  const uuid = dash(profile.id);
  db.prepare(`INSERT INTO users (uuid, name, last_seen) VALUES (?,?,?)
              ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`)
    .run(uuid, profile.name, now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, uuid, created) VALUES (?,?,?)').run(token, uuid, now());
  res.json({ token, uuid, name: profile.name });
});

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (!s) return res.status(401).json({ error: 'Sign in again.' });
  req.me = db.prepare('SELECT * FROM users WHERE uuid = ?').get(s.uuid);
  next();
}

/* ---------------- friends ---------------- */
const friendUuids = (uuid) => db.prepare(
  'SELECT b AS u FROM friendships WHERE a = ? UNION SELECT a AS u FROM friendships WHERE b = ?'
).all(uuid, uuid).map(r => r.u);

app.get('/friends', auth, (req, res) => {
  const list = friendUuids(req.me.uuid).map(u => {
    const user = db.prepare('SELECT uuid, name FROM users WHERE uuid = ?').get(u);
    return { ...user, online: online.has(u) };
  });
  res.json({ friends: list });
});

app.get('/friends/requests', auth, (req, res) => {
  const rows = db.prepare(`SELECT r.id, u.uuid, u.name FROM requests r
    JOIN users u ON u.uuid = r.from_uuid WHERE r.to_uuid = ? ORDER BY r.created DESC`).all(req.me.uuid);
  res.json({ requests: rows });
});

app.post('/friends/request', auth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (username.toLowerCase() === req.me.name.toLowerCase())
    return res.status(400).json({ error: 'You cannot add yourself.' });

  let target = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(username);
  if (!target) {
    // Not seen before — resolve through Mojang so requests work for players
    // who have not opened Monkey Client yet.
    const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
    if (r.status === 404 || r.status === 204)
      return res.status(404).json({ error: `No Minecraft account named ${username}.` });
    if (!r.ok) return res.status(502).json({ error: 'Mojang lookup failed. Try again shortly.' });
    const p = await r.json();
    target = { uuid: dash(p.id), name: p.name };
    db.prepare('INSERT OR IGNORE INTO users (uuid, name, last_seen) VALUES (?,?,0)').run(target.uuid, target.name);
  }

  if (friendUuids(req.me.uuid).includes(target.uuid))
    return res.status(409).json({ error: `${target.name} is already your friend.` });

  // If they already asked us, accept instead of creating a mirror request.
  const incoming = db.prepare('SELECT * FROM requests WHERE from_uuid = ? AND to_uuid = ?')
    .get(target.uuid, req.me.uuid);
  if (incoming) {
    befriend(target.uuid, req.me.uuid);
    db.prepare('DELETE FROM requests WHERE id = ?').run(incoming.id);
    push(target.uuid, { type: 'friend-added', friend: { uuid: req.me.uuid, name: req.me.name } });
    return res.json({ friended: true, friend: target });
  }

  db.prepare('INSERT OR IGNORE INTO requests (id, from_uuid, to_uuid, created) VALUES (?,?,?,?)')
    .run(id(), req.me.uuid, target.uuid, now());
  push(target.uuid, { type: 'friend-request', from: { uuid: req.me.uuid, name: req.me.name } });
  res.json({ sent: true, to: target.name });
});

function befriend(a, b) {
  const [x, y] = [a, b].sort();
  db.prepare('INSERT OR IGNORE INTO friendships (a, b, since) VALUES (?,?,?)').run(x, y, now());
}

app.post('/friends/requests/:id/accept', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ? AND to_uuid = ?').get(req.params.id, req.me.uuid);
  if (!r) return res.status(404).json({ error: 'That request is gone.' });
  befriend(r.from_uuid, r.to_uuid);
  db.prepare('DELETE FROM requests WHERE id = ?').run(r.id);
  const friend = db.prepare('SELECT uuid, name FROM users WHERE uuid = ?').get(r.from_uuid);
  push(r.from_uuid, { type: 'friend-added', friend: { uuid: req.me.uuid, name: req.me.name } });
  res.json({ friend });
});

app.post('/friends/requests/:id/decline', auth, (req, res) => {
  db.prepare('DELETE FROM requests WHERE id = ? AND to_uuid = ?').run(req.params.id, req.me.uuid);
  res.json({ declined: true });
});

app.delete('/friends/:uuid', auth, (req, res) => {
  const [x, y] = [req.me.uuid, req.params.uuid].sort();
  db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(x, y);
  push(req.params.uuid, { type: 'friend-removed', uuid: req.me.uuid });
  res.json({ removed: true });
});

/* ---------------- messages ---------------- */
app.get('/messages/:uuid', auth, (req, res) => {
  const other = req.params.uuid;
  if (!friendUuids(req.me.uuid).includes(other))
    return res.status(403).json({ error: 'You can only read messages with friends.' });
  const rows = db.prepare(`SELECT * FROM messages
    WHERE (from_uuid = ? AND to_uuid = ?) OR (from_uuid = ? AND to_uuid = ?)
    ORDER BY at ASC LIMIT 300`).all(req.me.uuid, other, other, req.me.uuid);
  res.json({ messages: rows.map(m => ({ me: m.from_uuid === req.me.uuid, t: m.body, at: m.at })) });
});

/* ---------------- realtime ---------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const online = new Map(); // uuid -> Set<ws>

function push(uuid, payload) {
  const set = online.get(uuid);
  if (!set) return;
  const raw = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(raw);
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const s = token && db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return ws.close(4001, 'unauthorized');
  const me = db.prepare('SELECT * FROM users WHERE uuid = ?').get(s.uuid);

  if (!online.has(me.uuid)) online.set(me.uuid, new Set());
  online.get(me.uuid).add(ws);
  friendUuids(me.uuid).forEach(f => push(f, { type: 'presence', uuid: me.uuid, online: true }));
  ws.send(JSON.stringify({ type: 'ready', uuid: me.uuid, name: me.name }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'message') return;
    const text = String(m.text || '').slice(0, 1000).trim();
    if (!text || !friendUuids(me.uuid).includes(m.to)) return;
    const at = now();
    db.prepare('INSERT INTO messages (id, from_uuid, to_uuid, body, at) VALUES (?,?,?,?,?)')
      .run(id(), me.uuid, m.to, text, at);
    push(m.to, { type: 'message', from: me.uuid, name: me.name, text, at });
    ws.send(JSON.stringify({ type: 'message-sent', to: m.to, text, at }));
  });

  ws.on('close', () => {
    const set = online.get(me.uuid);
    if (set) { set.delete(ws); if (!set.size) online.delete(me.uuid); }
    db.prepare('UPDATE users SET last_seen = ? WHERE uuid = ?').run(now(), me.uuid);
    if (!online.has(me.uuid))
      friendUuids(me.uuid).forEach(f => push(f, { type: 'presence', uuid: me.uuid, online: false }));
  });
});

setInterval(() => {
  db.prepare('DELETE FROM challenges WHERE created < ?').run(now() - 300_000);
}, 300_000).unref();

server.listen(PORT, () => console.log(`MonkeyNet listening on :${PORT}`));
