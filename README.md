# sargam-realtime-server

Standalone Socket.IO server for SARGAM's multiplayer rooms. Deployed
separately (Render) from the main Next.js app (Vercel) because Vercel's
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

## Deploying (Render)

`render.yaml` in this repo is a Render Blueprint — it carries the build/start
commands, health check, region and instance count, so the dashboard only has
to ask for the three secrets.

1. Render → **New → Blueprint**, point it at this repo. It reads `render.yaml`
   and prompts for the three `sync: false` vars: `DATABASE_URL` (verbatim copy
   of the main app's), `APP_BASE_URL` (the main app's live Vercel URL, no
   trailing slash), `CORS_ORIGIN` (the main app's origin — comma-separated if
   more than one).
2. Render builds via `npm install --include=dev && npm run build`
   (`prisma generate` — there's no app code to bundle) and starts via
   `npm start`. The `--include=dev` matters: Render sets `NODE_ENV=production`,
   and both `prisma` and `tsx` are devDependencies.
3. Take the `https://<service>.onrender.com` URL Render gives this service and
   set it as `NEXT_PUBLIC_SOCKET_URL` in the main app's Vercel project
   settings, then redeploy the main app. WebSocket upgrade to `wss://` is
   automatic; the custom `/ws/socket.io` path passes through unchanged.

### On the free plan

Free instances spin down after 15 minutes without an inbound request, and cold
start takes ~50s — which a player waiting to join a room will feel. Keep it
awake with an external cron (cron-job.org, or a scheduled GitHub Action)
hitting `https://<service>.onrender.com/` every 10 minutes; the root route
already returns 200 for exactly this reason. 750 free instance-hours/month
covers one always-on service (~720h), but they're shared across every free
service in the account.

Don't rely on open sockets to keep it alive — spin-down watches inbound
requests, and a long-lived WebSocket may not count.

Deploys and restarts drop live rooms, since room state is an in-process Map.

## Keeping the schema in sync

Whenever the main app's `prisma/schema.prisma` changes, copy it over here and
run `npm run db:generate` again. This repo never runs migrations — the main
app's `prisma migrate deploy` is the only thing that ever changes the actual
database shape.
