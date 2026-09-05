# MonkeyNet

Friends, friend requests and direct messages for Monkey Client.

Node + Postgres. Runs on Render's free tier with a Neon database.

## Why not Cloudflare Workers

Mojang screens their APIs by IP address and blocks Cloudflare's shared Worker
address pools, so identity checks there fail with 403 no matter what you send.
An ordinary host has an address Mojang will answer.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon connection string. Required; the server exits without it. |
| `PORT` | Set automatically by Render. |

## How it knows who you are

1. Launcher asks for a challenge. The server returns a random `serverId`.
2. Launcher calls Mojang's `session/join` with that `serverId`.
3. Launcher asks the server to verify. The server asks Mojang's `hasJoined`
   whether that player really joined that `serverId`.
4. Mojang answers with a verified UUID. The server issues its own token.

The same handshake a Minecraft server uses for a joining player. Your
Minecraft access token never reaches this server.

## The free-tier catch

Render idles a free service after 15 minutes without traffic. The first
request after that takes roughly 30 seconds while it wakes, and open
WebSockets are dropped when it sleeps, so presence can go stale. Fine for
playing with friends; upgrade if it gets real use.
