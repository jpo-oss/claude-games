import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { flatten, natural } from './render'

declare const console: { log: (s: string) => void }

const PANE = { title: 'Tetris', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const target = { plugin: 'block-battle', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'block-battle', viewport: { columns: 100, rows: 60 } } as const
type Ui = Mounted<'terminal', 'Pane'>

// Region sizes, one per layout tier (and one too small for any).
const SIZES = { big: { columns: 66, rows: 46 }, compact: { columns: 48, rows: 26 }, mini: { columns: 33, rows: 22 }, tiny: { columns: 20, rows: 10 } } as const
type SizeName = keyof typeof SIZES

const proc = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const BOARD = {
  marathon: [{ login: 'bob', score: 91250, lines: 80, level: 9, at: 1 }, { login: 'alice', score: 40300, lines: 41, level: 5, at: 2 }, { login: 'carol', score: 1200, lines: 5, level: 1, at: 3 }],
  wins: [{ login: 'alice', wins: 12 }, { login: 'bob', wins: 3 }],
}
function serve(on: On) {
  on('process.run', async (_$, e) => {
    const cmd = e.argv.join(' ')

    return { value: cmd === 'gh auth token' ? proc('ghp_x\n') : cmd.startsWith('gh api user') ? proc('alice\n') : proc('', 1) }
  })
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(BOARD) } }))
}

async function open($: Engine, size: SizeName): Promise<Ui> {
  const ui = await $.ui.mount(target)
  await ui.resize({ ...SIZES[size], in: 'tetris' })
  await ui.advance(32)

  return ui
}

// Lines of the drawn Client, laid out in its region, with a ruler so clipping and misalignment show.
async function screen(ui: Ui, size: SizeName): Promise<string[]> {
  const { columns, rows } = SIZES[size]
  const tree = await ui.drawn({ in: 'tetris' })
  const nat = natural(tree)
  // tiny is smaller than any layout: only the too-small note, which a real terminal wraps
  if (size !== 'tiny') {
    expect(nat.w).toBeLessThanOrEqual(columns)
    expect(nat.h).toBeLessThanOrEqual(rows)
  } else {
    // The dump clips here and a real terminal wraps, so check the content itself: the too-small
    // note on the game screens, the screen's own heading on the menus.
    const drawn = JSON.stringify(tree)
    expect(['Too small for Tetris', 'Marathon', 'BATTLE', 'MARATHON TOP'].some(word => drawn.includes(word))).toBe(true)
  }
  const lines = flatten(tree, columns, rows)
  const out = [`+${'-'.repeat(columns)}+  region ${columns}x${rows}, drawn ${nat.w}x${nat.h}`]
  for (let i = 0; i < rows; i++) out.push('|' + (lines[i] ?? '').padEnd(columns) + '|')
  out.push(`+${'-'.repeat(columns)}+`)

  return out
}

async function drop(ui: Ui, n: number) {
  for (let i = 0; i < n; i++) {
    await ui.key({ key: ' ' })
    await ui.advance(16)
  }
}

// `claude plugin test` has no file access for a test, so each screen goes to stdout between markers
// and a shell step splits them into files.
const emit = (name: string, lines: string[]) => console.log(`@@DUMP ${name}\n${lines.join('\n')}\n@@END`)

const toLeaderboard = async (ui: Ui) => {
  await ui.key({ key: 'down' })
  await ui.key({ key: 'down' })
  await ui.key({ key: 'return' })
  await ui.advance(48)
  await ui.advance(48)
}

for (const size of ['big', 'compact', 'mini', 'tiny'] as const) {
  test(`${size}: menu fits its region`, async ($: Engine, on: On) => {
    mock.clock(on)
    serve(on)
    const ui = await open($, size)
    emit(`${size}-menu`, await screen(ui, size))
  })

  test(`${size}: leaderboard, and the menu with the top score, fit`, async ($: Engine, on: On) => {
    mock.clock(on)
    serve(on)
    const ui = await open($, size)
    await toLeaderboard(ui)
    emit(`${size}-leaderboard`, await screen(ui, size))
    await ui.key({ key: 'q' })
    await ui.advance(48)
    emit(`${size}-menu-top-score`, await screen(ui, size))
  })

  test(`${size}: the battle lobby fits`, async ($: Engine, on: On) => {
    mock.clock(on)
    serve(on)
    const ui = await open($, size)
    await ui.key({ key: 'down' })
    await ui.key({ key: 'return' })
    await ui.advance(48)
    emit(`${size}-lobby`, await screen(ui, size))
  })

  test(`${size}: a game with a held piece fits`, async ($: Engine, on: On) => {
    mock.clock(on)
    serve(on)
    const ui = await open($, size)
    await ui.key({ key: 'return' })
    await ui.advance(32)
    await drop(ui, 3)
    await ui.key({ key: 'c' })
    await ui.advance(100)
    emit(`${size}-play`, await screen(ui, size))
  })

  test(`${size}: game over keeps the board and shows the overlay`, async ($: Engine, on: On) => {
    mock.clock(on)
    serve(on)
    const ui = await open($, size)
    await ui.key({ key: 'return' })
    await drop(ui, 16)
    await ui.advance(1_000)
    emit(`${size}-gameover`, await screen(ui, size))
  })
}
