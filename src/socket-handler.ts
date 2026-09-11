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

/// Bounded, because this call sits directly between a round's deadline firing
/// and the room seeing its reveal. An unbounded fetch to another deployment
/// (cold function, network stall) would hold every player on "waiting for
/// other players" for as long as it took to give up on its own. On a timeout
/// the round resolves anyway: the straggler's RunRound stays PENDING, which
/// resolveRoundInner already reports as FAILED for the reveal.
const GIVEUP_TIMEOUT_MS = 8_000

async function forceGiveUp(runId: string, runToken: string, idempotencyKey: string): Promise<void> {
  await fetch(`${APP_BASE_URL}/api/runs/${runId}/giveup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey }),
    signal: AbortSignal.timeout(GIVEUP_TIMEOUT_MS),
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
  /// When the current round's budget runs out, as epoch ms. Held here (not just
  /// in the timer) so a client reconnecting mid-round gets the SAME deadline
  /// everyone else is counting down to, instead of a fresh full window.
  roundDeadlineMs: number | null
}

const rooms = new Map<string, RoomMemory>()

/// Hard cap on how long one round may stay open when NOBODY has finished it.
/// The reveal ladder is 31.9s of audio across all six stages, so this is a
/// generous double of the time it takes to actually hear every clip.
///
/// It used to be 90s, and used to be described as a mere backstop — "the
/// client's own auto-skip timer walks the ladder well inside this window". That
/// auto-skip is gone (nothing on the client forces a stage forward any more;
/// see LiveMultiplayerRound), which quietly promoted this timeout from backstop
/// to the PRIMARY way a round with an idle player ends. At 90s that meant
/// everyone who had already guessed sat on "waiting for other players" for over
/// a minute — the single worst wait in the game.
const ROUND_TIMEOUT_MS = 60_000

/// Once the first player resolves the round, everyone else gets at most this
/// long to finish before the room moves on (see applyGraceDeadline).
///
/// This, not the cap above, is what actually bounds the wait in a real game:
/// nobody is cut short until someone has genuinely solved or busted, and from
/// that moment the round is guaranteed to wrap inside 15s instead of running
/// out the full window on one idle tab.
const FIRST_FINISH_GRACE_MS = 15_000

/// How long the reveal panel stays up between a round resolving and the next
/// one starting. Sent to clients as `nextRoundAt` so their countdown is the
/// server's real schedule rather than a duplicated constant that can drift.
/// Long enough to read the song and the scoreline, short enough that ten rounds
/// don't add a minute of staring at a panel nobody can interact with.
const RESULTS_DELAY_MS = 3_500

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

/// Pick the room's whole puzzle set up front — every player plays the same
/// songs in the same order, which is the only reason a room's scores compare.
///
/// YOUTUBE-ONLY: playability used to mean a stored R2 clip with at least one
/// byte offset per attempt —
///
///   JOIN "PuzzleAsset" a ON a."puzzleId" = p.id AND a.kind = 'AUDIO_CLIP'
///   AND coalesce(array_length(a."stageByteOffsets", 1), 0) >= maxAttempts
///
/// — and that is exactly why every room failed to start with "Not enough
/// puzzles in the catalog": stored clips are retired, so the join matches
/// nothing at all while the catalog is full of perfectly playable songs.
///
/// Playable now means what the solo sampler means by it (the main app's
/// lib/game/selection.ts): the song streams from YouTube, and an admin has
/// signed off on where its hook starts. Those two predicates have to stay in
/// lockstep with selection.ts and api/games/[slug]/search — a room that draws a
/// song the typeahead won't offer is a round nobody in it can guess.
///
/// `maxAttempts` is gone with the byte offsets: the stage ladder for a YouTube
/// round is a play-window the client applies to the stream, not a set of
/// offsets that has to exist up front.
async function selectRoomPuzzles(
  gameId: string,
  totalRounds: number,
  decadeFilter: DecadeFilter | null,
): Promise<string[]> {
  type Row = { id: string }
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT p.id
    FROM "Puzzle" p
    -- INNER JOIN, not LEFT: no song row means no YouTube id means not playable.
    JOIN "Song" s
      ON s."puzzleId" = p.id
    WHERE p."gameId" = ${gameId}
      AND p."isActive" = true
      AND p."isBlocked" = false
      AND s."externalId" IS NOT NULL
      AND s."isLocked" = true
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
      stageOneSolves: p.stageOneSolves,
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

  const solvedFirstStage = runRound.outcome === 'SOLVED' && runRound.stageReached === 1

  await prisma.multiplayerRoomPlayer.update({
    where: { roomId_playerId: { roomId, playerId } },
    data: {
      score: { increment: runRound.points },
      roundsSolved: runRound.outcome === 'SOLVED' ? { increment: 1 } : undefined,
      // Tie-break counter, same one-time award as the score above — see
      // compareStandings.
      stageOneSolves: solvedFirstStage ? { increment: 1 } : undefined,
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
            roundDeadlineMs: null,
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
            socket.emit('round:start', {
              roundIndex: room.currentRound,
              totalRounds: room.totalRounds,
              // The deadline the rest of the room is already counting down to,
              // not a fresh window — reconnecting must not hand this player
              // more time than everyone else has. Falls back to a full window
              // only if this process has no memory of the round (it restarted
              // mid-game), which is the same window its timer would use.
              deadline: new Date(mem.roundDeadlineMs ?? Date.now() + ROUND_TIMEOUT_MS).toISOString(),
            })
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

        const puzzleIds = await selectRoomPuzzles(room.gameId, room.totalRounds, decadeFilter ?? null)
        if (puzzleIds.length < room.totalRounds) {
          // The query is LIMIT totalRounds, so coming up short means this IS the
          // real count — worth saying out loud. "Not enough puzzles" alone sent
          // hosts looking at an empty catalog when the catalog was full and the
          // filter (or the review queue) was the actual constraint.
          const found = puzzleIds.length
          const era = decadeFilter ? ' in the selected era' : ''
          socket.emit('room:error', {
            message:
              `Only ${found} playable song${found === 1 ? '' : 's'}${era} — this room needs ${room.totalRounds}. ` +
              (decadeFilter ? 'Try "All eras", or ' : 'Ask an admin to ') +
              'review more songs so they can be played.',
          })
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
            roundDeadlineMs: null,
          }
          rooms.set(code, mem)
        }

        const TTL_MS = 3 * 60 * 60 * 1000

        // Every player's run is built CONCURRENTLY, and each one's two
        // follow-up writes go together. Serially this was three ~100ms round
        // trips per player before the first note could play — a full room spent
        // most of a second and a half staring at the lobby after pressing
        // Start. Nothing here crosses players (separate runs, separate rows),
        // and the two follow-ups only need the run id, not each other.
        const startedMem = mem
        await Promise.all(
          room.players.map(async (rp) => {
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

            await Promise.all([
              prisma.runRound.create({
                data: {
                  runId: run.id,
                  roundIndex: 1,
                  puzzleId: puzzleIds[0]!,
                },
              }),
              prisma.multiplayerRoomPlayer.update({
                where: { roomId_playerId: { roomId: room.id, playerId: rp.playerId } },
                data: { runId: run.id, status: 'PLAYING' },
              }),
            ])

            startedMem.playerRuns.set(rp.playerId, { runId: run.id, runToken: token })

            const playerSocketId = startedMem.playerSockets.get(rp.playerId)
            if (playerSocketId) {
              io.to(playerSocketId).emit('player:credentials', { runId: run.id, runToken: token })
            }
          }),
        )

        await prisma.multiplayerRoom.update({
          where: { id: room.id },
          data: { status: 'IN_PROGRESS', startsAt: new Date(), currentRound: 1 },
        })

        mem.status = 'IN_PROGRESS'
        mem.roundIndex = 1
        mem.roundDone.clear()
        // A rematch reuses this same RoomMemory, and round 1 of the new game
        // must not inherit the last game's "round 1 already resolved" claim —
        // it would resolve instantly and skip straight past the round.
        mem.resolvedRounds.clear()

        // Without this, every client's RoomInfo.currentRound stays whatever it
        // was during the lobby (the DB default, 0) — the header and
        // leaderboard would show "Round 0 of N" until some unrelated later
        // event happened to trigger a broadcast.
        await broadcastRoomState(io, code)

        io.to(code).emit('game:started', { totalRounds: room.totalRounds, roundIndex: 1 })
        openRound(io, code, room.id, 1, room.totalRounds, mem)
      } catch (e) {
        console.error('[socket] room:start error', e)
        socket.emit('room:error', { message: 'Failed to start game' })
      }
    })

    /// Host-only: put a COMPLETED room back in its lobby, with fresh puzzles and
    /// every score reset. The clients already speak this (the "Done" button on
    /// the game-over panel calls it); without a handler it was a dead button.
    socket.on('room:rematch', async ({ code }) => {
      const playerId = socket.data.playerId
      if (!playerId) return
      try {
        const room = await prisma.multiplayerRoom.findUnique({
          where: { code },
          include: { players: true },
        })
        if (!room) return
        if (room.hostPlayerId !== playerId) return
        if (room.status !== 'COMPLETED') return

        // The round set is keyed @@unique([roomId, roundIndex]), so the next
        // room:start's createMany collides with the finished game's rows unless
        // they go first. The Runs themselves are deliberately left alone: they
        // are that game's record, and each player gets a brand-new one.
        await prisma.multiplayerRound.deleteMany({ where: { roomId: room.id } })

        await prisma.multiplayerRoomPlayer.updateMany({
          where: { roomId: room.id },
          data: {
            score: 0,
            roundsSolved: 0,
            stageOneSolves: 0,
            isWinner: false,
            finishedAt: null,
            runId: null,
            status: 'WAITING',
          },
        })

        await prisma.multiplayerRoom.update({
          where: { id: room.id },
          data: {
            status: 'WAITING',
            currentRound: 0,
            startsAt: null,
            completedAt: null,
            seed: randomBytes(16).toString('hex'),
            // The room was created with a 2h expiry; a rematch is a fresh sitting.
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
          },
        })

        const mem = rooms.get(code)
        if (mem) {
          clearRoundTimer(mem)
          mem.status = 'WAITING'
          mem.roundIndex = 0
          mem.roundDone.clear()
          mem.resolvedRounds.clear()
          mem.playerRuns.clear()
          mem.roundDeadlineMs = null
        }

        // COMPLETED → WAITING is what tells every client this is a rematch
        // rather than a ready-toggle, so their lobby opens on a clean chat.
        await broadcastRoomState(io, code)
      } catch (e) {
        console.error('[socket] room:rematch error', e)
        socket.emit('room:error', { message: 'Failed to restart the room' })
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
      } else {
        // Somebody has now finished, so the round is no longer allowed to run
        // out its full window on whoever is left. Everyone still playing gets
        // the short grace window instead.
        applyGraceDeadline(io, code, room.id, roundIndex, room.totalRounds, mem)
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
          song: {
            select: { title: true, artist: true, album: true, movie: true, releaseYear: true },
          },
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

  // One query for the whole room rather than one per player. Every statement
  // here is ~100ms against the shared (remote) database, so a six-player room
  // was spending over half a second of pure round trips assembling a panel it
  // could have read in a single pass — see docs/performance.md in the main app:
  // the unit to optimise is round trips per interaction, and this interaction
  // is the one every player is sitting and waiting on.
  const runIds = room.players.map((rp) => rp.runId).filter((id): id is string => id !== null)
  const runRounds = await prisma.runRound.findMany({
    where: { runId: { in: runIds }, roundIndex },
  })
  const runRoundByRunId = new Map(runRounds.map((rr) => [rr.runId, rr]))

  const playerResults = []
  for (const rp of room.players) {
    if (!rp.runId) continue
    const runRound = runRoundByRunId.get(rp.runId)
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
      movie: multiRound.puzzle.song.movie ?? null,
      releaseYear: multiRound.puzzle.song.releaseYear ?? null,
    },
    playerResults,
    // Derived from the very timer scheduled below, so the client's countdown
    // can't disagree with when the next round actually opens.
    nextRoundAt: new Date(Date.now() + RESULTS_DELAY_MS).toISOString(),
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

        openRound(io, code, roomId, nextRound, totalRounds, mem)
      }
    })()
  }, RESULTS_DELAY_MS)
}

/// Force-completes any player who hasn't resolved this round yet by burning
/// their remaining attempts server-side (the same mechanism a manual "give up"
/// uses) — so a stalled or disconnected player can never leave the room
/// waiting forever, and their own Run stays in lockstep with the room's round
/// index instead of drifting behind it.
/// Every player is handled CONCURRENTLY, not one after another. Each straggler
/// costs a DB read, a cross-deployment HTTP POST to the main app's /giveup (a
/// real network call — see APP_BASE_URL) and a scoring write, and this runs
/// after the round is already over: serially, a room with several idle players
/// added seconds of dead air between the deadline firing and anybody seeing the
/// reveal. The per-player work is independent — different runs, different rows,
/// and /giveup is idempotency-keyed — so there is nothing to serialise for.
async function forceResolveStragglers(roomId: string, roundIndex: number, mem: RoomMemory): Promise<void> {
  await Promise.all(
    [...mem.playerRuns].map(async ([playerId, creds]) => {
      try {
        const runRound = await prisma.runRound.findUnique({
          where: { runId_roundIndex: { runId: creds.runId, roundIndex } },
        })
        if (!runRound || runRound.outcome !== 'PENDING') return

        await forceGiveUp(creds.runId, creds.runToken, `mp-timeout-${roomId}-${roundIndex}-${playerId}`)
        await awardRoundScore(roomId, playerId, roundIndex)
      } catch (e) {
        console.error('[socket] forceResolveStragglers error', e)
      }
    }),
  )
}

/// Opens a round: stamps its deadline, tells the room to play, and arms the
/// backstop — one function so the `deadline` clients count down to and the
/// timeout the server actually enforces are the same number by construction.
///
/// The backstop (see ROUND_TIMEOUT_MS) force-resolves a round that hasn't
/// resolved by itself in time. resolveRound's own resolvedRounds guard makes
/// that safe to race against the normal everyone's-done path; whichever gets
/// there first wins and the other becomes a no-op.
function openRound(
  io: Server,
  code: string,
  roomId: string,
  roundIndex: number,
  totalRounds: number,
  mem: RoomMemory,
): void {
  clearRoundTimer(mem)
  const deadlineMs = Date.now() + ROUND_TIMEOUT_MS
  mem.roundDeadlineMs = deadlineMs

  io.to(code).emit('round:start', {
    roundIndex,
    totalRounds,
    deadline: new Date(deadlineMs).toISOString(),
  })

  mem.roundTimer = setTimeout(() => {
    void resolveRound(io, code, roomId, roundIndex, totalRounds, mem)
  }, ROUND_TIMEOUT_MS)
}

/// Pulls the open round's deadline in to the short grace window, and re-arms
/// the timer on the new one. Called when a player finishes without ending the
/// round, so the players still guessing are bounded by
/// FIRST_FINISH_GRACE_MS rather than by whatever is left of the full window.
///
/// Only ever SHRINKS the deadline: if less than the grace window is already
/// left, or a previous finisher has set the same grace, this is a no-op — which
/// is also what makes it safe to call on every finisher rather than only the
/// first, since the second one's grace lands later than the first's and is
/// therefore rejected. That matters: a later finisher must not be able to hand
/// the stragglers extra time by finishing.
function applyGraceDeadline(
  io: Server,
  code: string,
  roomId: string,
  roundIndex: number,
  totalRounds: number,
  mem: RoomMemory,
): void {
  // No open deadline means no round to shorten (this process restarted
  // mid-game, or the round already resolved between the emit and here).
  if (mem.roundDeadlineMs === null) return
  if (roundIndex !== mem.roundIndex) return
  if (mem.resolvedRounds.has(roundIndex)) return

  const graceDeadlineMs = Date.now() + FIRST_FINISH_GRACE_MS
  if (graceDeadlineMs >= mem.roundDeadlineMs) return

  clearRoundTimer(mem)
  mem.roundDeadlineMs = graceDeadlineMs

  io.to(code).emit('round:deadline', {
    roundIndex,
    deadline: new Date(graceDeadlineMs).toISOString(),
    reason: 'grace',
  })

  mem.roundTimer = setTimeout(() => {
    void resolveRound(io, code, roomId, roundIndex, totalRounds, mem)
  }, FIRST_FINISH_GRACE_MS)
}

/// Board order, best first. MIRROR of compareStandings in the main app's
/// src/lib/multiplayer/standings.ts — the live board is sorted client-side and
/// the final table server-side, and the two disagreeing means the leader
/// visibly swaps at `game:end` for no reason a player can see.
///
/// Points alone tie constantly: STAGE_BASE is six fixed values, so two players
/// who solved the same rounds off the same rungs finish dead level. The chain
/// after it answers "who did it on less information": more 0.4s solves first
/// (the hardest rung there is), then more songs solved, then seat order so the
/// result is at least stable rather than whatever the DB returned.
const compareStandings = (
  a: { score: number; stageOneSolves: number; roundsSolved: number; seatIndex: number },
  b: { score: number; stageOneSolves: number; roundsSolved: number; seatIndex: number },
): number =>
  b.score - a.score ||
  b.stageOneSolves - a.stageOneSolves ||
  b.roundsSolved - a.roundsSolved ||
  a.seatIndex - b.seatIndex

async function endGame(io: Server, code: string, roomId: string, mem: RoomMemory) {
  const found = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: {
      players: { include: { player: { select: { id: true, displayName: true } } } },
    },
  })
  if (!found) return
  // Sorted here rather than by `orderBy: { score: 'desc' }`: the tie-break
  // chain has to be the one the client already drew mid-game, and it lives in
  // one comparator, not split between a Prisma clause and a JS one.
  const room = { ...found, players: [...found.players].sort(compareStandings) }

  if (room.players.length > 0) {
    const winner = room.players[0]!
    await prisma.multiplayerRoomPlayer.update({
      where: { roomId_playerId: { roomId, playerId: winner.playerId } },
      data: { isWinner: true, finishedAt: new Date() },
    })

    // Concurrent for the same reason as room:start's run creation: two writes
    // per player, all independent, and the whole room is waiting on them
    // before `game:end` carries the final table.
    await Promise.all(
      room.players.flatMap((rp) => [
        prisma.playerGameStat.upsert({
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
        }),
        ...(rp.runId
          ? [
              prisma.run.update({
                where: { id: rp.runId },
                data: { status: 'COMPLETED', endedAt: new Date() },
              }).catch(() => {}),
            ]
          : []),
      ]),
    )
  }

  await prisma.multiplayerRoom.update({
    where: { id: roomId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })

  mem.status = 'COMPLETED'
  clearRoundTimer(mem)
  mem.roundDeadlineMs = null

  const rankings = room.players.map((rp, i) => ({
    rank: i + 1,
    playerId: rp.playerId,
    displayName: rp.player.displayName ?? `Player ${rp.seatIndex + 1}`,
    score: rp.score,
    roundsSolved: rp.roundsSolved,
    stageOneSolves: rp.stageOneSolves,
    isWinner: i === 0,
  }))

  io.to(code).emit('game:end', { rankings })
}
