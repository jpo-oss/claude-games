import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

const PANE = {
  title: 'Block Battle',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const target = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'block-battle', surface, component: 'Pane', props: PANE, requestId: 'block-battle', viewport: { columns: 100, rows: 40 } }) as const

type Ui = Mounted<'terminal' | 'desktop', 'Pane'>

const shown = async (ui: Ui) => JSON.stringify(await ui.drawn({ in: 'game' }))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the menu draws on ${surface}`, async ($: Engine) => {
    const ui = await $.ui.mount(target(surface))
    const text = await shown(ui)
    for (const word of ['Play while Claude works', 'Marathon', 'Battle', 'Leaderboard', 'click here to activate panel']) expect(text).toContain(word)
    // The title must be there in some form: block letters in the big layout, plain text otherwise.
    expect(text.includes('BLOCK BATTLE') || text.includes('█')).toBe(true)
    const client = await ui.find({ type: 'Client' })
    // Sized from the pane (bodyColumns 100, bodyRows 30 above), written out on purpose: unsized, the
    // region shrinks to what the module draws and a "too small" note keeps it too small.
    expect(client?.props.width).toBe(100)
    expect(client?.props.height).toBe(30)
  })
}

async function labelled(ui: Ui, word: string): Promise<string> {
  return (await ui.find({ type: 'Text', text: new RegExp(word), in: 'game' }))?.text ?? ''
}
// The first number-only Text of the side panel is the score value.
const score = async (ui: Ui) => Number((await ui.find({ type: 'Text', text: /^\d+$/, in: 'game' }))?.text ?? NaN)

test('a hard drop changes the field and scores', async ($: Engine, on: On) => {
  store(on)
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await ui.advance(32)
  const before = await shown(ui)
  expect(await score(ui)).toBe(0)
  await ui.key({ key: ' ' })
  await ui.advance(32)
  expect(await shown(ui)).not.toBe(before)
  expect(await score(ui)).toBeGreaterThan(0)
})

const EMPTY_BOARD = '.'.repeat(200)
const EMPTY_LEADERBOARD = { marathon: [], wins: [] }
const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

type Seen = { method: string; url: string; auth: string; body: unknown }

// The test engine keeps no store, so the plugin's store calls are answered from a Map.
function store(on: On, init: Record<string, unknown> = {}): Map<string, unknown> {
  const m = new Map(Object.entries(init))
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }))
  on('store.set', async (_$, e) => {
    m.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    m.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...m.keys()] }))

  return m
}

const SIGNED_IN = { 'session:https://games.jpoapps.com': { session: 'sess_1', login: 'alice' } }

function serve(on: On, route: (req: Seen) => { status: number; body: unknown }, saved: Record<string, unknown> = SIGNED_IN): Seen[] {
  const seen: Seen[] = []
  store(on, saved)
  on('http.fetch', async (_$, e) => {
    const { pathname } = new URL(e.url)
    const req: Seen = {
      method: e.init?.method ?? 'GET',
      url: e.url,
      auth: e.init?.headers?.Authorization ?? '',
      body: e.init?.body ? JSON.parse(e.init.body) : undefined,
    }
    seen.push(req)
    const out = route({ ...req, url: pathname })

    return { value: reply(out.body, out.status) }
  })

  return seen
}

const OPPONENT = { login: 'bob', snapshot: EMPTY_BOARD, isOver: false }

test('battle: each incoming attack is applied once, however often the server repeats it', async ($: Engine, on: On) => {
  mock.clock(on)
  let syncs = 0
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob', avatar: 'x' } } }
    syncs++
    // sync 1 delivers attack 7 (3 lines); every later reply repeats it; sync 4 adds attack 8 (2 lines)
    const incoming = syncs >= 4 ? [{ id: 7, lines: 3 }, { id: 8, lines: 2 }] : [{ id: 7, lines: 3 }]

    return { status: 200, body: { opponent: OPPONENT, incoming } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 6; i++) await ui.advance(200)

  expect(seen[0]).toEqual({ method: 'POST', url: 'https://games.jpoapps.com/v1/battle/queue', auth: 'Bearer sess_1', body: undefined })
  const sync = seen.filter(r => r.url.endsWith('/sync'))
  expect(sync.length).toBeGreaterThanOrEqual(4)
  expect(sync[0]).toEqual({
    method: 'POST',
    url: 'https://games.jpoapps.com/v1/battle/r1/sync',
    auth: 'Bearer sess_1',
    body: { seq: 1, attacks: [], snapshot: expect.stringMatching(/^[.IOTSZJL]{200}$/), isOver: false },
  })
  expect(sync.map(r => (r.body as { seq: number }).seq).slice(0, 4)).toEqual([1, 2, 3, 4])
  expect((await labelled(ui, 'INCOMING')).trim()).toBe('INCOMING 5')
  expect(await labelled(ui, 'bob')).toContain('bob')
  expect(JSON.stringify(await ui.drawn())).not.toContain('sess_1')
  expect(JSON.stringify(seen.map(r => [r.url, r.body]))).not.toContain('sess_1')
})

test('the leaderboard degrades to a short message when the server is down', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => {
    throw new Error('connection refused')
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(await shown(ui)).toContain('Game server unreachable. Solo play still works.')
})

test('an outdated game tells the player how to update', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => ({ status: 426, body: { error: 'protocol 1 is no longer supported' } }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(await shown(ui)).toContain('claude plugin update block-battle@claude-games')
})

test('the leaderboard shows both columns and marks your own row', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => ({
    status: 200,
    body: {
      marathon: [{ login: 'bob', score: 9000, lines: 40, level: 5, at: 1 }, { login: 'alice', score: 4000, lines: 20, level: 3, at: 2 }],
      wins: [{ login: 'alice', wins: 3 }],
    },
  }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  const text = await shown(ui)
  expect(text).toContain('Marathon top 5')
  expect(text).toContain('Battle wins top 5')
  expect(await labelled(ui, '1\\s+bob')).toMatch(/^\s*1\s+bob\s+9000\s*$/)
  const mine = await ui.find({ type: 'Text', text: /2\s+alice/, in: 'game' })
  expect(mine?.props.inverse).toBe(true)
  expect((await ui.find({ type: 'Text', text: /1\s+bob/, in: 'game' }))?.props.inverse).toBe(false)
})

// What the engine does beneath the plugins in a session, as far as the nudge cares.
function onTurn(on: On) {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
}

// The nudge: one toast per turn that runs two minutes, none over a question dialog.
const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('long-turn nudge: one toast per turn, re-armed by the next turn', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  onTurn(on)
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })
  await clock.advance(119_000)
  expect(toasts).toEqual([])
  await clock.advance(2_000)
  expect(toasts).toEqual(['Long task. /cg-block-battle while you wait?'])
  await $.prompt.submit({ text: 'queued mid turn', wait: false, origin: { kind: 'composer' } })
  await clock.advance(300_000)
  expect(toasts).toHaveLength(1)
  await $.turn.complete(TURN)
  await $.prompt.submit({ text: 'second', wait: false, origin: { kind: 'composer' } })
  await clock.advance(121_000)
  expect(toasts).toHaveLength(2)
})

test('long-turn nudge: a turn that ends in time shows nothing', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  onTurn(on)
  await $.prompt.submit({ text: 'quick', wait: false, origin: { kind: 'composer' } })
  await clock.advance(60_000)
  await $.turn.complete(TURN)
  await clock.advance(600_000)
  expect(toasts).toEqual([])
})

test('long-turn nudge: waits while a question dialog is up', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  onTurn(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await clock.sleep(200_000)

    return { result: 'answered' as never, text: 'answered', isReadOnly: true }
  })
  await $.prompt.submit({ text: 'ask me', wait: false, origin: { kind: 'composer' } })
  const asking = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(130_000)
  expect(toasts).toEqual([])
  await clock.advance(80_000)
  await asking
  await clock.advance(20_000)
  expect(toasts).toEqual(['Long task. /cg-block-battle while you wait?'])
})

const RANKED = (req: Seen) => {
  if (req.url === '/v1/marathon') return { status: 200, body: { gameId: 'g1', seed: 77 } }
  return { status: 200, body: EMPTY_LEADERBOARD }
}

async function topOut(ui: Ui) {
  for (let i = 0; i < 40; i++) {
    await ui.key({ key: ' ' })
    await ui.advance(16)
  }
  for (let i = 0; i < 6; i++) await ui.advance(200)
}

test('a ranked marathon sends its log once at game over', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, RANKED)
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await topOut(ui)
  const posts = seen.filter(r => r.url.endsWith('/v1/scores'))
  expect(posts).toHaveLength(1)
  const body = posts[0]!.body as { gameId: string; log: { steps: number; inputs: number[] } }
  expect(body.gameId).toBe('g1')
  expect(body.log.steps).toBeGreaterThan(0)
  expect(body.log.inputs.length % 2).toBe(0)
  // the hard drops pressed are in the log as code 5
  expect(body.log.inputs.filter((v, i) => i % 2 === 1 && v === 5).length).toBeGreaterThan(5)
  expect(await shown(ui)).toContain('GAME OVER')
})

test('quitting a ranked marathon still sends the game', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, RANKED)
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await ui.key({ key: 'left' })
  await ui.advance(200)
  await ui.key({ key: 'q' })
  for (let i = 0; i < 5; i++) await ui.advance(48)
  expect(seen.filter(r => r.url.endsWith('/v1/scores'))).toHaveLength(1)
})

test('an unranked marathon says so and sends nothing', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => (req.url === '/v1/marathon' ? { status: 429, body: { error: 'too many open games' } } : { status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await topOut(ui)
  expect(seen.filter(r => r.url.endsWith('/v1/scores'))).toHaveLength(0)
  expect(await shown(ui)).toContain('unranked')
})

test('marathon starts unranked within 3 s when the server never answers', async ($: Engine, on: On) => {
  mock.clock(on)
  store(on, SIGNED_IN)
  // Held until the end, so the hooks finish before the test's environment goes away.
  let release = () => undefined as void
  on('http.fetch', async () => new Promise(r => (release = () => r({ value: reply({}, 503) }))))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  expect(await shown(ui)).toContain('Starting')
  for (let i = 0; i < 16; i++) await ui.advance(200)
  await ui.key({ key: ' ' })
  await ui.advance(48)
  expect(await score(ui)).toBeGreaterThan(0)
  release()
  await ui.advance(48)
})

test('a log larger than one post arrives whole', { timeoutMs: 60_000 }, async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, RANKED)
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await ui.advance(16)
  // 5,001 presses log 10,002 values: two chunks
  for (let i = 0; i < 5_001; i++) await ui.key({ key: i % 2 ? 'left' : 'right' })
  await ui.advance(16)
  await ui.key({ key: 'q' })
  for (let i = 0; i < 20; i++) await ui.advance(48)
  const posts = seen.filter(r => r.url.endsWith('/v1/scores'))
  expect(posts).toHaveLength(1)
  expect((posts[0]!.body as { log: { inputs: number[] } }).log.inputs.length).toBe(10_002)
})

test('battle: every applied attack is logged once and the log goes out after the result', async ($: Engine, on: On) => {
  mock.clock(on)
  let syncs = 0
  let hasResult = false
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    if (req.url === '/v1/battle/r1/log') return hasResult ? { status: 204, body: {} } : { status: 409, body: { error: 'no result yet' } }
    syncs++
    const incoming = syncs >= 2 ? [{ id: 7, lines: 3 }, { id: 8, lines: 2 }] : [{ id: 7, lines: 3 }]
    if (syncs >= 6) hasResult = true
    return { status: 200, body: { opponent: OPPONENT, incoming, ...(hasResult ? { result: { winner: 'alice' } } : {}) } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  for (let i = 0; i < 20; i++) await ui.advance(200)
  const logs = seen.filter(r => r.url.endsWith('/v1/battle/r1/log'))
  expect(logs).toHaveLength(1)
  const garbage = (logs[0]!.body as { log: { garbage: number[] } }).log.garbage
  expect(garbage.filter((_, i) => i % 2 === 1)).toEqual([7, 8])
})

test('battle: garbage that arrives after topping out is neither applied nor logged', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  let sawOver = false
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    if (req.url === '/v1/battle/r1/log') return { status: 204, body: {} }
    const over = (req.body as { isOver: boolean }).isOver
    if (!over) return { status: 200, body: { opponent: OPPONENT, incoming: [] } }
    if (!sawOver) {
      sawOver = true
      return { status: 200, body: { opponent: OPPONENT, incoming: [{ id: 9, lines: 4 }] } }
    }
    return { status: 200, body: { opponent: OPPONENT, incoming: [{ id: 9, lines: 4 }], result: { winner: 'bob' } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await topOut(ui)
  for (let i = 0; i < 20; i++) {
    await clock.advance(250)
    await ui.advance(200)
  }
  const logs = seen.filter(r => r.url.endsWith('/v1/battle/r1/log'))
  expect(logs).toHaveLength(1)
  const garbage = (logs[0]!.body as { log: { garbage?: number[] } }).log.garbage ?? []
  expect(garbage.filter((_, i) => i % 2 === 1)).not.toContain(9)
})

test('battle: a failed queue poll takes the player off the server queue before it stops', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  let polls = 0
  const seen = serve(on, req => {
    if (req.method === 'DELETE') return { status: 200, body: {} }
    polls++

    return polls === 1 ? { status: 200, body: { status: 'waiting' } } : { status: 500, body: { error: 'boom' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  await clock.advance(1_600)
  await clock.advance(1_600)
  const queue = seen.filter(r => r.url.endsWith('/v1/battle/queue')).map(r => r.method)
  expect(queue).toEqual(['POST', 'POST', 'DELETE'])
})

test('battle: a 401 during sync ends the match once and does not retry with the rejected token', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob', avatar: 'x' } } }

    return { status: 401, body: { error: 'bad token' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 10; i++) await ui.advance(200)
  expect(seen.filter(r => r.url.endsWith('/sync'))).toHaveLength(1)
})

test('after game over and the settled animation, r still restarts', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => ({ status: 200, body: { marathon: [], wins: [] } }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(100)
  for (let i = 0; i < 40; i++) {
    await ui.key({ key: ' ' })
    await ui.advance(16)
  }
  await ui.advance(5_000)
  expect(await shown(ui)).toContain('GAME OVER')
  await ui.key({ key: 'r' })
  await ui.advance(100)
  await ui.advance(32)
  expect(await shown(ui)).not.toContain('GAME OVER')
})

const chunk = (key: string, kind: 'marathon' | 'battle', values: number[], inputsLen = values.length, steps = 50) =>
  ({ type: 'log', kind, key, steps, inputsLen, total: values.length, at: 0, values })

const props = async (ui: Ui) => (await ui.find({ type: 'Client' }))?.props.props as Record<string, unknown>

test('marathon start asks the server for a game when signed in', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => (req.url === '/v1/marathon' ? { status: 200, body: { gameId: 'g1', seed: 77 } } : { status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 1 })
  await ui.advance(48)
  expect(seen.filter(r => r.url.endsWith('/v1/marathon'))).toHaveLength(1)
  expect((await props(ui)).marathon).toEqual({ nonce: 1, gameId: 'g1', seed: 77 })
})

test('marathon start signed out sends nothing and answers unranked', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => ({ status: 200, body: EMPTY_LEADERBOARD }), {})
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 2 })
  await ui.advance(48)
  expect(seen).toHaveLength(0)
  expect((await props(ui)).marathon).toEqual({ nonce: 2, gameId: null, seed: 0 })
})

test('a 429 on marathon start answers unranked', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => (req.url === '/v1/marathon' ? { status: 429, body: { error: 'too many open games' } } : { status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 3 })
  await ui.advance(48)
  expect((await props(ui)).marathon).toMatchObject({ nonce: 3, gameId: null })
})

test('a finished marathon log is sent once, retried on 503 with the same body', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  let scores = 0
  const seen = serve(on, req => {
    if (req.url === '/v1/marathon') return { status: 200, body: { gameId: 'g1', seed: 77 } }
    if (req.url === '/v1/scores') return ++scores === 1 ? { status: 503, body: { error: 'try again later' } } : { status: 200, body: EMPTY_LEADERBOARD }
    return { status: 200, body: EMPTY_LEADERBOARD }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 1 })
  await ui.advance(48)
  await ui.post(chunk('g1', 'marathon', [3, 5, 10, 0]))
  await ui.advance(48)
  await ui.post(chunk('g1', 'marathon', [3, 5, 10, 0]))
  await clock.advance(6_000)
  await ui.advance(48)
  const posts = seen.filter(r => r.url.endsWith('/v1/scores'))
  expect(posts).toHaveLength(2)
  expect(posts[0]!.body).toEqual({ gameId: 'g1', log: { steps: 50, inputs: [3, 5, 10, 0] } })
  expect(posts[1]!.body).toEqual(posts[0]!.body)
  expect((await props(ui)).uploaded).toEqual({ key: 'g1', have: 4 })
})

test('a 422 on a marathon log is not retried', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const seen = serve(on, req => {
    if (req.url === '/v1/marathon') return { status: 200, body: { gameId: 'g1', seed: 77 } }
    if (req.url === '/v1/scores') return { status: 422, body: { error: 'faster than real time' } }
    return { status: 200, body: EMPTY_LEADERBOARD }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 1 })
  await ui.advance(48)
  await ui.post(chunk('g1', 'marathon', [3, 5]))
  await clock.advance(20_000)
  expect(seen.filter(r => r.url.endsWith('/v1/scores'))).toHaveLength(1)
})

test('a log for a game this session never started is dropped', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => ({ status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.post(chunk('stranger', 'marathon', [3, 5]))
  await ui.advance(16)
  await ui.post(chunk('r9', 'battle', [3, 5]))
  await ui.advance(48)
  expect(seen.filter(r => r.url.endsWith('/v1/scores') || r.url.endsWith('/log'))).toHaveLength(0)
})

test('a battle log goes to the room after the result', async ($: Engine, on: On) => {
  mock.clock(on)
  let hasResult = false
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    if (req.url === '/v1/battle/r1/log') return hasResult ? { status: 204, body: {} } : { status: 409, body: { error: 'no result yet' } }
    hasResult = true
    return { status: 200, body: { opponent: OPPONENT, incoming: [], result: { winner: 'alice' } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  for (let i = 0; i < 6; i++) await ui.advance(200)
  await ui.post(chunk('r1', 'battle', [4, 5, 0, 7], 2))
  for (let i = 0; i < 6; i++) await ui.advance(48)
  const logs = seen.filter(r => r.url.endsWith('/v1/battle/r1/log'))
  expect(logs).toHaveLength(1)
  const log = (logs[0]!.body as { log: { steps: number; inputs: number[] } }).log
  expect(log.steps).toBeGreaterThanOrEqual(1)
  expect(log.inputs.length % 2).toBe(0)
})

test('a 404 on sync ends the match with a reason', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 404, body: { error: 'no such room' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  for (let i = 0; i < 10; i++) await ui.advance(200)
  expect(seen.filter(r => r.url.endsWith('/sync'))).toHaveLength(1)
  expect(seen.filter(r => r.method === 'DELETE')).toHaveLength(0)
  expect(await shown(ui)).toContain('The match is no longer available.')
})

test('a result with no winner ends the match', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 200, body: { opponent: OPPONENT, incoming: [], result: { winner: null } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  for (let i = 0; i < 6; i++) await ui.advance(200)
  expect(await shown(ui)).toContain('The match ended with no result.')
})

test('isOver posted while a sync is in flight is sent when that sync returns', async ($: Engine, on: On) => {
  mock.clock(on)
  let release: () => void = () => undefined
  const syncs: { isOver: boolean }[] = []
  store(on, SIGNED_IN)
  on('http.fetch', async (_$, e) => {
    const path = new URL(e.url).pathname
    if (path === '/v1/battle/queue') return { value: reply({ status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } }) }
    const body = JSON.parse(e.init!.body!)
    syncs.push(body)
    if (syncs.length === 1) await new Promise<void>(r => (release = r))
    return { value: reply({ opponent: OPPONENT, incoming: [], ...(body.isOver ? { result: { winner: 'bob' } } : {}) }) }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.post({ type: 'sync', seq: 1, attacks: [], snapshot: EMPTY_BOARD, isOver: false })
  await ui.advance(16)
  await ui.post({ type: 'sync', seq: 2, attacks: [], snapshot: EMPTY_BOARD, isOver: true })
  await ui.advance(16)
  release()
  for (let i = 0; i < 5; i++) await ui.advance(48)
  expect(syncs.some(s => s.isOver)).toBe(true)
})

const DEVICE = { device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }

function github(
  on: On,
  polls: unknown[],
  server: (req: Seen) => { status: number; body: unknown },
  saved: Record<string, unknown> = {},
  config: unknown = { githubClientId: 'Iv1.test' },
) {
  const queue = [...polls]
  const seen: Seen[] = []
  const saves = store(on, saved)
  on('http.fetch', async (_$, e) => {
    const req: Seen = { method: e.init?.method ?? 'GET', url: e.url, auth: e.init?.headers?.Authorization ?? '', body: e.init?.body }
    seen.push(req)
    if (e.url === 'https://github.com/login/device/code') return { value: reply(DEVICE) }
    if (e.url === 'https://github.com/login/oauth/access_token') return { value: reply(queue.shift() ?? { error: 'authorization_pending' }) }
    if (new URL(e.url).pathname === '/v1/config') return { value: reply(config) }
    const out = server({ ...req, url: new URL(e.url).pathname, body: e.init?.body ? JSON.parse(e.init.body) : undefined })

    return { value: reply(out.body, out.status) }
  })

  return { seen, saves }
}

async function openLeaderboard(ui: Ui) {
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
}

test('choosing Leaderboard while signed out shows the GitHub code, then signs in', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const { seen, saves } = github(on, [{ error: 'authorization_pending' }, { access_token: 'gho_secret', scope: '' }], req =>
    req.url === '/v1/session' ? { status: 200, body: { session: 'sess_9', login: 'carol' } } : { status: 200, body: EMPTY_LEADERBOARD },
  )
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain('WDJB-MJHT')
  expect(await shown(ui)).toContain('github.com/login/device')
  await clock.advance(5_000)
  await clock.advance(5_000)
  await ui.advance(48)

  const device = seen.find(r => r.url === 'https://github.com/login/device/code')!
  expect(new URLSearchParams(device.body as string).get('client_id')).toBe('Iv1.test')
  const session = seen.find(r => r.url.endsWith('/v1/session'))!
  expect(session.auth).toBe('')
  expect(saves.get('session:https://games.jpoapps.com')).toEqual({ session: 'sess_9', login: 'carol' })
  expect(JSON.stringify([...saves])).not.toContain('gho_secret')
  expect(await shown(ui)).toContain('Marathon top 5')
  expect(await shown(ui)).not.toContain('gho_secret')
  expect(seen.filter(r => r.url.includes('/v1/') && !r.url.endsWith('/v1/session') && !r.url.endsWith('/v1/config')).every(r => r.auth === 'Bearer sess_9')).toBe(true)
})

test('a denied code says so and can be retried', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  github(on, [{ error: 'access_denied' }], () => ({ status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  await clock.advance(5_000)
  await ui.advance(48)
  expect(await shown(ui)).toContain('Sign-in was cancelled')
})

test('GitHub being down leaves solo play alone', async ($: Engine, on: On) => {
  mock.clock(on)
  store(on)
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/v1/config')) return { value: reply({ githubClientId: 'Iv1.test' }) }
    throw new Error('offline')
  })
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain("Couldn't reach GitHub")
})

test('a 401 forgets the stored session', async ($: Engine, on: On) => {
  mock.clock(on)
  const { saves } = github(on, [], () => ({ status: 401, body: { error: 'unknown session' } }), SIGNED_IN)
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(saves.has('session:https://games.jpoapps.com')).toBe(false)
})

test('a session for one server is not sent to another', async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 200, body: EMPTY_LEADERBOARD }), { 'session:https://other.example': { session: 'other_sess', login: 'alice' } })
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(seen.some(r => r.auth.includes('other_sess'))).toBe(false)
})

test('a denied code can be retried by picking Leaderboard again', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const { seen } = github(on, [{ error: 'access_denied' }], () => ({ status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  await clock.advance(5_000)
  await ui.advance(48)
  await ui.key({ key: 'q' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(seen.filter(r => r.url === 'https://github.com/login/device/code')).toHaveLength(2)
  expect(await shown(ui)).toContain('WDJB-MJHT')
})

test('after a 401 the player is told and picking again starts sign-in', async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 401, body: { error: 'unknown session' } }), SIGNED_IN)
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain('Signed out')
  await ui.key({ key: 'r' })
  await ui.advance(48)
  await ui.advance(48)
  expect(seen.some(r => r.url === 'https://github.com/login/device/code')).toBe(true)
  expect(await shown(ui)).toContain('WDJB-MJHT')
})

test('the code stays visible when the player moves from Leaderboard to Battle', async ($: Engine, on: On) => {
  mock.clock(on)
  github(on, [], () => ({ status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain('WDJB-MJHT')
  await ui.key({ key: 'q' })
  await ui.key({ key: 'up' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(await shown(ui)).toContain('WDJB-MJHT')
})

test('a session saved for another server is ignored after switching servers', { options: { serverUrl: 'https://other.example/' } }, async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 200, body: EMPTY_LEADERBOARD }), SIGNED_IN)
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(seen.some(r => r.auth === 'Bearer sess_1')).toBe(false)
  expect(seen.some(r => r.url === 'https://github.com/login/device/code')).toBe(true)
})

test('an http server address is refused before any request', { options: { serverUrl: 'http://example.com' } }, async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 200, body: EMPTY_LEADERBOARD }), SIGNED_IN)
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(seen).toHaveLength(0)
  expect(await shown(ui)).toContain('must start with https://')
})

test('a winner who is neither player is not shown as a win', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 200, body: { opponent: OPPONENT, incoming: [], result: { winner: 'mallory' } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 6; i++) await ui.advance(200)
  expect(await shown(ui)).not.toContain('YOU WIN')
})

test('a battle the player really won shows a win', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 200, body: { opponent: OPPONENT, incoming: [], result: { winner: 'alice' } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 6; i++) await ui.advance(200)
  expect(await shown(ui)).toContain('YOU WIN')
})

test('a server with no sign-in app says so', async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 200, body: EMPTY_LEADERBOARD }), {}, {})
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain("isn't set up for sign-in")
  expect(seen.some(r => r.url.startsWith('https://github.com/'))).toBe(false)
})

test('/cg-block-battle signout revokes the session and forgets it', async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen, saves } = github(on, [], () => ({ status: 204, body: {} }), SIGNED_IN)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const ran = await $.command.run({ command: 'cg-block-battle', args: 'signout' })
  expect(JSON.stringify(ran)).toContain('Signed out')
  expect(seen.find(r => r.url.endsWith('/v1/session'))).toMatchObject({ method: 'DELETE', auth: 'Bearer sess_1' })
  expect(saves.has('session:https://games.jpoapps.com')).toBe(false)
})

test('signing out with no session still answers', async ($: Engine, on: On) => {
  mock.clock(on)
  const { seen } = github(on, [], () => ({ status: 204, body: {} }))
  const ran = await $.command.run({ command: 'cg-block-battle', args: 'signout' })
  expect(JSON.stringify(ran)).toContain('Not signed in')
  expect(seen).toHaveLength(0)
})

async function startBattle(ui: Ui) {
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
}

test('a battle whose server stops answering goes back to the lobby and says so', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  on('http.fetch', async (_$, e) => {
    if (new URL(e.url).pathname === '/v1/battle/queue') return { value: reply({ status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } }) }
    return new Promise(() => undefined)
  })
  const ui = await $.ui.mount(target('terminal'))
  await startBattle(ui)
  for (let i = 0; i < 4; i++) await ui.advance(200)
  await clock.advance(31_000)
  for (let i = 0; i < 4; i++) await ui.advance(200)
  expect(await shown(ui)).toContain('Game server unreachable')
})

test('a battle that ends with no winner goes back to the lobby', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 200, body: { opponent: OPPONENT, incoming: [], result: { winner: 'mallory' } } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await startBattle(ui)
  for (let i = 0; i < 6; i++) await ui.advance(200)
  expect(await shown(ui)).toContain('The match ended with no result')
})

test('a match the server drops goes back to the lobby with the reason', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 404, body: { error: 'no such room' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await startBattle(ui)
  for (let i = 0; i < 6; i++) await ui.advance(200)
  expect(await shown(ui)).toContain('The match is no longer available')
})

async function openPicker(ui: Ui) {
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
}

async function typeText(ui: Ui, text: string) {
  for (const c of text) await ui.key({ key: c })
}

const ACME = 'https://games.acme.dev'
const BOTH = { ...SIGNED_IN, ['session:' + ACME]: { session: 'acme_sess', login: 'alice' } }
const MATCH = { status: 200, body: { status: 'waiting' } }

test('choosing Battle asks where to play', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => MATCH)
  const ui = await $.ui.mount(target('terminal'))
  await openPicker(ui)
  expect(await shown(ui)).toContain('Official server')
  expect(await shown(ui)).toContain('Enter a server address')
})

test('the official server is the first choice', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => MATCH)
  const ui = await $.ui.mount(target('terminal'))
  await openPicker(ui)
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(seen.find(r => r.url.endsWith('/v1/battle/queue'))?.url).toBe('https://games.jpoapps.com/v1/battle/queue')
})

test('a typed address is used, with only that server\'s session', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => MATCH, BOTH)
  const ui = await $.ui.mount(target('terminal'))
  await openPicker(ui)
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await typeText(ui, ACME)
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  const queue = seen.filter(r => r.url.endsWith('/v1/battle/queue'))
  expect(queue[0]).toMatchObject({ url: ACME + '/v1/battle/queue', auth: 'Bearer acme_sess' })
  expect(seen.some(r => r.auth === 'Bearer sess_1')).toBe(false)
})

test('an unencrypted address is refused and nothing is sent', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => MATCH)
  const ui = await $.ui.mount(target('terminal'))
  await openPicker(ui)
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await typeText(ui, 'http://evil.example')
  await ui.key({ key: 'return' })
  await ui.advance(48)
  expect(await shown(ui)).toContain('must start with https://')
  expect(seen).toHaveLength(0)
})

test('the last typed address is offered next time', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => MATCH, { ...BOTH, lastServer: ACME })
  const ui = await $.ui.mount(target('terminal'))
  await ui.advance(48)
  await openPicker(ui)
  expect(await shown(ui)).toContain('games.acme.dev')
})

test('a community server warns before sign-in', async ($: Engine, on: On) => {
  mock.clock(on)
  github(on, [], () => MATCH)
  const ui = await $.ui.mount(target('terminal'))
  await openPicker(ui)
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await typeText(ui, ACME)
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(await shown(ui)).toContain('run by someone else')
  expect(await shown(ui)).toContain('WDJB-MJHT')
})

test('the leaderboard names the server it comes from', async ($: Engine, on: On) => {
  mock.clock(on)
  serve(on, () => ({ status: 200, body: EMPTY_LEADERBOARD }))
  const ui = await $.ui.mount(target('terminal'))
  await openLeaderboard(ui)
  expect(await shown(ui)).toContain('games.jpoapps.com')
})

test('a topped-out player whose syncs keep failing is taken out of the match', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 500, body: { error: 'boom' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.post({ type: 'sync', seq: 1, attacks: [], snapshot: EMPTY_BOARD, isOver: true })
  await clock.advance(32_000)
  await ui.advance(48)
  const syncs = () => seen.filter(r => r.url.endsWith('/sync')).length
  const after = syncs()
  expect(after).toBeGreaterThan(1)
  expect(await shown(ui)).toContain('Game server unreachable')
  await clock.advance(10_000)
  expect(syncs()).toBe(after)
})

test('Enter on the Starting screen does not cancel the game it asked for; q does', async ($: Engine, on: On) => {
  mock.clock(on)
  store(on, SIGNED_IN)
  let release = () => undefined as void
  on('http.fetch', async () => new Promise(r => (release = () => r({ value: reply({ gameId: 'g1', seed: 77 }) }))))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  expect(await shown(ui)).toContain('Starting')
  await ui.key({ key: 'q' })
  await ui.advance(48)
  expect(await shown(ui)).toContain('Play while Claude works')
  release()
  await ui.advance(48)
})

test('battle: the top-out is posted again until the result comes', async ($: Engine, on: On) => {
  // The hooks' own retry timer only runs on the mock clock, which stays put: every isOver sync here comes from a Client post.
  mock.clock(on)
  let hasResult = false
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob' } } }
    return { status: 200, body: { opponent: OPPONENT, incoming: [], ...(hasResult ? { result: { winner: 'bob' } } : {}) } }
  })
  const overs = () => seen.filter(r => (r.body as { isOver?: boolean } | undefined)?.isOver === true).length
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.key({ key: 'return' })
  await ui.advance(100)
  await topOut(ui)
  const first = overs()
  expect(first).toBeGreaterThan(0)
  for (let i = 0; i < 5; i++) await ui.advance(200)
  expect(overs()).toBeGreaterThanOrEqual(first + 4)
  hasResult = true
  for (let i = 0; i < 3; i++) await ui.advance(200)
  const settled = overs()
  for (let i = 0; i < 5; i++) await ui.advance(200)
  expect(overs()).toBe(settled)
})

test('a log goes to the server that started the game, with that server\'s session', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => (req.url === '/v1/marathon' ? { status: 200, body: { gameId: 'g1', seed: 77 } } : req.url === '/v1/battle/queue' ? MATCH : { status: 200, body: EMPTY_LEADERBOARD }), BOTH)
  const ui = await $.ui.mount(target('terminal'))
  await ui.post({ type: 'menu', choice: 'marathon', nonce: 1 })
  await ui.advance(48)
  await ui.post({ type: 'menu', choice: 'battle', server: ACME })
  await ui.advance(48)
  await ui.post(chunk('g1', 'marathon', [3, 5]))
  await ui.advance(48)
  const scores = seen.filter(r => r.url.endsWith('/v1/scores'))
  expect(scores).toHaveLength(1)
  expect(scores[0]).toMatchObject({ url: 'https://games.jpoapps.com/v1/scores', auth: 'Bearer sess_1' })
})
