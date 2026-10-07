import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'

import { shareText } from '../hooks/text'
import type { View } from '../types'
import { reply, server, store } from './fake'

const SIGNED_IN = { 'session:https://games.jpoapps.com': { session: 's', login: 'alice' } }

const puzzle = (number: number) => reply({ number, day: '2026-10-07', endsAt: 1, guesses: [], state: 'playing', answer: null })

const PANE = { title: 'Daily Diff', isFocused: true, bodyColumns: 60, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const target = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'daily-diff', surface, component: 'Pane', props: PANE, requestId: 'daily-diff', viewport: { columns: 100, rows: 50 } }) as const

type Ui = Mounted<'terminal' | 'desktop', 'Pane'>

const run = (args = '') => ({ command: 'cg-daily-diff', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

// What the hooks hand the Client is the whole view.
const viewOf = async (ui: Ui) => (await ui.find({ type: 'Client' }))?.props.props as View

async function start($: Engine, on: On, clock: MockClock) {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  const ran = await $.command.run(run())
  const ui = await $.ui.mount(target('terminal'))
  await clock.settle()

  return { ui, ran }
}

async function open($: Engine, on: On, saved: Record<string, unknown> = SIGNED_IN) {
  const clock = mock.clock(on)
  const saves = store(on, saved)
  const fake = server(on)

  return { clock, saves, ...fake, ...(await start($, on, clock)) }
}

async function say(ui: Ui, clock: MockClock, data: Parameters<Ui['post']>[0]) {
  await ui.post(data)
  await clock.settle()
}

test('opening fetches today with the game, protocol and session headers', async ($: Engine, on: On) => {
  const { seen, ran, ui } = await open($, on)
  expect(JSON.stringify(ran)).toContain('Daily Diff open.')
  expect(seen[0]).toMatchObject({
    method: 'GET',
    url: 'https://games.jpoapps.com/v1/daily-diff/today',
    headers: { 'X-Game': 'daily-diff', 'X-Protocol-Version': '1', Authorization: 'Bearer s' },
  })
  const v = await viewOf(ui)
  expect(v.today?.state).toBe('playing')
  expect(v.me).toBe('alice')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws the game Client sized to the pane on ${surface}`, async ($: Engine, on: On) => {
    mock.clock(on)
    store(on)
    const client = await (await $.ui.mount(target(surface))).find({ type: 'Client' })
    expect(client?.props).toMatchObject({ module: 'hooks/game.tsx', width: 60, height: 40 })
  })
}

test('a guess is trimmed, lowercased and sent with the puzzle number', async ($: Engine, on: On) => {
  const { clock, seen, ui } = await open($, on)
  await say(ui, clock, { type: 'guess', word: ' ZZZZA' })
  expect(seen.find(r => r.url.endsWith('/guess'))?.body).toEqual({ number: 1, word: 'zzzza' })
  const v = await viewOf(ui)
  expect(v.today?.guesses).toHaveLength(1)
  expect(v.isSending).toBe(false)
})

test('a word not in the list is flagged and uses no guess', async ($: Engine, on: On) => {
  const { clock, guesses, ui } = await open($, on)
  await say(ui, clock, { type: 'guess', word: 'zzzzz' })
  const v = await viewOf(ui)
  expect(v.rejected).toBe(1)
  expect(v.notice).toBe('Not in word list')
  expect(guesses).toEqual([])
  expect(v.today?.guesses).toEqual([])
})

test('a guess posted while one is in flight is dropped', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  const sent: unknown[] = []
  on('http.fetch', async (_$, e) => {
    if (!e.url.endsWith('/guess')) return { value: puzzle(1) }
    sent.push(JSON.parse(e.init?.body ?? 'null'))
    await clock.sleep(1_000)
    return { value: reply({ error: 'not in word list' }, 422) }
  })
  const { ui } = await start($, on, clock)
  await say(ui, clock, { type: 'guess', word: 'zzzza' })
  expect((await viewOf(ui)).isSending).toBe(true)
  await say(ui, clock, { type: 'guess', word: 'zzzzb' })
  await clock.advance(1_000)
  expect(sent).toHaveLength(1)
  expect((await viewOf(ui)).isSending).toBe(false)
})

test('winning loads stats and the today board', async ($: Engine, on: On) => {
  const { clock, seen, ui } = await open($, on)
  await say(ui, clock, { type: 'guess', word: 'qqqqa' })
  expect(seen.some(r => r.url.endsWith('/v1/daily-diff/stats'))).toBe(true)
  expect(seen.some(r => r.url.endsWith('/v1/daily-diff/leaderboard/today'))).toBe(true)
  const v = await viewOf(ui)
  expect(v.today?.state).toBe('won')
  expect(v.today?.answer).toBe('qqqqa')
  expect(v.stats?.played).toBe(1)
  expect(v.board?.period).toBe('today')
})

test('a board tab loads that period', async ($: Engine, on: On) => {
  const { clock, ui } = await open($, on)
  await say(ui, clock, { type: 'board', period: 'week' })
  expect((await viewOf(ui)).board?.period).toBe('week')
})

test('share copies only a finished game and reports whether it took', async ($: Engine, on: On) => {
  const copies: string[] = []
  let isCopied = false
  on('ui.copy', async (_$, e) => {
    copies.push(e.text)
    return { value: isCopied ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' } }
  })
  const { clock, ui } = await open($, on)
  await say(ui, clock, { type: 'share' })
  expect(copies).toEqual([])
  expect((await viewOf(ui)).copied).toBeNull()

  await say(ui, clock, { type: 'guess', word: 'qqqqa' })
  await say(ui, clock, { type: 'share' })
  expect((await viewOf(ui)).copied).toBe('failed')
  isCopied = true
  await say(ui, clock, { type: 'share' })
  const v = await viewOf(ui)
  expect(v.copied).toBe('ok')
  expect(copies.at(-1)).toBe(shareText(v.today!))
})

test('signed out, opening shows the GitHub code', async ($: Engine, on: On) => {
  const { seen, ui } = await open($, on, {})
  expect((await viewOf(ui)).notice).toBe('Sign in: open https://github.com/login/device and enter WDJB-MJHT')
  expect(seen.some(r => r.url.includes('/v1/daily-diff/'))).toBe(false)
})

test('a 401 drops the session and starts sign-in', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const saves = store(on, SIGNED_IN)
  on('http.fetch', async (_$, e) => {
    if (e.url === 'https://github.com/login/device/code') return { value: reply({ device_code: 'dc', user_code: 'C0DE', verification_uri: 'https://github.com/login/device' }) }
    if (e.url.endsWith('/v1/config')) return { value: reply({ githubClientId: 'Iv1.test' }) }
    return { value: reply({ error: 'unknown session' }, 401) }
  })
  const { ui } = await start($, on, clock)
  expect(saves.has('session:https://games.jpoapps.com')).toBe(false)
  expect((await viewOf(ui)).notice).toContain('C0DE')
})

const failing = (status: number, error: string) => async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  on('http.fetch', async () => {
    if (status === 0) throw new Error('offline')
    return { value: reply({ error }, status) }
  })
  const { ui } = await start($, on, clock)

  return (await viewOf(ui)).notice
}

test('an unreachable server gets a short notice', async ($: Engine, on: On) => {
  expect(await failing(0, '')($, on)).toBe('Game server unreachable.')
})
test('an outdated plugin says how to update', async ($: Engine, on: On) => {
  expect(await failing(426, 'protocol 1 required')($, on)).toBe(
    'Daily Diff is out of date. Run claude plugin update daily-diff@claude-games in your shell, then /reload-plugins.',
  )
})
test('a server without word files says so', async ($: Engine, on: On) => {
  expect(await failing(503, 'daily diff unavailable')($, on)).toBe('Daily Diff is not available right now.')
})
test('other errors are passed on', async ($: Engine, on: On) => {
  expect(await failing(500, 'boom')($, on)).toBe('Server said: boom')
})

test('a guess for yesterday refreshes and says a new puzzle is out', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  let todays = 0
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/guess')) return { value: reply({ error: 'new puzzle' }, 409) }
    return { value: puzzle(++todays) }
  })
  const { ui } = await start($, on, clock)
  await say(ui, clock, { type: 'guess', word: 'zzzza' })
  const v = await viewOf(ui)
  expect(v.notice).toBe('A new puzzle is out.')
  expect(v.today?.number).toBe(2)
  expect(v.isSending).toBe(false)
})

test('a slow reply from an older refresh does not overwrite a newer one', async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  let todays = 0
  on('http.fetch', async () => {
    const n = ++todays
    if (n === 1) await clock.sleep(1_000)
    return { value: puzzle(n) }
  })
  const { ui } = await start($, on, clock)
  await say(ui, clock, { type: 'retry' })
  expect((await viewOf(ui)).today?.number).toBe(2)
  await clock.advance(1_000)
  expect((await viewOf(ui)).today?.number).toBe(2)
})

test('signout forgets the session', async ($: Engine, on: On) => {
  const { saves } = await open($, on)
  const ran = await $.command.run(run('signout'))
  expect(JSON.stringify(ran)).toContain('Signed out of Daily Diff.')
  expect(saves.has('session:https://games.jpoapps.com')).toBe(false)
  expect(JSON.stringify(await $.command.run(run('signout')))).toContain('Not signed in.')
})
