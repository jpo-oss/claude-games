export type Period = 'today' | 'week' | 'month' | 'all'
export type GuessRow = { word: string; marks: string }
export type Today = { number: number; day: string; endsAt: number; guesses: GuessRow[]; state: 'playing' | 'won' | 'lost'; answer: string | null }
export type BoardRow = { rank: number; login: string; points: number | null; guesses: number | null; played: number; ms: number }
export type Board = { period: Period; rows: BoardRow[]; you: BoardRow | null }
export type Stats = { played: number; won: number; streak: number; bestStreak: number; distribution: number[] }
export type View = {
  me: string | null
  notice: string | null
  today: Today | null
  board: Board | null
  stats: Stats | null
  isSending: boolean
  // Bumped on each rejected word so the Client flashes the row once per rejection.
  rejected: number
  copied: 'ok' | 'failed' | null
  // $.clock.now() when today last loaded, so the Client's countdown runs on the engine's clock.
  now: number
}
export type ClientMsg = { type: 'guess'; word: string } | { type: 'board'; period: Period } | { type: 'share' } | { type: 'retry' }

declare module 'claude-code' {
  interface PluginState {
    'daily-diff': { view: View }
  }
}
