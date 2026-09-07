# sargam-realtime-server

Standalone server deployed separately (Render) from the main Next.js app
(Vercel). It does two jobs, and they have nothing in common except that Vercel
can't host either:

1. **Multiplayer sockets.** Hold open Socket.IO connections and drive rooms —
   lobby state, live scoring, chat, round advancement. Serverless functions
   can't keep a connection open.
2. **Audio extraction** (`/audio/*`) for the main app's admin hook editor. Needs
   yt-dlp, ffmpeg and a writable disk; a Vercel function has none of the three.
   See [Audio extraction](#audio-extraction-audio) below.

They share a process because Render's free tier bills instance-hours across the
whole account — ~750/month, which covers one always-on service. A second service
would mean paying, or having both spin down and take ~50s cold starts.

The coupling worth knowing about: extraction is CPU-heavy and this instance's
CPU is shared. It runs as a spawned subprocess, so the Node event loop keeps
serving socket events throughout, but a hook-review session and a live match at
the same moment will contend for CPU. Hook review is occasional admin work, so
that trade is deliberate.

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
- **Same object storage.** `/audio/*` uploads extracted audio to the same R2
  bucket (`S3_*`), which is how a song extracted here becomes servable by the
  main app — and vice versa.
- **Mirrored files, not shared.** `prisma/schema.prisma`, `src/types.ts`,
  `src/decade-filter.ts`, `src/escape-html.ts`, `src/socket-handler.ts`, and the
  encode settings in `src/audio/extract.ts` are copies of things that also exist
  in the main repo. There's no shared package between the two repos (by design —
  they're meant to deploy independently) — when one changes, copy it into the
  other. Each file says so at the top.

## Local dev

```
cp .env.example .env   # fill in DATABASE_URL + APP_BASE_URL
npm install
npm run db:generate
npm run dev             # tsx watch src/server.ts, listens on :4000
```

Point the main app's `NEXT_PUBLIC_SOCKET_URL` at `http://localhost:4000` to
test the two together locally.

To exercise `/audio/*` locally you also need `AUDIO_SERVICE_SECRET`, the four
`S3_*` values, and the yt-dlp binary (`npm run install:yt-dlp`). Then point the
main app's `AUDIO_SERVICE_URL` at `http://localhost:4000`. Note that you
normally *don't* want that in day-to-day local work — leaving it unset makes the
main app extract in its own process, which is both simpler and less likely to
hit a bot challenge.

## Audio extraction (`/audio/*`)

### Why it's here

The main app's admin hook editor exists to place one number — `Song.hookStartMs`
— and stage 1 of a round is 400ms long, so being 300ms out is the difference
between a player's first impression being the vocal or the tail of a cymbal.
Placing it that precisely means seeing a waveform and hearing exact slices, and
the YouTube IFrame API can give neither: `seekTo()` lands within ~50-250ms
because it resolves to a media fragment rather than a sample, and a cross-origin
iframe exposes no audio data at all.

So the editor decodes real audio. Producing it needs yt-dlp, ffmpeg and a
writable disk. Vercel has none, this service has all three: Render's native Node
runtime **ships ffmpeg**, `scripts/install-yt-dlp.mjs` adds yt-dlp at build time,
and there's an ordinary filesystem.

Players are unaffected by any of this — they still stream from YouTube. This only
produces a more accurate number for them to stream from.

### How the pieces fit

```
browser ──▶ main app (Vercel)                    admin session is the only gate
              │  1. POST /audio/extract/:id ───▶ this service
              │                                    yt-dlp | ffmpeg → mono FLAC
              │  2. GET  /audio/status/:id  ───▶   ...uploads to R2
              │  3. streams the object ◀───────  R2
              ▼
            <audio waveform>
```

Two properties of that shape are deliberate:

- **This service never sends audio to a browser.** It only puts objects in R2;
  the main app serves them behind the admin session. One auth gate instead of
  two, no signed URLs to expire, no CORS config here, and none of Render's
  bandwidth spent on 10-40MB files.
- **The R2 key is the video id alone** (`admin-audio/<id>.flac`) — the bytes
  depend on nothing else. So whoever extracts a song first, *including a
  developer's laptop*, makes it available everywhere.

Extraction is a background job rather than a blocking request: a cold pull is
tens of seconds to a couple of minutes, which doesn't fit in a serverless
request. `POST /audio/extract/:id` starts and returns immediately; the caller
polls `GET /audio/status/:id`.

### Endpoints

All are **server-to-server only**, authenticated with
`Authorization: Bearer $AUDIO_SERVICE_SECRET`. No browser may reach them, which
is why there is no CORS handling. **They refuse every request while
`AUDIO_SERVICE_SECRET` is unset** — an unauthenticated endpoint that spawns
yt-dlp on demand is a free CPU-and-bandwidth faucet, and this service's URL is
not a secret.

| Endpoint | Does |
| --- | --- |
| `GET /audio/health` | toolchain + storage readiness, versions, active jobs |
| `GET /audio/status/:videoId` | `{ state: ready\|extracting\|absent\|error }` |
| `POST /audio/extract/:videoId` | start a job, return immediately (`?force=1` re-extracts) |
| `POST /audio/detect-hook/:videoId` | `{ hookStartMs }` — blocks; reuses cached audio when it can |

Start with `/audio/health` when anything looks wrong:

```
curl -H "Authorization: Bearer $AUDIO_SERVICE_SECRET" \
  https://<service>.onrender.com/audio/health
```

`ok: false` with `ytdlp.ok: false` means the build's download step failed — check
the build log for `[install-yt-dlp]`. `storageConfigured: false` means the `S3_*`
vars are missing, and extraction won't even start, because there'd be nowhere to
put the result.

### YouTube and datacenter IPs — read this before debugging

YouTube challenges datacenter address ranges far more aggressively than
residential ones (*"Sign in to confirm you're not a bot"*), and Render is a
datacenter. Extraction from here may work, work intermittently, or be refused
outright depending on what YouTube is doing that week. **This is not a bug in
this service** — it's YouTube declining to serve a cloud IP.

In descending order of how much they actually help:

1. **Review songs from a machine on a home connection.** The main app extracts
   locally when `AUDIO_SERVICE_URL` is unset, and uploads to the same bucket — so
   production picks the song up without this service ever calling YouTube. This
   is the real answer; the rest are patches.
2. **`YTDLP_COOKIES`** — a Netscape `cookies.txt` from a signed-in **throwaway**
   account, which is literally what the challenge is asking for. Raw or base64;
   `src/audio/cookies.ts` accepts either and writes it to a file at boot, because
   yt-dlp wants a path and the free plan has no secret files. These are full
   session credentials — never a personal account — and they expire, faster when
   used from a datacenter.
3. **`YTDLP_PLAYER_CLIENTS=android,ios`** — forcing the mobile players sometimes
   sidesteps the check entirely.
4. **Keep yt-dlp current.** The build fetches the latest release on every deploy
   for exactly this reason; an old binary is the most common cause of failures.
   `YTDLP_VERSION` pins it if you ever need reproducibility instead.

### Storage and the free plan

Render's free instances have no persistent disk, so `/tmp` here is scratch only —
the durable copy is always the R2 object. Nothing is lost on a deploy or a
spin-down except the need to re-download a file R2 already has.

## Deploying (Render)

`render.yaml` in this repo is a Render Blueprint — it carries the build/start
commands, health check, region and instance count, so the dashboard only has to
ask for the secrets.

1. Render → **New → Blueprint**, point it at this repo. It reads `render.yaml`
   and prompts for the `sync: false` vars:
   - `DATABASE_URL` — verbatim copy of the main app's
   - `APP_BASE_URL` — the main app's live Vercel URL, no trailing slash
   - `CORS_ORIGIN` — the main app's origin (comma-separated if more than one).
     Sockets only; `/audio/*` ignores it.
   - `AUDIO_SERVICE_SECRET` — `openssl rand -base64 32`. Set the **same** value
     as `AUDIO_SERVICE_SECRET` in the main app's Vercel project.
   - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` —
     copied verbatim from the main app. Both must write to one bucket.
   - `YTDLP_COOKIES`, `YTDLP_PLAYER_CLIENTS` — optional, leave blank until
     YouTube starts refusing this service.
2. Render builds via `npm install --include=dev && npm run build` (`prisma
   generate` plus the yt-dlp download — there's no app code to bundle) and starts
   via `npm start`. The `--include=dev` matters: Render sets
   `NODE_ENV=production`, and both `prisma` and `tsx` are devDependencies.
3. Take the `https://<service>.onrender.com` URL Render gives this service and
   set it in the main app's Vercel project as **both**:
   - `NEXT_PUBLIC_SOCKET_URL` — for multiplayer. WebSocket upgrade to `wss://`
     is automatic; the custom `/ws/socket.io` path passes through unchanged.
   - `AUDIO_SERVICE_URL` — for the hook editor, no trailing slash.

   Then redeploy the main app.
4. Verify with `/audio/health` (see above) before assuming the editor works.

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
They also drop in-flight extractions and the `/audio/status` error history —
harmless, because completed work lives in R2 and a dropped job is just re-started
by the next poll.

A cold start also means the first `/audio/*` call after a quiet spell can take
~50s to answer. The main app reports that specifically ("a free Render instance
can take ~50s to wake — try again") rather than as a generic network error.

## Keeping the schema in sync

Whenever the main app's `prisma/schema.prisma` changes, copy it over here and
run `npm run db:generate` again. This repo never runs migrations — the main
app's `prisma migrate deploy` is the only thing that ever changes the actual
database shape.
