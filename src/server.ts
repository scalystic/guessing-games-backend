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
const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? '*'

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  path: '/ws/socket.io',
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
})

registerSocketHandlers(io)

httpServer.listen(port, () => {
  console.log(`> sargam-realtime-server ready on :${port}`)
})
