export type ScoreRow = { login: string; score: number; lines: number; level: number; at: number }
export type WinRow = { login: string; wins: number }
export type BotLevel = 'easy' | 'medium' | 'hard'
export type BotRow = { login: string; ms: number; at: number }
export type Leaderboard = { marathon: ScoreRow[]; wins: WinRow[]; bot: Record<BotLevel, BotRow[]> }

export type Incoming = { id: number; lines: number }
export type Opponent = { login: string; snapshot: string; isOver: boolean }
export type Online = { playing: number; looking: number }

export type Battle = {
  status: 'idle' | 'queueing' | 'matched' | 'ended'
  roomId: string | null
  seed: number
  opponent: Opponent | null
  // Every attack received this match, by server id; the Client applies each id once.
  incoming: Incoming[]
  result: 'win' | 'loss' | null
  // Server-wide counts from the latest queue reply of this search; null until one carries them.
  online: Online | null
}

export type GameView = {
  me: string | null
  leaderboard: Leaderboard | null
  // Short human line shown instead of the leaderboard or lobby when the server is unreachable.
  notice: string | null
  battle: Battle
  servers: Servers
  marathon: { nonce: number; gameId: string | null; seed: number } | null
  vsbot: { nonce: number; level: BotLevel; gameId: string | null; seed: number } | null
  uploaded: { key: string; have: number } | null
}

export type Servers = {
  // The plugin's configured server, the official one unless the player changed the setting.
  home: string
  last: string | null
  // Where Battle and the leaderboard talk to right now.
  active: string
}

// Everything a Client posts to the hooks side. Attacks ride inside `sync`: a post
// replaces an undelivered one within a frame, so a separate message could be lost.
export type ClientMsg =
  | { type: 'menu'; choice: 'leaderboard' | 'back' }
  | { type: 'menu'; choice: 'marathon'; nonce: number }
  | { type: 'menu'; choice: 'bot'; level: BotLevel; nonce: number }
  | { type: 'menu'; choice: 'battle'; server: string }
  | { type: 'sync'; seq: number; attacks: number[]; snapshot: string; isOver: boolean }
  | { type: 'log'; kind: 'marathon' | 'battle' | 'bot'; key: string; steps: number; inputsLen: number; total: number; at: number; values: number[] }

declare module 'claude-code' {
  interface PluginState {
    'block-battle': { view: GameView }
  }
}
