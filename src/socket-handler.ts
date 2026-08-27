// MIRROR of the main app's src/lib/multiplayer/socket-handler.ts, adapted to
// run as its own standalone process (this repo has no Next.js app alongside
// it at all — the main app lives entirely in the other repo, on Vercel).
// Copy over again whenever the main app's version changes, re-checking the
// two spots below that had to differ.

import type { Server, Socket } from 'socket.io'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { prisma } from '@/db'
import { escapeHtml } from '@/escape-html'
import { decadeClause, type DecadeFilter } from '@/decade-filter'
import type { ServerToClientEvents, ClientToServerEvents } from './types'

/// DIFFERS from the main app's copy: there, this reached the Next.js app's own
/// /giveup route over a loopback request (same process). Here, the game-action
/// endpoints live in a completely different app/deployment (the Vercel-hosted
/// Next.js repo), so this has to be a real network call to its public URL —
/// required, not optional, hence the eager throw if it's unset.
const APP_BASE_URL = (() => {
  const url = process.env.APP_BASE_URL
  if (!url) throw new Error('APP_BASE_URL is required — the public URL of the main Next.js app (e.g. https://sargam.vercel.app)')
  return url.replace(/\/$/, '')
})()

async function forceGiveUp(runId: string, runToken: string, idempotencyKey: string): Promise<void> {
  await fetch(`${APP_BASE_URL}/api/runs/${runId}/giveup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey }),
  })
}

// In-memory tracking: roomCode → socket set and round completion state
type RoomMemory = {
  playerSockets: Map<string, string> // playerId → socketId
  socketPlayers: Map<string, string> // socketId → playerId
  roundDone: Set<string>             // playerIds who finished the current round
  roundIndex: number
  totalRounds: number
  playerRuns: Map<string, { runId: string; runToken: string }> // playerId → credentials
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED'
  /// Server-side safety net: fires if a round never resolves on its own (a
  /// player closes the tab mid-round, a client bug, a lost round:done). Reset
  /// every time a fresh round starts.
  roundTimer: ReturnType<typeof setTimeout> | null
  /// Guards a round from being resolved twice — the timeout above and the
  /// normal "everyone's done" path can both try, and only one may win.
  resolvedRounds: Set<number>
}

const rooms = new Map<string, RoomMemory>()

/// Generous upper bound on how long one round is allowed to stay open. The
/// client's own auto-skip timer walks the reveal ladder well inside this
/// window under normal conditions — this is purely a backstop so a stalled or
/// disconnected player can never freeze the room for everyone else.
const ROUND_TIMEOUT_MS = 90_000

function clearRoundTimer(mem: RoomMemory): void {
  if (mem.roundTimer) {
    clearTimeout(mem.roundTimer)
    mem.roundTimer = null
  }
}

function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  return { token, tokenHash }
}

async function selectRoomPuzzles(
  gameId: string,
  totalRounds: number,
  maxAttempts: number,
  decadeFilter: DecadeFilter | null,
): Promise<string[]> {
  type Row = { id: string }
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT p.id
    FROM "Puzzle" p
    JOIN "PuzzleAsset" a
      ON a."puzzleId" = p.id
     AND a.kind = 'AUDIO_CLIP'::"AssetKind"
    LEFT JOIN "Song" s
      ON s."puzzleId" = p.id
    WHERE p."gameId" = ${gameId}
      AND p."isActive" = true
      AND p."isBlocked" = false
      AND coalesce(array_length(a."stageByteOffsets", 1), 0) >= ${maxAttempts}
      ${decadeClause(decadeFilter)}
    ORDER BY random()
    LIMIT ${totalRounds}
  `
  return rows.map((r) => r.id)
}

async function getRoomState(code: string) {
  return prisma.multiplayerRoom.findUnique({
    where: { code },
    include: {
      players: {
        include: { player: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: { seatIndex: 'asc' },
      },
      game: { select: { id: true, slug: true, maxAttempts: true } },
    },
  })
}

async function broadcastRoomState(io: Server, code: string) {
  const room = await getRoomState(code)
  if (!room) return
  const mem = rooms.get(code)

  const players = room.players.map((p) => {
    const socketId = mem?.playerSockets.get(p.playerId)
    const isConnected = socketId ? mem?.socketPlayers.has(socketId) : false
    return {
      playerId: p.playerId,
      displayName: p.player.displayName ?? `Player ${p.seatIndex + 1}`,
      avatarUrl: p.player.avatarUrl,
      status: (isConnected ? p.status : 'DISCONNECTED') as RoomPlayerInfo['status'],
      seatIndex: p.seatIndex,
      score: p.score,
      roundsSolved: p.roundsSolved,
      isHost: p.playerId === room.hostPlayerId,
      isWinner: p.isWinner,
    }
  })

  io.to(code).emit('room:state', {
    room: {
      code: room.code,
      gameId: room.gameId,
      gameSlug: room.game.slug,
      status: room.status as 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
      hostPlayerId: room.hostPlayerId,
      maxPlayers: room.maxPlayers,
      totalRounds: room.totalRounds,
      currentRound: room.currentRound,
    },
    players,
  })
}

type RoomPlayerInfo = {
  status: 'WAITING' | 'READY' | 'PLAYING' | 'DISCONNECTED' | 'LEFT'
}

/// Credits a player's already-resolved RunRound to their room score. Shared by
/// the normal "you just finished" path (round:done) and the forced-straggler
/// path (a round timeout give-up) — same points, same one-time award, whichever
/// route got them there. A no-op if the round isn't resolved yet.
///
/// Returns the real outcome/points it just credited, so callers (round:done)
/// can announce it live — a genuine number from the row that was just
/// written, not a re-derived or guessed one.
async function awardRoundScore(
  roomId: string,
  playerId: string,
  roundIndex: number,
): Promise<{ outcome: 'SOLVED' | 'FAILED'; points: number } | null> {
  const rp = await prisma.multiplayerRoomPlayer.findUnique({
    where: { roomId_playerId: { roomId, playerId } },
    select: { runId: true },
  })
  if (!rp?.runId) return null

  const runRound = await prisma.runRound.findUnique({
    where: { runId_roundIndex: { runId: rp.runId, roundIndex } },
  })
  if (!runRound || runRound.outcome === 'PENDING') return null

  await prisma.multiplayerRoomPlayer.update({
    where: { roomId_playerId: { roomId, playerId } },
    data: {
      score: { increment: runRound.points },
      roundsSolved: runRound.outcome === 'SOLVED' ? { increment: 1 } : undefined,
    },
  })

  return { outcome: runRound.outcome, points: runRound.points }
}

export function registerSocketHandlers(io: Server<ClientToServerEvents, ServerToClientEvents>) {
  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    socket.on('room:join', async ({ code, playerId }: { code: string; playerId?: string }, callback) => {
      try {
        const room = await prisma.multiplayerRoom.findUnique({
          where: { code },
          include: { players: true, game: { select: { id: true, slug: true, maxAttempts: true } } },
        })

        if (!room) { callback(false, 'Room not found'); return }
        if (room.status === 'CANCELLED') { callback(false, 'Room was cancelled'); return }

        const myPlayerId = playerId
        if (!myPlayerId) { callback(false, 'playerId required'); return }

        const roomPlayer = room.players.find((p) => p.playerId === myPlayerId)
        if (!roomPlayer) { callback(false, 'You are not in this room'); return }

        let mem = rooms.get(code)
        if (!mem) {
          mem = {
            playerSockets: new Map(),
            socketPlayers: new Map(),
            roundDone: new Set(),
            roundIndex: room.currentRound,
            totalRounds: room.totalRounds,
            playerRuns: new Map(),
            status: room.status as 'WAITING' | 'IN_PROGRESS' | 'COMPLETED',
            roundTimer: null,
            resolvedRounds: new Set(),
          }
          rooms.set(code, mem)
        }

        const oldSocketId = mem.playerSockets.get(myPlayerId)
        if (oldSocketId && oldSocketId !== socket.id) {
          mem.socketPlayers.delete(oldSocketId)
        }
        mem.playerSockets.set(myPlayerId, socket.id)
        mem.socketPlayers.set(socket.id, myPlayerId)

        socket.data.playerId = myPlayerId
        socket.data.roomCode = code
        socket.join(code)

        await prisma.multiplayerRoomPlayer.update({
          where: { roomId_playerId: { roomId: room.id, playerId: myPlayerId } },
          data: { status: room.status === 'IN_PROGRESS' ? 'PLAYING' : 'WAITING' },
        })

        callback(true)
        await broadcastRoomState(io, code)

        if (room.status === 'IN_PROGRESS') {
          const creds = mem.playerRuns.get(myPlayerId)
          if (creds) {
            socket.emit('player:credentials', creds)
            socket.emit('round:start', { roundIndex: room.currentRound, totalRounds: room.totalRounds })
          }
        }
      } catch (e) {
        console.error('[socket] room:join error', e)
        callback(false, 'Internal error')
      }
    })

    socket.on('room:ready', async ({ code }) => {
      const playerId = socket.data.playerId
      if (!playerId) return
      try {
        const room = await prisma.multiplayerRoom.findUnique({ where: { code } })
        if (!room || room.status !== 'WAITING') return

        const rp = await prisma.multiplayerRoomPlayer.findUnique({
          where: { roomId_playerId: { roomId: room.id, playerId } },
        })
        if (!rp) return

        const newStatus = rp.status === 'READY' ? 'WAITING' : 'READY'
        await prisma.multiplayerRoomPlayer.update({
          where: { roomId_playerId: { roomId: room.id, playerId } },
          data: { status: newStatus },
        })
        await broadcastRoomState(io, code)
      } catch (e) {
        console.error('[socket] room:ready error', e)
      }
    })

    socket.on('room:start', async ({ code, decadeFilter }) => {
      const playerId = socket.data.playerId
      if (!playerId) return
      try {
        const room = await prisma.multiplayerRoom.findUnique({
          where: { code },
          include: {
            players: { include: { player: { select: { id: true, displayName: true } } } },
            game: { select: { id: true, slug: true, maxAttempts: true, scoringVersion: true, livesPerRun: true } },
          },
        })
        if (!room) return
        if (room.hostPlayerId !== playerId) { socket.emit('room:error', { message: 'Only the host can start the game' }); return }
        if (room.status !== 'WAITING') return
        if (room.players.length < 1) { socket.emit('room:error', { message: 'Need at least 1 player' }); return }

        const puzzleIds = await selectRoomPuzzles(room.gameId, room.totalRounds, room.game.maxAttempts, decadeFilter ?? null)
        if (puzzleIds.length < room.totalRounds) {
          socket.emit('room:error', { message: 'Not enough puzzles in the catalog for this game' })
          return
        }

        await prisma.multiplayerRound.createMany({
          data: puzzleIds.map((puzzleId, i) => ({
            roomId: room.id,
            roundIndex: i + 1,
            puzzleId,
          })),
        })

        let mem = rooms.get(code)
        if (!mem) {
          mem = {
            playerSockets: new Map(),
            socketPlayers: new Map(),
            roundDone: new Set(),
            roundIndex: 1,
            totalRounds: room.totalRounds,
            playerRuns: new Map(),
            status: 'WAITING',
            roundTimer: null,
            resolvedRounds: new Set(),
          }
          rooms.set(code, mem)
        }

        const TTL_MS = 3 * 60 * 60 * 1000

        for (const rp of room.players) {
          const { token, tokenHash } = mintToken()
          const run = await prisma.run.create({
            data: {
              gameId: room.gameId,
              playerId: rp.playerId,
              mode: 'MULTIPLAYER',
              seed: room.seed,
              status: 'IN_PROGRESS',
              currentRoundIndex: 1,
              livesRemaining: 99,
              maxRounds: room.totalRounds,
              scoringVersion: room.game.scoringVersion,
              isRanked: false,
              tokenHash,
              expiresAt: new Date(Date.now() + TTL_MS),
              multiplayerRoomId: room.id,
            },
          })

          await prisma.runRound.create({
            data: {
              runId: run.id,
              roundIndex: 1,
              puzzleId: puzzleIds[0]!,
            },
          })

          await prisma.multiplayerRoomPlayer.update({
            where: { roomId_playerId: { roomId: room.id, playerId: rp.playerId } },
            data: { runId: run.id, status: 'PLAYING' },
          })

          mem.playerRuns.set(rp.playerId, { runId: run.id, runToken: token })

          const playerSocketId = mem.playerSockets.get(rp.playerId)
          if (playerSocketId) {
            io.to(playerSocketId).emit('player:credentials', { runId: run.id, runToken: token })
          }
        }

        await prisma.multiplayerRoom.update({
          where: { id: room.id },
          data: { status: 'IN_PROGRESS', startsAt: new Date(), currentRound: 1 },
        })

        mem.status = 'IN_PROGRESS'
        mem.roundIndex = 1
        mem.roundDone.clear()

        // Without this, every client's RoomInfo.currentRound stays whatever it
        // was during the lobby (the DB default, 0) — the header and
        // leaderboard would show "Round 0 of N" until some unrelated later
        // event happened to trigger a broadcast.
        await broadcastRoomState(io, code)

        io.to(code).emit('game:started', { totalRounds: room.totalRounds, roundIndex: 1 })
        io.to(code).emit('round:start', { roundIndex: 1, totalRounds: room.totalRounds })
        scheduleRoundTimeout(io, code, room.id, 1, room.totalRounds, mem)
      } catch (e) {
        console.error('[socket] room:start error', e)
        socket.emit('room:error', { message: 'Failed to start game' })
      }
    })

    socket.on('round:done', async ({ code, roundIndex, outcome }) => {
      const playerId = socket.data.playerId
      if (!playerId) return

      const mem = rooms.get(code)
      if (!mem || mem.status !== 'IN_PROGRESS') return
      if (roundIndex !== mem.roundIndex) return
      // Guards against a duplicate emission (client retry, reconnect) double-
      // awarding the same round's points.
      if (mem.roundDone.has(playerId)) return

      const room = await prisma.multiplayerRoom.findUnique({
        where: { code },
        include: { players: { include: { player: { select: { id: true, displayName: true } } } } },
      })
      if (!room) return

      const rp = room.players.find((p) => p.playerId === playerId)
      if (!rp) return
      const displayName = rp.player.displayName ?? `Player ${rp.seatIndex + 1}`

      // Award this player's points the instant THEY finish, not once the
      // slowest player in the room catches up — that's what makes the
      // leaderboard panel update live, per correct guess, instead of in one
      // batch at the end of the round.
      const awarded = await awardRoundScore(room.id, playerId, roundIndex)

      io.to(code).emit('round:progress', { playerId, displayName, done: true, outcome, points: awarded?.points ?? null })
      mem.roundDone.add(playerId)
      await broadcastRoomState(io, code)

      // Broadcast system chat message about the round completion
      const safeDisplayName = escapeHtml(displayName)
      const outcomeText = outcome === 'SOLVED'
        ? `🎉 <strong>${safeDisplayName}</strong> guessed the song correctly!`
        : `❌ <strong>${safeDisplayName}</strong> ran out of attempts!`;

      io.to(code).emit('room:chat', {
        id: randomUUID(),
        text: outcomeText,
        at: Date.now(),
        kind: 'system',
      })

      const connectedPlayers = [...mem.playerSockets.keys()]
      const allDone = connectedPlayers.length > 0 && connectedPlayers.every((pid) => mem.roundDone.has(pid))

      if (allDone) {
        await resolveRound(io, code, room.id, roundIndex, room.totalRounds, mem)
      }
    })

    socket.on('room:chat', async ({ code, text }: { code: string; text: string }) => {
      const playerId = socket.data.playerId
      if (!playerId || socket.data.roomCode !== code) return

      const trimmed = text.trim().slice(0, 300)
      if (!trimmed) return

      try {
        const rp = await prisma.multiplayerRoomPlayer.findFirst({
          where: { playerId, room: { code } },
          include: { player: { select: { displayName: true } }, room: { select: { hostPlayerId: true } } },
        })
        if (!rp) return

        io.to(code).emit('room:chat', {
          id: randomUUID(),
          playerId,
          displayName: rp.player.displayName ?? `Player ${rp.seatIndex + 1}`,
          text: trimmed,
          at: Date.now(),
          kind: 'msg',
        })
      } catch (e) {
        console.error('[socket] room:chat error', e)
      }
    })

    socket.on('disconnect', async () => {
      const playerId = socket.data.playerId
      const code = socket.data.roomCode
      if (!playerId || !code) return

      const mem = rooms.get(code)
      if (!mem) return

      mem.playerSockets.delete(playerId)
      mem.socketPlayers.delete(socket.id)

      try {
        const room = await prisma.multiplayerRoom.findUnique({
          where: { code },
          include: { players: true },
        })
        if (!room) return

        await prisma.multiplayerRoomPlayer.update({
          where: { roomId_playerId: { roomId: room.id, playerId } },
          data: { status: 'DISCONNECTED' },
        }).catch(() => {})

        if (mem.status === 'IN_PROGRESS') {
          mem.roundDone.add(playerId)
          const connectedPlayers = [...mem.playerSockets.keys()]
          const allDone = connectedPlayers.every((pid) => mem.roundDone.has(pid))
          if (allDone && connectedPlayers.length > 0) {
            await resolveRound(io, code, room.id, mem.roundIndex, room.totalRounds, mem)
          }
        }

        await broadcastRoomState(io, code)
      } catch (e) {
        console.error('[socket] disconnect error', e)
      }
    })
  })
}

async function resolveRound(
  io: Server,
  code: string,
  roomId: string,
  roundIndex: number,
  totalRounds: number,
  mem: RoomMemory,
) {
  // Both the "everyone's done" path and the round-timeout backstop call this —
  // only the first to arrive may actually resolve the round.
  if (mem.resolvedRounds.has(roundIndex)) return
  mem.resolvedRounds.add(roundIndex)
  clearRoundTimer(mem)

  try {
    await resolveRoundInner(io, code, roomId, roundIndex, totalRounds, mem)
  } catch (e) {
    // Whatever went wrong (a bad query, a transient DB hiccup), the room must
    // not be left permanently stuck on "waiting for other players" with no
    // way forward — release the claim above and give it one more try shortly.
    console.error('[socket] resolveRound error', e)
    mem.resolvedRounds.delete(roundIndex)
    mem.roundTimer = setTimeout(() => {
      void resolveRound(io, code, roomId, roundIndex, totalRounds, mem)
    }, 5000)
  }
}

async function resolveRoundInner(
  io: Server,
  code: string,
  roomId: string,
  roundIndex: number,
  totalRounds: number,
  mem: RoomMemory,
) {
  // Force-finish anyone still mid-round (stalled, disconnected, or just never
  // got here via round:done) so their own Run genuinely advances in lockstep
  // with the room, and so they don't silently miss out on being scored at all.
  await forceResolveStragglers(roomId, roundIndex, mem)

  const multiRound = await prisma.multiplayerRound.findUnique({
    where: { roomId_roundIndex: { roomId, roundIndex } },
    include: {
      puzzle: {
        include: {
          // Selected explicitly, not `song: true` — the Song row can carry
          // columns (e.g. a migration applied to the schema but not yet run
          // against this database) that this reveal panel never needed in the
          // first place; over-fetching them turns an unrelated DB drift into
          // an outage for every round in the room.
          song: { select: { title: true, artist: true, album: true, releaseYear: true } },
        },
      },
    },
  })

  if (!multiRound?.puzzle.song) return

  const room = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: {
      players: { include: { player: { select: { id: true, displayName: true } }, run: true } },
    },
  })
  if (!room) return

  const playerResults = []
  for (const rp of room.players) {
    if (!rp.runId) continue
    const runRound = await prisma.runRound.findUnique({
      where: { runId_roundIndex: { runId: rp.runId, roundIndex } },
    })
    if (!runRound) continue

    playerResults.push({
      playerId: rp.playerId,
      displayName: rp.player.displayName ?? `Player ${rp.seatIndex + 1}`,
      outcome: (runRound.outcome === 'PENDING' ? 'FAILED' : runRound.outcome) as 'SOLVED' | 'FAILED' | 'DISCONNECTED',
      stageReached: runRound.stageReached,
      attemptsUsed: runRound.attemptsUsed,
      points: runRound.points,
      solveDurationMs: runRound.solveDurationMs,
    })
    // Scores themselves were already awarded per-player in the round:done
    // handler above, the moment each one finished — that's what makes the
    // leaderboard update live instead of in one batch here. This function is
    // read-only: it just gathers the reveal panel and advances the room.
  }

  io.to(code).emit('round:results', {
    roundIndex,
    puzzle: {
      title: multiRound.puzzle.song.title,
      artist: multiRound.puzzle.song.artist,
      album: multiRound.puzzle.song.album ?? null,
      releaseYear: multiRound.puzzle.song.releaseYear ?? null,
    },
    playerResults,
  })

  setTimeout(() => {
    void (async () => {
      const nextRound = roundIndex + 1
      if (nextRound > totalRounds) {
        await endGame(io, code, roomId, mem)
      } else {
        mem.roundIndex = nextRound
        mem.roundDone.clear()

        await prisma.multiplayerRoom.update({
          where: { id: roomId },
          data: { currentRound: nextRound },
        })

        // Same reason as room:start — the round number the clients display
        // has to be pushed, not just the round:start signal to start playing.
        await broadcastRoomState(io, code)

        io.to(code).emit('round:start', { roundIndex: nextRound, totalRounds })
        scheduleRoundTimeout(io, code, roomId, nextRound, totalRounds, mem)
      }
    })()
  }, 5000)
}

/// Force-completes any player who hasn't resolved this round yet by burning
/// their remaining attempts server-side (the same mechanism a manual "give up"
/// uses) — so a stalled or disconnected player can never leave the room
/// waiting forever, and their own Run stays in lockstep with the room's round
/// index instead of drifting behind it.
async function forceResolveStragglers(roomId: string, roundIndex: number, mem: RoomMemory): Promise<void> {
  for (const [playerId, creds] of mem.playerRuns) {
    try {
      const runRound = await prisma.runRound.findUnique({
        where: { runId_roundIndex: { runId: creds.runId, roundIndex } },
      })
      if (!runRound || runRound.outcome !== 'PENDING') continue

      await forceGiveUp(creds.runId, creds.runToken, `mp-timeout-${roomId}-${roundIndex}-${playerId}`)
      await awardRoundScore(roomId, playerId, roundIndex)
    } catch (e) {
      console.error('[socket] forceResolveStragglers error', e)
    }
  }
}

/// Schedules the round-timeout backstop (see ROUND_TIMEOUT_MS) — if the round
/// hasn't resolved by itself in time, force it. resolveRound's own
/// resolvedRounds guard makes this safe to race against the normal
/// everyone's-done path; whichever gets there first wins and this becomes a
/// no-op.
function scheduleRoundTimeout(
  io: Server,
  code: string,
  roomId: string,
  roundIndex: number,
  totalRounds: number,
  mem: RoomMemory,
): void {
  clearRoundTimer(mem)
  mem.roundTimer = setTimeout(() => {
    void resolveRound(io, code, roomId, roundIndex, totalRounds, mem)
  }, ROUND_TIMEOUT_MS)
}

async function endGame(io: Server, code: string, roomId: string, mem: RoomMemory) {
  const room = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: {
      players: {
        include: { player: { select: { id: true, displayName: true } } },
        orderBy: { score: 'desc' },
      },
    },
  })
  if (!room) return

  if (room.players.length > 0) {
    const winner = room.players[0]!
    await prisma.multiplayerRoomPlayer.update({
      where: { roomId_playerId: { roomId, playerId: winner.playerId } },
      data: { isWinner: true, finishedAt: new Date() },
    })

    for (const rp of room.players) {
      await prisma.playerGameStat.upsert({
        where: { playerId_gameId: { playerId: rp.playerId, gameId: room.gameId } },
        create: {
          playerId: rp.playerId,
          gameId: room.gameId,
          multiplayerRunsPlayed: 1,
          multiplayerWins: rp.playerId === winner.playerId ? 1 : 0,
        },
        update: {
          multiplayerRunsPlayed: { increment: 1 },
          multiplayerWins: rp.playerId === winner.playerId ? { increment: 1 } : undefined,
        },
      })

      if (rp.runId) {
        await prisma.run.update({
          where: { id: rp.runId },
          data: { status: 'COMPLETED', endedAt: new Date() },
        }).catch(() => {})
      }
    }
  }

  await prisma.multiplayerRoom.update({
    where: { id: roomId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })

  mem.status = 'COMPLETED'

  const rankings = room.players.map((rp, i) => ({
    rank: i + 1,
    playerId: rp.playerId,
    displayName: rp.player.displayName ?? `Player ${rp.seatIndex + 1}`,
    score: rp.score,
    roundsSolved: rp.roundsSolved,
    isWinner: i === 0,
  }))

  io.to(code).emit('game:end', { rankings })
}
