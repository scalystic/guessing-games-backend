import 'dotenv/config'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { registerSocketHandlers } from './socket-handler'
import { handleAudioRequest } from './audio/routes'
import { installYoutubeCookies } from './audio/cookies'
import type { ServerToClientEvents, ClientToServerEvents } from './types'

const port = Number.parseInt(process.env.PORT ?? '4000', 10)

// This process serves Socket.IO plus one small HTTP surface: /audio/*, the
// extraction service behind the main app's admin hook editor.
//
// WHY THOSE TWO THINGS SHARE A PROCESS. They have nothing to do with each other
// beyond both being work Vercel cannot host — sockets because serverless can't
// hold a connection open, audio extraction because it needs yt-dlp, ffmpeg and a
// filesystem. Render's free tier bills instance-hours across the whole account,
// so a second service would mean either paying or having both spin down and take
// ~50s cold starts. One process it is.
//
// The coupling that matters: extraction is CPU-heavy and this instance's CPU is
// shared. It runs as a spawned subprocess, so the Node event loop keeps serving
// socket events throughout — but a review session and a live match at the same
// moment will contend. Hook review is occasional admin work, so that trade is
// deliberate rather than overlooked.
const httpServer = createServer((req, res) => {
  // Audio endpoints answer for themselves; everything else falls through to the
  // health-check body, which Render's healthCheckPath and the keep-alive cron
  // both depend on.
  void handleAudioRequest(req, res)
    .then((handled) => {
      if (handled) return
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('sargam-realtime-server: ok')
    })
    .catch((error: unknown) => {
      // A throw here would otherwise be an unhandled rejection, which in Node 22
      // takes the whole process down — and with it every live multiplayer room.
      console.error('[audio] unhandled error:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ state: 'error', kind: 'extraction', message: 'Internal error.' }))
      }
    })
})

// CORS_ORIGIN: comma-separated list of allowed origins (your Vercel domain,
// plus http://localhost:3000 for local dev against this server). "*" works
// but stops cookies/credentials from ever being usable here — fine today,
// since auth is proven via the run token / playerId in the socket payload,
// not a cookie.
//
// Entries may use `*` as a wildcard for one hostname label, so
// `https://*.vercel.app` covers Vercel's preview deployments — their hostnames
// carry a per-deployment hash and change on every single push, which no fixed
// list can keep up with.
//
// Empty entries are dropped, and an empty list falls back to allowing any
// origin. That matters: a blank dashboard value would otherwise split into
// [''], an allowlist matching nothing, which rejects every client while
// looking indistinguishable from a server that is simply down.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// Escape every regex metacharacter EXCEPT `*`, then expand `*` to "one label".
const originPatterns = allowedOrigins.map(
  (o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+')}$`),
)

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  path: '/ws/socket.io',
  cors: {
    origin:
      originPatterns.length === 0
        ? '*'
        : (origin, callback) => {
            // curl, health checks and same-origin requests send no Origin at
            // all; there is no browser to protect, so let them through.
            if (!origin) return callback(null, true)
            callback(null, originPatterns.some((re) => re.test(origin)))
          },
    methods: ['GET', 'POST'],
  },
})

registerSocketHandlers(io)

httpServer.listen(port, async () => {
  console.log(`> sargam-realtime-server ready on :${port}`)

  // yt-dlp wants a cookie FILE and Render's free plan only has env vars, so the
  // jar is materialised once at boot. Logged because a silently-ignored cookie
  // value looks exactly like YouTube deciding to challenge you today.
  console.log(`> audio: ${await installYoutubeCookies()}`)
  console.log(
    process.env.AUDIO_SERVICE_SECRET
      ? '> audio: /audio/* enabled (bearer auth)'
      : '> audio: /audio/* will REFUSE every request — AUDIO_SERVICE_SECRET is not set',
  )

  // Printed every boot on purpose: a CORS rejection is invisible from the
  // client side (the browser reports only "no Access-Control-Allow-Origin"),
  // so the allowlist the server ACTUALLY parsed belongs in the logs.
  console.log(
    originPatterns.length === 0
      ? '> CORS: allowing any origin (CORS_ORIGIN unset or empty)'
      : `> CORS: allowing ${allowedOrigins.map((o) => `"${o}"`).join(', ')}`,
  )
})
