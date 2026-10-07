import { expect, test } from 'claude-code/testing'

import type { Fetch } from '../hooks/net'

import {
  buildRequest,
  call,
  emptyOutbox,
  mergeIncoming,
  nextPayload,
  parseClientMsg,
  parseLeaderboard,
  parseMarathonStart,
  parseQueue,
  parseSync,
  queueAttacks,
  serverUrlOk,
} from '../hooks/net'

// Expected values are written out by hand from the server's routes, not derived from the builders.

test('a GET carries the session, the protocol version and no body; trailing slashes go', () => {
  expect(buildRequest('https://games.example/', 'GET', '/v1/leaderboard', 'tok')).toEqual({
    url: 'https://games.example/v1/leaderboard',
    init: { method: 'GET', headers: { Authorization: 'Bearer tok', Accept: 'application/json', 'X-Protocol-Version': '3' } },
  })
})

test('a POST sends JSON with a content type', () => {
  expect(buildRequest('http://localhost:8787', 'POST', '/v1/scores', 'tok', { mode: 'marathon', score: 5 })).toEqual({
    url: 'http://localhost:8787/v1/scores',
    init: {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', Accept: 'application/json', 'X-Protocol-Version': '3', 'Content-Type': 'application/json' },
      body: '{"mode":"marathon","score":5}',
    },
  })
})

test('a request without a session has no Authorization header', () => {
  expect(buildRequest('https://games.example', 'POST', '/v1/session', null, { githubToken: 'gho_x' }).init.headers).toEqual({
    Accept: 'application/json',
    'X-Protocol-Version': '3',
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

test('incoming attacks merge by id: a repeat is dropped and new ones append', () => {
  const a = { id: 1, lines: 2 }
  const b = { id: 2, lines: 4 }
  expect(mergeIncoming([a], [a, b])).toEqual([a, b])
  expect(mergeIncoming([a, b], [b, b, a])).toEqual([a, b])
  expect(mergeIncoming([], [a, a])).toEqual([a])
})

test('merged incoming stops at 10,000, the server cap on garbage in one log', () => {
  const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, lines: 1 }))
  const have = mergeIncoming(batch(1, 6_000), batch(6_001, 6_000))
  expect(have).toHaveLength(10_000)
  expect(have[9_999]!.id).toBe(10_000)
  expect(mergeIncoming(have, batch(20_000, 5))).toHaveLength(10_000)
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
    ended: true,
    winner: 'bob',
  })
  expect(parseSync({ opponent: { login: 'bob' }, incoming: [] })?.winner).toBe(null)
  expect(parseSync('nope')).toBe(null)
})

test('queue replies: waiting, matched, and junk', () => {
  expect(parseQueue({ status: 'waiting' })).toEqual({ status: 'waiting', online: null })
  expect(parseQueue({ status: 'matched', roomId: 'r1', seed: 7, opponent: { login: 'bob', avatar: 'u' } })).toEqual({
    status: 'matched', roomId: 'r1', seed: 7, opponent: 'bob', online: null,
  })
  expect(parseQueue({ status: 'matched', roomId: 'r1' })).toBe(null)
  expect(parseQueue(null)).toBe(null)
})

test('the leaderboard keeps five rows a side and drops rows with missing fields', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ login: `p${i}`, score: 100 - i, lines: 1, level: 1, at: 1 }))
  const board = parseLeaderboard({ marathon: rows, wins: [{ login: 'a', wins: 2 }, { wins: 1 }] })
  expect(board?.marathon.map(r => r.login)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  expect(board?.wins).toEqual([{ login: 'a', wins: 2 }])
  expect(parseLeaderboard({ marathon: [] })).toBe(null)
  expect(parseLeaderboard({ marathon: [], wins: [] })).toEqual({ marathon: [], wins: [], bot: { easy: [], medium: [], hard: [] } })
})

test('what a Client posts is validated before it is acted on', () => {
  expect(parseClientMsg({ type: 'menu', choice: 'battle', server: 'https://a.example' })).toEqual({ type: 'menu', choice: 'battle', server: 'https://a.example' })
  expect(parseClientMsg({ type: 'menu', choice: 'battle' })).toBe(null)
  expect(parseClientMsg({ type: 'menu', choice: 'battle', server: 'http://evil.example' })).toBe(null)
  expect(parseClientMsg({ type: 'menu', choice: 'wipe' })).toBe(null)
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: [2], snapshot: '.', isOver: false })).toEqual({
    type: 'sync', seq: 3, attacks: [2], snapshot: '.', isOver: false,
  })
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: [2], snapshot: 'x'.repeat(401), isOver: false })).toBe(null)
  expect(parseClientMsg({ type: 'sync', seq: 3, attacks: 'x', snapshot: '.', isOver: false })).toBe(null)
  expect(parseClientMsg(7)).toBe(null)
})

test('sync drops attacks with an id below 1 or lines not a whole number from 1 to 40, and keeps at most 10,000', () => {
  const bad = [{ id: 0, lines: 2 }, { id: 1, lines: 1e9 }, { id: 2, lines: 2.5 }, { id: 3, lines: 0 }, { id: 4, lines: 41 }, { id: 5, lines: 3 }]
  expect(parseSync({ incoming: bad })?.incoming).toEqual([{ id: 5, lines: 3 }])
  const many = Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1, lines: 1 }))
  expect(parseSync({ incoming: many })?.incoming.length).toBe(10_000)
})

test('sync rejects an opponent with a bad login or snapshot', () => {
  expect(parseSync({ opponent: { login: 'evil\u001b[2J', snapshot: '', isOver: false } })?.opponent).toBeNull()
  expect(parseSync({ opponent: { login: 'bob', snapshot: '.'.repeat(401), isOver: false } })?.opponent).toBeNull()
  expect(parseSync({ opponent: { login: 'bob', snapshot: '<script>', isOver: false } })?.opponent).toBeNull()
  expect(parseSync({ opponent: { login: 'bob', snapshot: '.'.repeat(200), isOver: false } })?.opponent?.login).toBe('bob')
  expect(parseSync({ result: { winner: 'a b' } })?.winner).toBeNull()
})

test('leaderboard rows with bad logins or numbers are dropped', () => {
  const b = parseLeaderboard({
    marathon: [{ login: 'a b', score: 1, lines: 1, level: 1, at: 1 }, { login: 'ok', score: Infinity, lines: 1, level: 1, at: 1 }, { login: 'fine', score: 10, lines: 1, level: 1, at: 1 }],
    wins: [{ login: 'x'.repeat(40), wins: 1 }],
  })
  expect(b?.marathon.map(r => r.login)).toEqual(['fine'])
  expect(b?.wins).toEqual([])
})

test('queue replies carry online counts only when they are whole numbers', () => {
  const waiting = (online: unknown) => parseQueue({ status: 'waiting', online })?.online
  expect(waiting({ playing: 2, looking: 1, names: ['bob'] })).toEqual({ playing: 2, looking: 1 })
  expect(waiting({ playing: 0, looking: 0 })).toEqual({ playing: 0, looking: 0 })
  expect(waiting({ playing: 1e12, looking: 3 })).toEqual({ playing: 100_000, looking: 3 })
  for (const bad of [null, 'lots', [], { playing: 2 }, { playing: -1, looking: 0 }, { playing: 1.5, looking: 0 }, { playing: '2', looking: 1 }, { playing: Infinity, looking: 0 }, { playing: NaN, looking: 0 }])
    expect(waiting(bad)).toBe(null)
  expect(parseQueue({ status: 'matched', roomId: 'r1', seed: 7, opponent: { login: 'bob' }, online: { playing: 4, looking: 0 } })?.online).toEqual({ playing: 4, looking: 0 })
})

test('a queue match needs a safe room id and login', () => {
  expect(parseQueue({ status: 'matched', roomId: '../x', seed: 1, opponent: { login: 'bob' } })).toBeNull()
  expect(parseQueue({ status: 'matched', roomId: 'r1', seed: 1, opponent: { login: 'b b' } })).toBeNull()
  expect(parseQueue({ status: 'matched', roomId: 'r1', seed: 1.5, opponent: { login: 'bob' } })).toBeNull()
})

test('server error text is cleaned and capped', async () => {
  const fetch: Fetch = async () => ({ status: 500, ok: false, headers: {}, text: JSON.stringify({ error: 'run \u001b[31mrm -rf\u001b[0m now ' + 'x'.repeat(500) }) })
  const r = await call(fetch, 'https://s', 'GET', '/v1/leaderboard', 't')
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(r.error.length).toBeLessThanOrEqual(120)
  }
})

test('only https servers, or http on this machine', () => {
  expect(serverUrlOk('https://games.example')).toBe(true)
  expect(serverUrlOk('http://localhost:8787')).toBe(true)
  expect(serverUrlOk('http://127.0.0.1:8787')).toBe(true)
  expect(serverUrlOk('http://example.com')).toBe(false)
  expect(serverUrlOk('http://localhost.example.com')).toBe(false)
  expect(serverUrlOk('ftp://x')).toBe(false)
  expect(serverUrlOk('not a url')).toBe(false)
})

test('a request that never answers gives up as unreachable', async () => {
  const never: Fetch = () => new Promise(() => undefined)
  const r = await call(never, 'https://s', 'GET', '/x', 't', undefined, () => Promise.resolve())
  expect(r).toEqual({ ok: false, status: 0, error: 'unreachable' })
})

test('an answered request cancels its give-up timer', async () => {
  let aborted = false
  const ok: Fetch = async () => ({ status: 200, ok: true, headers: {}, text: '{}' })
  await call(ok, 'https://s', 'GET', '/x', 't', undefined, signal => {
    signal.addEventListener('abort', () => (aborted = true))
    return new Promise(() => undefined)
  })
  expect(aborted).toBe(true)
})

test('protocol 3 header', () => {
  expect(buildRequest('https://x.example', 'GET', '/v1/leaderboard', null).init.headers?.['X-Protocol-Version']).toBe('3')
})

test('parseClientMsg: marathon carries a nonce, gameOver is gone', () => {
  expect(parseClientMsg({ type: 'menu', choice: 'marathon', nonce: 3 })).toEqual({ type: 'menu', choice: 'marathon', nonce: 3 })
  expect(parseClientMsg({ type: 'menu', choice: 'marathon' })).toBe(null)
  expect(parseClientMsg({ type: 'gameOver', score: 10, lines: 1, level: 1, durationMs: 5000 })).toBe(null)
})

test('parseClientMsg: log chunks are checked for shape and bounds', () => {
  const ok = { type: 'log', kind: 'battle', key: 'r1', steps: 10, inputsLen: 2, total: 4, at: 0, values: [0, 1, 3, 7] }
  expect(parseClientMsg(ok)).toEqual(ok)
  expect(parseClientMsg({ ...ok, kind: 'other' })).toBe(null)
  expect(parseClientMsg({ ...ok, key: 'a/b' })).toBe(null)
  expect(parseClientMsg({ ...ok, steps: 0 })).toBe(null)
  expect(parseClientMsg({ ...ok, steps: 450_001 })).toBe(null)
  expect(parseClientMsg({ ...ok, inputsLen: 3 })).toBe(null)
  expect(parseClientMsg({ ...ok, inputsLen: 6 })).toBe(null)
  expect(parseClientMsg({ ...ok, total: 420_002 })).toBe(null)
  expect(parseClientMsg({ ...ok, at: 3 })).toBe(null)
  expect(parseClientMsg({ ...ok, values: new Array(10_001).fill(0) })).toBe(null)
  expect(parseClientMsg({ ...ok, values: [0, 'x'] })).toBe(null)
})

test('parseSync: a result with no winner still ends the match', () => {
  expect(parseSync({ opponent: null, incoming: [], result: { winner: null } })).toMatchObject({ ended: true, winner: null })
  expect(parseSync({ opponent: null, incoming: [], result: { winner: 'bob' } })).toMatchObject({ ended: true, winner: 'bob' })
  expect(parseSync({ opponent: null, incoming: [] })).toMatchObject({ ended: false, winner: null })
})

test('incoming attacks are never capped at 60', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, lines: 1 }))
  expect(parseSync({ opponent: null, incoming: many })?.incoming).toHaveLength(100)
  expect(mergeIncoming(many.slice(0, 70), many)).toHaveLength(100)
})

test('parseMarathonStart', () => {
  expect(parseMarathonStart({ gameId: 'g_1', seed: 42 })).toEqual({ gameId: 'g_1', seed: 42 })
  expect(parseMarathonStart({ gameId: 'g 1', seed: 42 })).toBe(null)
  expect(parseMarathonStart({ gameId: 'g1', seed: -1 })).toBe(null)
  expect(parseMarathonStart({ gameId: 'g1', seed: 2 ** 32 })).toBe(null)
})

test('the leaderboard reads the bot field and tolerates its absence', () => {
  const row = { login: 'ann', ms: 62_500, at: 5 }
  const six = [row, row, row, row, row, row]
  expect(parseLeaderboard({ marathon: [], wins: [], bot: { easy: [row, { login: 'x' }, { login: 'a b', ms: 1, at: 1 }], medium: 'junk', hard: six } })).toEqual({
    marathon: [],
    wins: [],
    bot: { easy: [row], medium: [], hard: six.slice(0, 5) },
  })
  expect(parseLeaderboard({ marathon: [], wins: [], bot: 'junk' })?.bot).toEqual({ easy: [], medium: [], hard: [] })
})

test('parseClientMsg: bot carries a known level and a nonce', () => {
  expect(parseClientMsg({ type: 'menu', choice: 'bot', level: 'hard', nonce: 4 })).toEqual({ type: 'menu', choice: 'bot', level: 'hard', nonce: 4 })
  expect(parseClientMsg({ type: 'menu', choice: 'bot', level: 'nightmare', nonce: 4 })).toBe(null)
  expect(parseClientMsg({ type: 'menu', choice: 'bot', level: 'easy' })).toBe(null)
  expect(parseClientMsg({ type: 'menu', choice: 'bot', level: 'easy', nonce: -1 })).toBe(null)
})

test('parseClientMsg: bot log chunks are accepted like the others', () => {
  const ok = { type: 'log', kind: 'bot', key: 'b1', steps: 10, inputsLen: 4, total: 4, at: 0, values: [0, 1, 3, 5] }
  expect(parseClientMsg(ok)).toEqual(ok)
})
