# sargam-realtime-server

Standalone Socket.IO server for SARGAM's multiplayer rooms. Deployed
separately (Railway) from the main Next.js app (Vercel) because Vercel's
serverless functions can't host a persistent WebSocket server. This process
does one thing: hold open socket connections and drive multiplayer rooms —
lobby state, live scoring, chat, round advancement.

## How it relates to the main app

- **Same database.** This server reads/writes the same Postgres tables
  (`MultiplayerRoom`, `Run`, `RunRound`, etc.) as the main app — `DATABASE_URL`
  must point at the identical database.
- **Different app for game actions.** Guessing/skipping a song is still a
  REST call from the browser straight to the main app
  (`POST /api/runs/:id/guess`), not routed through this server. This server
  only steps in when it needs to *force*-resolve a stalled round
  (`forceGiveUp` in `socket-handler.ts`), which it does by calling the main
  app's own `/api/runs/:id/giveup` route over the network — see `APP_BASE_URL`.
- **Mirrored files, not shared.** `prisma/schema.prisma`, `src/types.ts`,
  `src/decade-filter.ts`, `src/escape-html.ts`, and `src/socket-handler.ts`
  are copies of files that also exist in the main repo. There's no shared
  package between the two repos (by design — they're meant to deploy
  independently) — when one changes, copy it into the other. Each file says
  so at the top.

## Local dev

```
cp .env.example .env   # fill in DATABASE_URL + APP_BASE_URL
npm install
npm run db:generate
npm run dev             # tsx watch src/server.ts, listens on :4000
```

Point the main app's `NEXT_PUBLIC_SOCKET_URL` at `http://localhost:4000` to
test the two together locally.

## Deploying (Railway)

1. Push this repo to its own GitHub repo, connect it in Railway.
2. Set env vars in Railway's dashboard: `DATABASE_URL` (same value as the main
   app), `APP_BASE_URL` (the main app's live Vercel URL), `CORS_ORIGIN`
   (the main app's origin — comma-separated if more than one).
3. Railway builds via `npm run build` (just `prisma generate` — there's no
   app code to bundle) and starts via `npm start`.
4. Take the URL Railway gives this service and set it as
   `NEXT_PUBLIC_SOCKET_URL` in the main app's Vercel project settings, then
   redeploy the main app.

## Keeping the schema in sync

Whenever the main app's `prisma/schema.prisma` changes, copy it over here and
run `npm run db:generate` again. This repo never runs migrations — the main
app's `prisma migrate deploy` is the only thing that ever changes the actual
database shape.
