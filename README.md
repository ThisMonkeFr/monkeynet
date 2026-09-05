# MonkeyNet

Friends, friend requests and direct messages for Monkey Client.

```bash
npm install
npm start          # listens on :8787
```

Point the launcher at it with `MONKEYNET_URL`, or edit `electron/config.js`.

## How it knows who you are

There is no Minecraft friends API, so MonkeyNet has to establish identity
itself. It does that without ever seeing your account token:

1. Launcher asks for a challenge. Server returns a random `serverId`.
2. Launcher calls Mojang's `session/join` with that `serverId`.
3. Launcher asks the server to verify. Server asks Mojang's `hasJoined`
   whether that player really joined that `serverId`.
4. Mojang answers with the verified UUID. Server issues its own session token.

This is the same handshake a Minecraft server uses to check a joining player,
which is why it is trustworthy. A stolen username gets you nothing: step 2 is
impossible without the real account.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/challenge` | Start the handshake |
| POST | `/auth/verify` | Finish it, receive a session token |
| GET | `/friends` | Friends with live online status |
| GET | `/friends/requests` | Incoming requests |
| POST | `/friends/request` | Send one by username |
| POST | `/friends/requests/:id/accept` | Accept |
| POST | `/friends/requests/:id/decline` | Decline |
| DELETE | `/friends/:uuid` | Remove a friend |
| GET | `/messages/:uuid` | Last 300 messages with one friend |
| WS | `/ws?token=` | Live messages and presence |

Requests to players who have never opened Monkey Client work: the server
resolves them through Mojang and stores the request until they sign in.

## Deploying

See **DEPLOY.md**. Short version: it ships with a Dockerfile, needs a volume at
`/data`, and must be served over HTTPS because the session token is a bearer
token. Until it has a public address, friends only works on the machine running
the server.

`GET /health` returns `{ ok: true, users: n }` so you can confirm a deploy.

## Before you open it to the public

- Add message retention and a delete-my-data route.
- Add a block list. Right now anyone who knows your username can message you
  once you accept them.
- The rate limiter is per-IP and in-memory; swap it for something shared if you
  run more than one instance.
