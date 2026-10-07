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

async function open($: Engine, on: On, surface: 'terminal' | 'desktop') {
  const clock = mock.clock(on)
  store(on, SIGNED_IN)
  const fake = server(on)
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

  test(`a small pane asks to be bigger on ${surface}`, async ($: Engine, on: On) => {
    const { ui } = await open($, on, surface)
    await ui.resize({ columns: 30, rows: 20, in: 'game' })
    const text = await shown(ui)
    expect(text).toContain('bigger')
    expect(text).not.toContain('ENTER')
  })
}
