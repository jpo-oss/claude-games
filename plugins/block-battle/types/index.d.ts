export type ScoreRow = { login: string; score: number; lines: number; level: number; at: number }
export type WinRow = { login: string; wins: number }
export type Leaderboard = { marathon: ScoreRow[]; wins: WinRow[] }

export type Incoming = { id: number; lines: number }
export type Opponent = { login: string; snapshot: string; isOver: boolean }

export type Battle = {
  status: 'idle' | 'queueing' | 'matched' | 'ended'
  roomId: string | null
  seed: number
  opponent: Opponent | null
  // Every attack received this match, by server id; the Client applies each id once.
  incoming: Incoming[]
  result: 'win' | 'loss' | null
}

export type TetrisView = {
  me: string | null
  leaderboard: Leaderboard | null
  // Short human line shown instead of the leaderboard or lobby when the server is unreachable.
  notice: string | null
  battle: Battle
}

// Everything a Client posts to the hooks side. Attacks ride inside `sync`: a post
// replaces an undelivered one within a frame, so a separate message could be lost.
export type ClientMsg =
  | { type: 'menu'; choice: 'marathon' | 'battle' | 'leaderboard' | 'back' }
  | { type: 'gameOver'; score: number; lines: number; level: number; durationMs: number }
  | { type: 'sync'; seq: number; attacks: number[]; snapshot: string; isOver: boolean }

declare module 'claude-code' {
  interface PluginState {
    'block-battle': { view: TetrisView }
  }
}
