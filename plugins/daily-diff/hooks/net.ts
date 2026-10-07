import type { HttpInit, HttpResponse } from 'claude-code'

import type { Board, BoardRow, ClientMsg, Period, Stats, Today } from '../types'

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export type GiveUp = (signal: AbortSignal) => Promise<void>

// The returned fetch rejects once giveUp resolves, and cancels giveUp once the request settles.
export const withGiveUp =
  (fetch: Fetch, giveUp: GiveUp): Fetch =>
  async (url, init) => {
    const stop = new AbortController()
    const timedOut = giveUp(stop.signal).then(
      () => Promise.reject(new Error('timed out')),
      () => new Promise<never>(() => undefined),
    )
    try {
      return await Promise.race([fetch(url, init), timedOut])
    } finally {
      stop.abort()
    }
  }

export type Reply<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

export const PROTOCOL_VERSION = 1
export const GAME = 'daily-diff'

export function buildRequest(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string | null,
  body?: unknown,
): { url: string; init: HttpInit } {
  const headers: Record<string, string> = {
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    Accept: 'application/json',
    'X-Protocol-Version': String(PROTOCOL_VERSION),
    'X-Game': GAME,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  return {
    url: base.replace(/\/+$/, '') + path,
    init: { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  }
}

export async function call(
  fetch: Fetch,
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string | null,
  body?: unknown,
  giveUp: GiveUp = () => new Promise(() => undefined),
): Promise<Reply<unknown>> {
  const { url, init } = buildRequest(base, method, path, token, body)
  try {
    const res = await withGiveUp(fetch, giveUp)(url, init)
    let data: unknown = null
    try {
      data = JSON.parse(res.text)
    } catch {
      // a non-JSON body (a proxy error page) is handled below by status
    }
    if (res.ok) return { ok: true, data }
    const error = (data as { error?: unknown } | null)?.error

    return { ok: false, status: res.status, error: typeof error === 'string' ? cleanText(error) : `HTTP ${res.status}` }
  } catch {
    return { ok: false, status: 0, error: 'unreachable' }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const LOGIN = /^[A-Za-z0-9-]{1,39}$/
export const login = (v: unknown): string | null => (typeof v === 'string' && LOGIN.test(v) ? v : null)
export const cleanText = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120)

const WORD = /^[a-z]{5}$/
const MARKS = /^[gyx]{5}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const PERIODS: readonly Period[] = ['today', 'week', 'month', 'all']
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isPeriod = (v: unknown): v is Period => PERIODS.includes(v as Period)

export function parseToday(d: unknown): Today | null {
  if (!isRecord(d) || !count(d.number) || typeof d.day !== 'string' || !DAY.test(d.day) || !count(d.endsAt)) return null
  if (d.state !== 'playing' && d.state !== 'won' && d.state !== 'lost') return null
  if (!Array.isArray(d.guesses) || d.guesses.length > 6) return null
  const guesses = d.guesses.filter(isRecord).filter(g => typeof g.word === 'string' && WORD.test(g.word) && typeof g.marks === 'string' && MARKS.test(g.marks))
  if (guesses.length !== d.guesses.length) return null
  const answer = typeof d.answer === 'string' && WORD.test(d.answer) ? d.answer : null

  return { number: d.number, day: d.day, endsAt: d.endsAt, guesses: guesses.map(g => ({ word: g.word as string, marks: g.marks as string })), state: d.state, answer }
}

function boardRow(r: unknown): BoardRow | null {
  if (!isRecord(r) || !count(r.rank) || !login(r.login) || !count(r.played) || !count(r.ms)) return null
  const guesses = count(r.guesses) && r.guesses >= 1 && r.guesses <= 6 ? r.guesses : null

  return { rank: r.rank, login: r.login as string, points: count(r.points) ? r.points : null, guesses, played: r.played, ms: r.ms }
}

export function parseBoard(d: unknown): Board | null {
  if (!isRecord(d) || !isPeriod(d.period) || !Array.isArray(d.rows)) return null

  return { period: d.period, rows: d.rows.map(boardRow).filter((r): r is BoardRow => r !== null).slice(0, 20), you: boardRow(d.you) }
}

export function parseStats(d: unknown): Stats | null {
  if (!isRecord(d) || !count(d.played) || !count(d.won) || !count(d.streak) || !count(d.bestStreak)) return null
  if (!Array.isArray(d.distribution) || d.distribution.length !== 6 || !d.distribution.every(count)) return null

  return { played: d.played, won: d.won, streak: d.streak, bestStreak: d.bestStreak, distribution: d.distribution as number[] }
}

// A Client posts plain data the hooks side must treat as input, not fact.
export function parseClientMsg(d: unknown): ClientMsg | null {
  if (!isRecord(d)) return null
  if (d.type === 'guess' && typeof d.word === 'string') {
    const word = d.word.trim().toLowerCase()
    return WORD.test(word) ? { type: 'guess', word } : null
  }
  if (d.type === 'board') return isPeriod(d.period) ? { type: 'board', period: d.period } : null
  if (d.type === 'share' || d.type === 'retry') return { type: d.type }

  return null
}
