# Brain Battle
Real-time quiz for 2–8 players. Node + `ws` WebSocket server; one static client served by the same process.

## Play
1. Open the public URL, enter a nickname, **Create Room** → share the 4-letter code (or "Copy invite link").
2. Friends enter code + nickname → **Join Room**. Everyone can toggle Ready.
3. Host presses **Start** (needs ≥2 connected players). 8 questions, 15s each; 1000 pts + up to 500 speed bonus.
4. Final screen → host presses **Rematch** (same room, same players, scores reset).

## Architecture
- `server.js` is authoritative: room membership, host rights, timers, answers, scoring, rematch.
- Clients send only intents (`create/join/ready/start/answer/rematch`); server broadcasts a per-player view after every change.
- Correct answer index is only included in the `reveal` phase. Options are shuffled server-side.
- Timers: server sends `endsAt` (epoch ms) + `now`; client corrects for clock offset. Question closes at the deadline or when all connected players answered.
- Identity: server-issued player id kept in `sessionStorage`; auto-reconnect rejoins the same seat. Host migrates to a connected player if the host drops.
- Lobby seats of players offline >45s are freed; empty rooms deleted after 10 min.

## Environment variables (all optional; no secrets are needed)
`PORT` (3000), `QUESTIONS_PER_MATCH` (8), `QUESTION_SECONDS` (15), `REVEAL_SECONDS` (5).
Note: the client progress bar assumes the 15s/5s defaults.

## Deploy
Any host with long-lived WebSockets (Render, Railway, Fly.io, a VPS): build `npm install`, start `npm start`, health check `/health`. Run **one instance** — room state is in memory. (Serverless/Vercel-style hosts won't work.)

## Known limits
- State is in-memory: a server restart ends all rooms. For multi-instance scaling or restart survival, move the `rooms` map to Redis and add sticky routing per room code.
- No rate limiting beyond a 2KB message cap.

## Test
`npm test` spawns the server and runs 14 checks with real WebSocket clients.
