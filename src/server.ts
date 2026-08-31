import 'dotenv/config'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { registerSocketHandlers } from './socket-handler'
import type { ServerToClientEvents, ClientToServerEvents } from './types'

const port = Number.parseInt(process.env.PORT ?? '4000', 10)

// This process does nothing but serve Socket.IO — no Next.js, no pages, no
// other HTTP routes. The main app (a separate repo, on Vercel) owns
// everything else, including the REST endpoints this server calls back into
// (see forceGiveUp in socket-handler.ts).
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('sargam-realtime-server: ok')
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

httpServer.listen(port, () => {
  console.log(`> sargam-realtime-server ready on :${port}`)
  // Printed every boot on purpose: a CORS rejection is invisible from the
  // client side (the browser reports only "no Access-Control-Allow-Origin"),
  // so the allowlist the server ACTUALLY parsed belongs in the logs.
  console.log(
    originPatterns.length === 0
      ? '> CORS: allowing any origin (CORS_ORIGIN unset or empty)'
      : `> CORS: allowing ${allowedOrigins.map((o) => `"${o}"`).join(', ')}`,
  )
})
