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

test('a hard drop changes the field and scores', async ($: Engine) => {
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  await ui.advance(32)
  const before = await shown(ui)
  expect(await score(ui)).toBe(0)
  await ui.key({ key: ' ' })
  await ui.advance(32)
  expect(await shown(ui)).not.toBe(before)
  expect(await score(ui)).toBeGreaterThan(0)
})

const EMPTY_BOARD = '.'.repeat(200)
const proc = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

type Seen = { method: string; url: string; auth: string; body: unknown }

function serve(on: On, route: (req: Seen) => { status: number; body: unknown }): Seen[] {
  const seen: Seen[] = []
  on('process.run', async (_$, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'gh auth token') return { value: proc('ghp_secret\n') }
    if (cmd.startsWith('gh api user')) return { value: proc('alice\n') }

    return { value: proc('', 1) }
  })
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
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 6; i++) await ui.advance(200)

  expect(seen[0]).toEqual({ method: 'POST', url: 'https://games.jpoapps.com/v1/battle/queue', auth: 'Bearer ghp_secret', body: undefined })
  const sync = seen.filter(r => r.url.endsWith('/sync'))
  expect(sync.length).toBeGreaterThanOrEqual(4)
  expect(sync[0]).toEqual({
    method: 'POST',
    url: 'https://games.jpoapps.com/v1/battle/r1/sync',
    auth: 'Bearer ghp_secret',
    body: { seq: 1, attacks: [], snapshot: expect.stringMatching(/^[.IOTSZJL]{200}$/), isOver: false },
  })
  expect(sync.map(r => (r.body as { seq: number }).seq).slice(0, 4)).toEqual([1, 2, 3, 4])
  expect((await labelled(ui, 'INCOMING')).trim()).toBe('INCOMING 5')
  expect(await labelled(ui, 'bob')).toContain('bob')
  expect(JSON.stringify(await ui.drawn())).not.toContain('ghp_secret')
  expect(JSON.stringify(seen.map(r => [r.url, r.body]))).not.toContain('ghp_secret')
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
  store(on, SIGNED_IN)
  serve(on, () => ({ status: 426, body: { error: 'protocol 1 is no longer supported' } }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  expect(await shown(ui)).toContain('Run /plugin update block-battle@claude-games')
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
  expect(toasts).toEqual(['Long task. /block-battle while you wait?'])
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
  expect(toasts).toEqual(['Long task. /block-battle while you wait?'])
})

test('marathon game over posts the score once and shows the fill and the label', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, () => ({ status: 200, body: { marathon: [], wins: [] } }))
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'return' })
  for (let i = 0; i < 40; i++) {
    await ui.key({ key: ' ' })
    await ui.advance(16)
  }
  for (let i = 0; i < 6; i++) await ui.advance(200)
  const posts = seen.filter(r => r.url.endsWith('/v1/scores'))
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ method: 'POST', auth: 'Bearer ghp_secret', body: { mode: 'marathon', lines: 0, level: 1 } })
  expect((posts[0]?.body as { score: number }).score).toBeGreaterThan(0)
  expect(await shown(ui)).toContain('GAME OVER')
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
  for (let i = 0; i < 40; i++) {
    await ui.key({ key: ' ' })
    await ui.advance(16)
  }
  await ui.advance(5_000)
  expect(await shown(ui)).toContain('GAME OVER')
  await ui.key({ key: 'r' })
  await ui.advance(32)
  expect(await shown(ui)).not.toContain('GAME OVER')
})

test('battle: a 410 on sync clears the battle, stops syncing and sends no queue delete', async ($: Engine, on: On) => {
  mock.clock(on)
  const seen = serve(on, req => {
    if (req.url === '/v1/battle/queue') return { status: 200, body: { status: 'matched', roomId: 'r1', seed: 42, opponent: { login: 'bob', avatar: 'x' } } }

    return { status: 410, body: { error: 'match cancelled' } }
  })
  const ui = await $.ui.mount(target('terminal'))
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
  for (let i = 0; i < 10; i++) await ui.advance(200)
  expect(seen.filter(r => r.url.endsWith('/sync'))).toHaveLength(1)
  expect(seen.filter(r => r.method === 'DELETE')).toHaveLength(0)
  expect(await shown(ui)).toContain('Match cancelled: your opponent left before it started.')
})
