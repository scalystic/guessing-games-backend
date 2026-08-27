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
    releaseYear: number | null
  }
  playerResults: RoundPlayerResult[]
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
  'round:start': (data: { roundIndex: number; totalRounds: number }) => void
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
  'round:done': (data: { code: string; roundIndex: number; outcome: 'SOLVED' | 'FAILED' }) => void
  'room:chat': (data: { code: string; text: string }) => void
}
