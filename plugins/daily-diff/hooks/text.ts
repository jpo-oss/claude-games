import type { GuessRow, Today } from '../types'

type M = 'g' | 'y' | 'x'
const SQUARE: Record<M, string> = { g: '■', y: '▒', x: '□' }
const RANK: Record<M, number> = { x: 0, y: 1, g: 2 }

export function shareText(t: Today): string {
  const score = t.state === 'won' ? `${t.guesses.length}/6` : 'X/6'
  const rows = t.guesses.map(g => [...g.marks].map(m => SQUARE[m as M]).join(''))

  return [`Daily Diff #${t.number}  ${score}`, '', ...rows, '', '/plugin install daily-diff@claude-games'].join('\n')
}

export function keyMarks(guesses: GuessRow[]): Record<string, M> {
  const out: Record<string, M> = {}
  for (const g of guesses)
    [...g.word].forEach((ch, i) => {
      const m = g.marks[i] as M
      if (out[ch] === undefined || RANK[m] > RANK[out[ch]]) out[ch] = m
    })

  return out
}

const two = (n: number) => String(n).padStart(2, '0')

export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)

  return h > 0 ? `${h}h ${two(m)}m` : `${m}m ${two(s % 60)}s`
}
