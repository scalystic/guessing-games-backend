// Shared types for the multiplayer WebSocket protocol.
//
// MIRROR of the main app's src/lib/multiplayer/types.ts — the main app's copy
// is the client-facing source of truth (imported by useMultiplayerRoom.ts);
// this one just has to stay identical so the wire protocol matches. Copy over
// again whenever that file changes.

import type { DecadeFilter } from '@/decade-filter'

export type RoomPlayerInfo = {
  playerId: string
  displayName: string
  avatarUrl: string | null
  status: 'WAITING' | 'READY' | 'PLAYING' | 'DISCONNECTED' | 'LEFT'
  seatIndex: number
  score: number
  roundsSolved: number
  isHost: boolean
  isWinner: boolean
}

export type RoomInfo = {
  code: string
  gameId: string
  gameSlug: string
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  hostPlayerId: string
  maxPlayers: number
  totalRounds: number
  currentRound: number
}

export type RoundPlayerResult = {
  playerId: string
  displayName: string
  outcome: 'SOLVED' | 'FAILED' | 'DISCONNECTED'
  stageReached: number
  attemptsUsed: number
  points: number
  solveDurationMs: number | null
}

export type RoundResults = {
  roundIndex: number
  puzzle: {
    title: string
    artist: string
    album: string | null
    /// The film, when the track is from one. The reveal panel shows this next
    /// to the artist; `album` is still sent because the client's art lookup
    /// matches better against the store's own collection name.
    ///
    /// Hand-kept copy of RoundResults in the main app's
    /// src/lib/multiplayer/types.ts — the two are wire-compatible by
    /// convention, not by import, so a field added here has to be added there.
    movie: string | null
    releaseYear: number | null
  }
  playerResults: RoundPlayerResult[]
  /// ISO timestamp of when `round:start` (or `game:end`) fires for this
  /// result — lets the client render a live countdown instead of guessing at
  /// the server's internal delay.
  nextRoundAt: string
}

export type FinalRanking = {
  rank: number
  playerId: string
  displayName: string
  score: number
  roundsSolved: number
  isWinner: boolean
}

export type ChatMessageData = {
  id: string
  playerId?: string
  displayName?: string
  text: string
  at: number
  kind?: 'system' | 'msg'
}

// ---- Server → Client events ----

export type ServerToClientEvents = {
  'room:state': (data: { room: RoomInfo; players: RoomPlayerInfo[] }) => void
  'room:error': (data: { message: string }) => void
  'player:credentials': (data: { runId: string; runToken: string }) => void
  'game:started': (data: { totalRounds: number; roundIndex: number }) => void
  /// `deadline` is an ISO timestamp of when this round's budget runs out (the
  /// same clock the server enforces via ROUND_TIMEOUT_MS) — the client renders
  /// a countdown from it rather than assuming a duration.
  'round:start': (data: { roundIndex: number; totalRounds: number; deadline: string }) => void
  /// The round's deadline moved EARLIER while it was still open — today only
  /// because the first player finished and the rest are now on the shorter
  /// grace window (FIRST_FINISH_GRACE_MS). Its own event rather than a second
  /// `round:start` because a re-`round:start` would reset the client's
  /// per-player progress dots, wiping the "who's already done" markers that
  /// are the whole point of the wait. Only ever shrinks the window.
  'round:deadline': (data: { roundIndex: number; deadline: string; reason: 'grace' }) => void
  'round:progress': (data: { playerId: string; displayName: string; done: boolean; outcome: 'SOLVED' | 'FAILED' | null; points: number | null }) => void
  'round:results': (data: RoundResults) => void
  'game:end': (data: { rankings: FinalRanking[] }) => void
  'room:chat': (data: ChatMessageData) => void
}

// ---- Client → Server events ----

export type ClientToServerEvents = {
  'room:join': (data: { code: string; playerId?: string }, callback: (ok: boolean, error?: string) => void) => void
  'room:ready': (data: { code: string }) => void
  /// decadeFilter is the host's choice, made once right before starting —
  /// null/omitted means every era, same "no filter" meaning solo play uses.
  'room:start': (data: { code: string; decadeFilter?: DecadeFilter | null }) => void
  /// Host-only: restarts a COMPLETED room with fresh puzzles and every
  /// player's score/rounds reset to zero — same room and players, round 1
  /// again.
  'room:rematch': (data: { code: string }) => void
  'round:done': (data: { code: string; roundIndex: number; outcome: 'SOLVED' | 'FAILED' }) => void
  'room:chat': (data: { code: string; text: string }) => void
}
