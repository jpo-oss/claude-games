import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'

import { reply, server, store } from './fake'

const SIGNED_IN = { 'session:https://games.jpoapps.com': { session: 's', login: 'alice' } }
const PANE = { title: 'Daily Diff', isFocused: true, bodyColumns: 60, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const target = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'daily-diff', surface, component: 'Pane', props: PANE, requestId: 'daily-diff', viewport: { columns: 100, rows: 50 } }) as const
const run = { command: 'cg-daily-diff', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

type Ui = Mounted<'terminal' | 'desktop', 'Pane'>

const shown = async (ui: Ui) => JSON.stringify(await ui.drawn({ in: 'game' }))

// Every string under a node, in order: a tile row's letters read as one word.
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const n = node as { children?: unknown; props?: { children?: unknown } }
  const kids = n.children ?? n.props?.children

  return Array.isArray(kids) ? kids.map(textOf).join('') : textOf(kids)
}
const row = async (ui: Ui, i: number) => textOf(await ui.find({ key: `row-${i}`, in: 'game' })).replace(/\s/g, '')
const rowBorder = async (ui: Ui, i: number) => (await ui.find({ key: `row-${i}`, in: 'game' }))?.children.map(c => (c as { props: { borderColor?: string } }).props.borderColor)

const ENDS_AT = Date.UTC(2026, 9, 8)

async function open($: Engine, on: On, surface: 'terminal' | 'desktop', opts: Parameters<typeof server>[1] & { now?: number } = {}) {
  const clock = mock.clock(on, { now: opts.now ?? 0 })
  store(on, SIGNED_IN)
  const fake = server(on, opts)
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await $.command.run(run)
  const ui = await $.ui.mount(target(surface))
  await clock.settle()

  return { clock, ui, ...fake }
}

async function press(ui: Ui, clock: MockClock, ...keys: string[]) {
  for (const key of keys) {
    await ui.key({ key, in: 'game' })
    await clock.settle()
  }
}
const typeWord = (ui: Ui, clock: MockClock, word: string) => press(ui, clock, ...word, 'return')
const short = (ui: Ui) => ui.resize({ columns: 60, rows: 20, in: 'game' })
const player = (rank: number, login: string) => ({ rank, login, points: null, guesses: 3, played: 1, ms: 5000 })
const todayFetches = (seen: { url: string }[]) => seen.filter(r => r.url.endsWith('/v1/daily-diff/today')).length

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the grid and keyboard draw on ${surface}`, async ($: Engine, on: On) => {
    const { ui } = await open($, on, surface)
    const text = await shown(ui)
    expect(text).toContain('DAILY DIFF #1')
    expect(text).toContain('next in')
    for (let i = 0; i < 6; i++) expect(await ui.find({ key: `row-${i}`, in: 'game' })).toBeDefined()
    expect(await ui.find({ key: 'row-6', in: 'game' })).toBeUndefined()
    for (const k of [...'QWERTYUIOPASDFGHJKLZXCVBNM', 'ENTER', 'BACK']) expect(text).toContain(k)
  })

  test(`typing a word and Enter sends one guess on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, guesses, seen } = await open($, on, surface)
    await typeWord(ui, clock, 'zzzza')
    expect(guesses).toEqual(['zzzza'])
    expect(seen.filter(r => r.url.endsWith('/guess'))).toHaveLength(1)
    expect(await row(ui, 0)).toBe('ZZZZA')
    const tile = (await ui.find({ key: 'row-0', in: 'game' }))?.children[4] as { props: { backgroundColor?: string } }
    expect(tile.props.backgroundColor).toBe('#538d4e')
    expect(await row(ui, 1)).toBe('')
  })

  test(`backspace, a sixth letter and a short Enter on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, seen } = await open($, on, surface)
    await press(ui, clock, 'z', 'z', 'x', 'backspace')
    expect(await row(ui, 0)).toBe('ZZ')
    await press(ui, clock, 'z', 'z', 'a', 'b')
    expect(await row(ui, 0)).toBe('ZZZZA')
    await press(ui, clock, 'backspace', 'return')
    expect(await row(ui, 0)).toBe('ZZZZ')
    expect(seen.some(r => r.url.endsWith('/guess'))).toBe(false)
  })

  test(`a word not in the list flashes the row and keeps it editable on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, guesses } = await open($, on, surface)
    await typeWord(ui, clock, 'zzzzz')
    expect(await shown(ui)).toContain('Not in word list')
    expect(await row(ui, 0)).toBe('ZZZZZ')
    expect(await rowBorder(ui, 0)).toEqual(Array(5).fill('red'))
    await ui.advance(700)
    expect(await rowBorder(ui, 0)).not.toContain('red')
    await press(ui, clock, 'backspace', 'a', 'return')
    expect(guesses).toEqual(['zzzza'])
  })

  test(`a win shows the result, stats and today's board on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui } = await open($, on, surface)
    await typeWord(ui, clock, 'zzzza')
    await typeWord(ui, clock, 'qqqqa')
    const text = await shown(ui)
    expect(text).toContain('Solved in 2/6')
    expect(text).toContain('Played 1  Win 100%  Streak 1  Best 1')
    expect(await ui.find({ type: 'Text', text: /alice/, in: 'game' })).toBeDefined()
    expect(text).not.toContain('ENTER')
  })

  test(`right switches the board to Week on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, seen } = await open($, on, surface)
    await typeWord(ui, clock, 'qqqqa')
    await press(ui, clock, 'right')
    expect(seen.some(r => r.url.endsWith('/v1/daily-diff/leaderboard/week'))).toBe(true)
    expect((await ui.find({ type: 'Text', text: ' Week ', in: 'game' }))?.props.inverse).toBe(true)
    expect((await ui.find({ type: 'Text', text: ' Today ', in: 'game' }))?.props.inverse).toBe(false)
  })

  test(`reopening a finished game on another tab shows today's board on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui } = await open($, on, surface)
    await typeWord(ui, clock, 'qqqqa')
    await press(ui, clock, 'right')
    await ui.unmount()
    await $.command.run(run)
    const again = await $.ui.mount(target(surface))
    await clock.settle()
    expect((await again.find({ type: 'Text', text: ' Today ', in: 'game' }))?.props.inverse).toBe(true)
    expect(await again.find({ type: 'Text', text: /alice/, in: 'game' })).toBeDefined()
  })

  test(`share with the copy failing says so on ${surface}`, async ($: Engine, on: On) => {
    on('ui.copy', async () => ({ value: { isCopied: false as const, reason: 'no-clipboard' } }))
    const { clock, ui } = await open($, on, surface)
    await typeWord(ui, clock, 'qqqqa')
    await press(ui, clock, 's')
    expect(await shown(ui)).toContain('Copy failed')
  })

  test(`reopening after a guess shows it on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui } = await open($, on, surface)
    await typeWord(ui, clock, 'zzzza')
    await ui.unmount()
    await $.command.run(run)
    const again = await $.ui.mount(target(surface))
    await clock.settle()
    expect(await row(again, 0)).toBe('ZZZZA')
  })

  test(`with nothing loaded, r retries on ${surface}`, async ($: Engine, on: On) => {
    const clock = mock.clock(on)
    store(on, SIGNED_IN)
    let isDown = true
    on('http.fetch', async () => {
      if (isDown) throw new Error('offline')
      return { value: reply({ number: 1, day: '2026-10-07', endsAt: Date.UTC(2026, 9, 8), guesses: [], state: 'playing', answer: null }) }
    })
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    await $.command.run(run)
    const ui = await $.ui.mount(target(surface))
    await clock.settle()
    expect(await shown(ui)).toContain('Game server unreachable.')
    expect(await shown(ui)).toContain('r retry')
    isDown = false
    await press(ui, clock, 'r')
    expect(await shown(ui)).toContain('DAILY DIFF #1')
  })

  test(`a short pane plays with one row per guess on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, guesses } = await open($, on, surface)
    await short(ui)
    const text = await shown(ui)
    expect(text).not.toContain('bigger')
    expect(text).toContain('DAILY DIFF #1')
    expect(text).toContain('ENTER')
    for (let i = 0; i < 6; i++) expect(await ui.find({ key: `row-${i}`, in: 'game' })).toBeDefined()
    await press(ui, clock, 'z', 'z')
    expect(await row(ui, 0)).toBe('ZZ···')
    await press(ui, clock, 'z', 'z', 'a', 'return')
    expect(guesses).toEqual(['zzzza'])
    expect(await row(ui, 0)).toBe('ZZZZA')
  })

  test(`a short pane still shows the result, stats and share on ${surface}`, async ($: Engine, on: On) => {
    const rows = Array.from({ length: 20 }, (_, i) => player(i + 1, `p${i + 1}`))
    const { clock, ui } = await open($, on, surface, { rows })
    await typeWord(ui, clock, 'qqqqa')
    await short(ui)
    const text = await shown(ui)
    expect(text).not.toContain('bigger')
    expect(text).toContain('Solved in 1/6')
    expect(text).toContain('Played 1  Win 100%  Streak 1  Best 1')
    expect(text).toContain('s share')
    expect(await ui.find({ type: 'Text', text: /p1 /, in: 'game' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /p20 /, in: 'game' })).toBeUndefined()
  })

  test(`a very short pane puts the result, stats and share above the board on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui } = await open($, on, surface)
    await typeWord(ui, clock, 'qqqqa')
    await ui.resize({ columns: 60, rows: 6, in: 'game' })
    const text = await shown(ui)
    expect(text).not.toContain('bigger')
    expect(text).toContain('Solved in 1/6')
    expect(text).toContain('Played 1  Win 100%')
    expect(text).toContain('s share')
    expect(await ui.find({ type: 'Text', text: /alice/, in: 'game' })).toBeUndefined()
    await ui.resize({ columns: 60, rows: 8, in: 'game' })
    expect(await ui.find({ type: 'Text', text: /alice/, in: 'game' })).toBeDefined()
  })

  test(`a loss shows the word on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui } = await open($, on, surface)
    for (let i = 0; i < 6; i++) await typeWord(ui, clock, 'zzzza')
    const text = await shown(ui)
    expect(text).toContain('The word was QQQQA')
    expect(text).not.toContain('Solved')
  })

  test(`your own rank shows under the top 20 on ${surface}`, async ($: Engine, on: On) => {
    const rows = Array.from({ length: 20 }, (_, i) => player(i + 1, `p${i + 1}`))
    const { clock, ui } = await open($, on, surface, { rows, you: player(42, 'alice') })
    await typeWord(ui, clock, 'qqqqa')
    expect(await ui.find({ type: 'Text', text: /p20 /, in: 'game' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ...', in: 'game' })).toBeDefined()
    const you = await ui.find({ type: 'Text', text: /^ 42 {2}alice /, in: 'game' })
    expect(you?.props.bold).toBe(true)
  })

  test(`at midnight the finished screen asks for the new puzzle once on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, seen } = await open($, on, surface, { now: ENDS_AT - 5000 })
    await typeWord(ui, clock, 'qqqqa')
    expect(await shown(ui)).toContain('next in 0m 05s')
    const before = todayFetches(seen)
    await ui.advance(4000)
    await clock.settle()
    expect(await shown(ui)).toContain('next in 0m 01s')
    expect(todayFetches(seen)).toBe(before)
    await ui.advance(1000)
    await clock.settle()
    expect(todayFetches(seen)).toBe(before + 1)
    await ui.advance(5000)
    await clock.settle()
    expect(todayFetches(seen)).toBe(before + 1)
  })

  test(`stats that fail to load come back with r on ${surface}`, async ($: Engine, on: On) => {
    const { clock, ui, down } = await open($, on, surface)
    down.add('/v1/daily-diff/stats')
    await typeWord(ui, clock, 'qqqqa')
    let text = await shown(ui)
    expect(text).toContain('Server said: boom')
    expect(text).not.toContain('Played')
    expect(await ui.find({ type: 'Text', text: /alice/, in: 'game' })).toBeDefined()
    down.clear()
    await press(ui, clock, 'r')
    text = await shown(ui)
    expect(text).toContain('Played 1  Win 100%')
    expect(text).not.toContain('boom')
  })

  test(`a pane too short even for one row per guess asks to be bigger on ${surface}`, async ($: Engine, on: On) => {
    const { ui } = await open($, on, surface)
    await ui.resize({ columns: 60, rows: 10, in: 'game' })
    const text = await shown(ui)
    expect(text).toContain('bigger')
    expect(text).not.toContain('ENTER')
  })

  test(`a small pane asks to be bigger on ${surface}`, async ($: Engine, on: On) => {
    const { ui } = await open($, on, surface)
    await ui.resize({ columns: 30, rows: 20, in: 'game' })
    const text = await shown(ui)
    expect(text).toContain('bigger')
    expect(text).not.toContain('ENTER')
  })
}
