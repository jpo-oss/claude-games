import { expect, test } from 'claude-code/testing'

import {
  buildRequest,
  call,
  emptyOutbox,
  mergeIncoming,
  nextPayload,
  parseClientMsg,
  parseLeaderboard,
  parseQueue,
  parseSync,
  queueAttacks,
} from '../hooks/net'

// Expected values are written out by hand from the server's routes, not derived from the builders.

test('a GET carries the session, the protocol version and no body; trailing slashes go', () => {
  expect(buildRequest('https://games.example/', 'GET', '/v1/leaderboard', 'tok')).toEqual({
    url: 'https://games.example/v1/leaderboard',
    init: { method: 'GET', headers: { Authorization: 'Bearer tok', Accept: 'application/json', 'X-Protocol-Version': '1' } },
  })
})

test('a POST sends JSON with a content type', () => {
  expect(buildRequest('http://localhost:8787', 'POST', '/v1/scores', 'tok', { mode: 'marathon', score: 5 })).toEqual({
    url: 'http://localhost:8787/v1/scores',
    init: {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', Accept: 'application/json', 'X-Protocol-Version': '1', 'Content-Type': 'application/json' },
      body: '{"mode":"marathon","score":5}',
    },
  })
})

test('a request without a session has no Authorization header', () => {
  expect(buildRequest('https://games.example', 'POST', '/v1/session', null, { githubToken: 'gho_x' }).init.headers).toEqual({
    Accept: 'application/json',
    'X-Protocol-Version': '1',
    'Content-Type': 'application/json',
  })
})

test('call: ok body, server error, plain-text failure and network failure', async () => {
  const res = (status: number, text: string) => async () => ({ status, ok: status < 300, headers: {}, text })
  expect(await call(res(200, '{"a":1}'), 'http://x', 'GET', '/p', 't')).toEqual({ ok: true, data: { a: 1 } })
  expect(await call(res(403, '{"error":"not a member"}'), 'http://x', 'GET', '/p', 't')).toEqual({ ok: false, status: 403, error: 'not a member' })
  expect(await call(res(502, '<html>bad gateway</html>'), 'http://x', 'GET', '/p', 't')).toEqual({ ok: false, status: 502, error: 'HTTP 502' })
  const down = async () => {
    throw new Error('ECONNREFUSED')
  }
  expect(await call(down, 'http://x', 'GET', '/p', 't')).toEqual({ ok: false, status: 0, error: 'unreachable' })
})

test('incoming attacks merge by id: a repeat is dropped, new ones append, the list is capped', () => {
  const a = { id: 1, lines: 2 }
  const b = { id: 2, lines: 4 }
  expect(mergeIncoming([a], [a, b])).toEqual([a, b])
  expect(mergeIncoming([a, b], [b, b, a])).toEqual([a, b])
  expect(mergeIncoming([], [a, a])).toEqual([a])
  const many = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, lines: 1 }))
  const merged = mergeIncoming([], many)
  expect(merged).toHaveLength(60)
  expect(merged[0]).toEqual({ id: 11, lines: 1 })
})

test('outbox: a failed send is retried with the same seq and attacks; later attacks wait', () => {
  const box = emptyOutbox()
  queueAttacks(box, [3, 4])
  expect(nextPayload(box)).toEqual({ seq: 1, attacks: [3, 4] })
  queueAttacks(box, [2])
  expect(nextPayload(box)).toEqual({ seq: 1, attacks: [3, 4] })
  box.inflight = null
  expect(nextPayload(box)).toEqual({ seq: 2, attacks: [2] })
  box.inflight = null
  expect(nextPayload(box)).toEqual({ seq: 3, attacks: [] })
})

test('attacks the server would reject are clamped or dropped before sending', () => {
  const box = emptyOutbox()
  queueAttacks(box, [99, 0, -2, 1.5, 6])
  expect(box.queued).toEqual([40, 6])
})

test('the server reply is read as the room sends it', () => {
  const reply = {
    opponent: { login: 'bob', snapshot: '.'.repeat(200), isOver: false },
    incoming: [{ id: 5, lines: 2 }, { id: 'x', lines: 1 }, { id: 6, lines: 0 }],
    result: { winner: 'bob', loser: 'alice', reason: 'topout' },
  }
  expect(parseSync(reply)).toEqual({
    opponent: { login: 'bob', snapshot: '.'.repeat(200), isOver: false },
    incoming: [{ id: 5, lines: 2 }],
    winner: 'bob',
  })
  expect(parseSync({ opponent: { login: 'bob' }, incoming: [] })?.winner).toBe(null)
  expect(parseSync('nope')).toBe(null)
})

test('queue replies: waiting, matched, and junk', () => {
  expect(parseQueue({ status: 'waiting' })).toEqual({ status: 'waiting' })
  expect(parseQueue({ status: 'matched', roomId: 'r1', seed: 7, opponent: { login: 'bob', avatar: 'u' } })).toEqual({
    status: 'matched', roomId: 'r1', seed: 7, opponent: 'bob',
  })
  expect(parseQueue({ status: 'matched', roomId: 'r1' })).toBe(null)
  expect(parseQueue(null)).toBe(null)
})

test('the leaderboard keeps five rows a side and tolerates missing fields', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ login: `p${i}`, score: 100 - i, lines: 1, level: 1, at: 1 }))
  const board = parseLeaderboard({ marathon: rows, wins: [{ login: 'a', wins: 2 }, { wins: 1 }] })
  expect(board?.marathon.map(r => r.login)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  expect(board?.wins).toEqual([{ login: 'a', wins: 2 }, { login: '?', wins: 1 }])
  expect(parseLeaderboard({ marathon: [] })).toBe(null)
  expect(parseLeaderboard({ marathon: [], wins: [] })).toEqual({ marathon: [], wins: [] })
})

test('what a Client posts is validated before it is acted on', () => {
  expect(parseClientMsg({ type: 'menu', choice: 'battle' })).toEqual({ type: 'menu', choice: 'battle' })
  expect(parseClientMsg({ type: 'menu', choice: 'wipe' })).toBe(null)
  expect(parseClientMsg({ type: 'gameOver', score: 10, lines: 1, level: 1, durationMs: 5000 })).toEqual({
    type: 'gameOver', score: 10, lines: 1, level: 1, durationMs: 5000,
  })
  expect(parseClientMsg({ type: 'gameOver', score: 'ten', lines: 1, level: 1, durationMs: 5 })).toBe(null)
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: [2], snapshot: '.', isOver: false })).toEqual({
    type: 'sync', seq: 3, attacks: [2], snapshot: '.', isOver: false,
  })
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: [2], snapshot: 'x'.repeat(401), isOver: false })).toBe(null)
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: 'x', snapshot: '.', isOver: false })).toBe(null)
  expect(parseClientMsg(7)).toBe(null)
})
