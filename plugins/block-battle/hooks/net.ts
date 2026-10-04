import type { HttpInit, HttpResponse } from 'claude-code'

import type { ClientMsg, Incoming, Leaderboard, Opponent } from '../types'

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export type Reply<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

export const MAX_INCOMING = 60

export const PROTOCOL_VERSION = 1

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
): Promise<Reply<unknown>> {
  const { url, init } = buildRequest(base, method, path, token, body)
  try {
    const res = await fetch(url, init)
    let data: unknown = null
    try {
      data = JSON.parse(res.text)
    } catch {
      // a non-JSON body (a proxy error page) is handled below by status
    }
    if (res.ok) return { ok: true, data }
    const error = (data as { error?: unknown } | null)?.error

    return { ok: false, status: res.status, error: typeof error === 'string' ? error : `HTTP ${res.status}` }
  } catch {
    return { ok: false, status: 0, error: 'unreachable' }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseLeaderboard(data: unknown): Leaderboard | null {
  if (!isRecord(data) || !Array.isArray(data.marathon) || !Array.isArray(data.wins)) return null
  const marathon = data.marathon.filter(isRecord).map(r => ({
    login: String(r.login ?? '?'),
    score: num(r.score),
    lines: num(r.lines),
    level: num(r.level),
    at: num(r.at),
  }))
  const wins = data.wins.filter(isRecord).map(r => ({ login: String(r.login ?? '?'), wins: num(r.wins) }))

  return { marathon: marathon.slice(0, 5), wins: wins.slice(0, 5) }
}

export type QueueReply =
  | { status: 'waiting' }
  | { status: 'matched'; roomId: string; seed: number; opponent: string }

export function parseQueue(data: unknown): QueueReply | null {
  if (!isRecord(data)) return null
  if (data.status === 'waiting') return { status: 'waiting' }
  if (data.status === 'matched' && typeof data.roomId === 'string' && typeof data.seed === 'number') {
    const opp = isRecord(data.opponent) ? String(data.opponent.login ?? '?') : '?'

    return { status: 'matched', roomId: data.roomId, seed: data.seed, opponent: opp }
  }

  return null
}

export type SyncReply = { opponent: Opponent | null; incoming: Incoming[]; winner: string | null }

export function parseSync(data: unknown): SyncReply | null {
  if (!isRecord(data)) return null
  const opp = isRecord(data.opponent)
    ? { login: String(data.opponent.login ?? '?'), snapshot: String(data.opponent.snapshot ?? ''), isOver: data.opponent.isOver === true }
    : null
  const incoming = Array.isArray(data.incoming)
    ? data.incoming
        .filter(isRecord)
        .filter(a => typeof a.id === 'number' && typeof a.lines === 'number' && a.lines > 0)
        .map(a => ({ id: a.id as number, lines: a.lines as number }))
    : []
  const winner = isRecord(data.result) && typeof data.result.winner === 'string' ? data.result.winner : null

  return { opponent: opp, incoming, winner }
}

// The server may redeliver a batch when a poll is retried; the id is the identity, so keep the first copy of each.
export function mergeIncoming(have: readonly Incoming[], got: readonly Incoming[]): Incoming[] {
  const seen = new Set(have.map(a => a.id))
  const fresh = got.filter(a => !seen.has(a.id) && seen.add(a.id))

  return [...have, ...fresh].slice(-MAX_INCOMING)
}

// Attacks go out in a payload with a seq. A failed send is retried with the same seq and the
// same attacks, which the server treats as idempotent; attacks made meanwhile wait in `queued`.
export type Outbox = {
  seq: number
  inflight: { seq: number; attacks: number[] } | null
  queued: number[]
}

export const emptyOutbox = (): Outbox => ({ seq: 0, inflight: null, queued: [] })

export function nextPayload(box: Outbox): { seq: number; attacks: number[] } {
  if (box.inflight) return box.inflight
  const attacks = box.queued.splice(0, 20)
  box.seq += 1
  box.inflight = { seq: box.seq, attacks }

  return box.inflight
}

export function queueAttacks(box: Outbox, lines: readonly number[]): void {
  for (const n of lines) if (Number.isInteger(n) && n >= 1) box.queued.push(Math.min(40, n))
}

// A Client posts plain data the hooks side must treat as input, not fact.
export function parseClientMsg(data: unknown): ClientMsg | null {
  if (!isRecord(data)) return null
  if (data.type === 'menu') {
    const c = data.choice
    return c === 'marathon' || c === 'battle' || c === 'leaderboard' || c === 'back' ? { type: 'menu', choice: c } : null
  }
  if (data.type === 'gameOver') {
    const { score, lines, level, durationMs } = data
    return [score, lines, level, durationMs].every(Number.isInteger)
      ? { type: 'gameOver', score: score as number, lines: lines as number, level: level as number, durationMs: durationMs as number }
      : null
  }
  if (data.type === 'sync') {
    const { snapshot, isOver, attacks } = data
    if (typeof snapshot !== 'string' || snapshot.length > 400 || typeof isOver !== 'boolean') return null
    if (!Array.isArray(attacks) || !attacks.every(a => Number.isInteger(a))) return null

    return { type: 'sync', seq: num(data.seq), attacks: attacks as number[], snapshot, isOver }
  }

  return null
}
