import { test, expect } from 'claude-code/testing'
import {
  newGame, step, ghostY, cellsOf, receiveGarbage, snapshot,
  type Game, type Active, type Kind, type Input, type Mode, type GameEvent,
} from '../hooks/engine'

type LineClear = Extract<GameEvent, { type: 'lineClear' }>

const A = (kind: Kind, rotation: 0 | 1 | 2 | 3, x: number, y: number): Active => ({ kind, rotation, x, y })

// rows maps a board row (0 = top, 39 = floor) to a string where X is a filled cell.
function mk(rows: Record<number, string>, active: Active, extra: Partial<Game> = {}, mode: Mode = 'marathon'): Game {
  const g = newGame(mode, 7)
  const board = g.board.map(r => r.slice())
  for (const [row, str] of Object.entries(rows)) {
    for (let c = 0; c < 10; c++) if (str[c] === 'X') board[Number(row)]![c] = 'G'
  }
  return { ...g, board, active, lowestY: active.y, ...extra }
}

function drop(g: Game, inputs: Input[] = ['hardDrop']) {
  const r = step(g, inputs, 0)
  const ev = r.events.find((e): e is LineClear => e.type === 'lineClear')
  return { ...r, ev }
}

const sortCells = (c: number[][]) => c.slice().sort((p, q) => p[1]! - q[1]! || p[0]! - q[0]!)
const types = (events: GameEvent[]) => events.map(e => e.type)

// k filled rows with a one-wide well at column 9; a tetris keeps a fifth row so it is not a perfect clear.
const WELL = (k: number, keepOneRow = false) => {
  const rows: Record<number, string> = {}
  for (let r = 40 - k - (keepOneRow ? 1 : 0); r < 40; r++) rows[r] = 'XXXXXXXXX.'
  return rows
}
const I_WELL = A('I', 1, 7, 36)
const I_FLAT_ROW = 'XXXXXX....'
const I_FLAT = A('I', 0, 6, 38)

const T_SPIN_TOP = { 37: '..X.......' }
const TSS = { ...T_SPIN_TOP }
const TS_L = A('T', 3, 0, 37)
const MINI_TOP = { 37: 'X.X.......' }
const TST_OVERHANG = { 35: '.....X....' }

test('cellsOf: spawn orientation of every piece, written out by hand', () => {
  expect(cellsOf(A('T', 0, 3, 10))).toEqual([[4, 10], [3, 11], [4, 11], [5, 11]])
  expect(cellsOf(A('I', 0, 0, 0))).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]])
  expect(cellsOf(A('O', 0, 0, 0))).toEqual([[1, 0], [2, 0], [1, 1], [2, 1]])
  expect(cellsOf(A('S', 0, 0, 0))).toEqual([[1, 0], [2, 0], [0, 1], [1, 1]])
  expect(cellsOf(A('Z', 0, 0, 0))).toEqual([[0, 0], [1, 0], [1, 1], [2, 1]])
  expect(cellsOf(A('J', 0, 0, 0))).toEqual([[0, 0], [0, 1], [1, 1], [2, 1]])
  expect(cellsOf(A('L', 0, 0, 0))).toEqual([[2, 0], [0, 1], [1, 1], [2, 1]])
})

test('cellsOf: rotated states', () => {
  expect(sortCells(cellsOf(A('T', 1, 0, 0)))).toEqual(sortCells([[1, 0], [1, 1], [2, 1], [1, 2]]))
  expect(sortCells(cellsOf(A('T', 2, 0, 0)))).toEqual(sortCells([[0, 1], [1, 1], [2, 1], [1, 2]]))
  expect(sortCells(cellsOf(A('T', 3, 0, 0)))).toEqual(sortCells([[1, 0], [0, 1], [1, 1], [1, 2]]))
  expect(sortCells(cellsOf(A('I', 1, 7, 36)))).toEqual(sortCells([[9, 36], [9, 37], [9, 38], [9, 39]]))
  expect(sortCells(cellsOf(A('L', 1, 0, 0)))).toEqual(sortCells([[1, 0], [1, 1], [1, 2], [2, 2]]))
  expect(sortCells(cellsOf(A('O', 3, 0, 0)))).toEqual(sortCells([[1, 0], [2, 0], [1, 1], [2, 1]]))
})

test('new game: 5 previews, guideline spawn just above the field, then one row down', () => {
  const g = newGame('marathon', 42)
  expect(g.board.length).toBe(40)
  expect(g.board.every(r => r.length === 10 && r.every(c => c === null))).toBe(true)
  expect(g.next.length).toBe(5)
  expect(g.active!.rotation).toBe(0)
  expect(g.active!.x).toBe(3)
  expect(g.active!.y).toBe(19)
  expect(g.level).toBe(1)
  expect(g.combo).toBe(-1)
  expect(g.canHold).toBe(true)
  expect(g.isOver).toBe(false)
})

test('7-bag: every run of 7 pieces is a full set, and previews match what spawns', () => {
  let g = newGame('marathon', 12345)
  const seq: Kind[] = []
  for (let i = 0; i < 70; i++) {
    seq.push(g.active!.kind)
    const peek = g.next[0]!
    g = step(g, ['hardDrop'], 0).game
    expect(g.active!.kind).toBe(peek)
    g = { ...g, board: newGame('marathon', 1).board }
  }
  for (let c = 0; c < 10; c++) {
    expect(seq.slice(c * 7, c * 7 + 7).sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z'])
  }
})

test('same seed gives the same sequence, step never mutates its input', () => {
  const a = newGame('marathon', 99)
  const b = newGame('marathon', 99)
  expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  const before = JSON.stringify(a)
  const r = step(a, ['left', 'rotateCW', 'softDropOn', 'hold', 'hardDrop'], 5000)
  expect(JSON.stringify(a)).toBe(before)
  expect(r.game === a).toBe(false)
  const r2 = step(b, ['left', 'rotateCW', 'softDropOn', 'hold', 'hardDrop'], 5000)
  expect(JSON.stringify(r2.game)).toBe(JSON.stringify(r.game))
})

test('movement stops at the walls', () => {
  let g = mk({}, A('T', 0, 3, 30))
  g = step(g, ['left', 'left', 'left', 'left', 'left', 'left'], 0).game
  expect(g.active!.x).toBe(0)
  g = step(g, ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'], 0).game
  expect(g.active!.x).toBe(7)
})

test('SRS: open-board rotation takes the first kick, no offset', () => {
  const g = mk({}, A('T', 0, 3, 30))
  const r = step(g, ['rotateCW'], 0).game
  expect(r.active).toEqual(A('T', 1, 3, 30))
  const l = step(g, ['rotateCCW'], 0).game
  expect(l.active).toEqual(A('T', 3, 3, 30))
})

test('SRS: I piece wall kick R to 0 slides two cells off the left wall', () => {
  const g = mk({}, A('I', 1, -2, 30))
  expect(step(g, ['rotateCCW'], 0).game.active).toEqual(A('I', 0, 0, 30))
})

test('SRS: T-spin double setup rotates in with the first kick and clears two rows', () => {
  const g = mk({ ...T_SPIN_TOP, 38: '...XXXXXXX', 39: 'X.XXXXXXXX' }, TS_L)
  const r = step(g, ['rotateCCW'], 0).game
  expect(r.active).toEqual(A('T', 2, 0, 37))
  const d = drop(g, ['rotateCCW', 'hardDrop'])
  expect(d.ev!.kind).toBe('tspinDouble')
  expect(d.ev!.rows).toEqual([38, 39])
  expect(d.game.score).toBe(1200)
})

const TST_BOARD = { ...TST_OVERHANG, 37: 'XXXXX.XXXX', 38: 'XXXX..XXXX', 39: 'XXXXX.XXXX' }

test('SRS: TST takes the fifth kick (+1,+2 down) because kicks 1 to 4 are blocked', () => {
  const g = mk(TST_BOARD, A('T', 0, 3, 35))
  expect(step(g, ['rotateCCW'], 0).game.active).toEqual(A('T', 3, 4, 37))
})

test('T-spin triple through the TST kick scores 1600', () => {
  const g = mk(TST_BOARD, A('T', 0, 3, 35))
  const d = drop(g, ['rotateCCW', 'hardDrop'])
  expect(d.ev!.kind).toBe('tspinTriple')
  expect(d.ev!.rows).toEqual([37, 38, 39])
  expect(d.game.score).toBe(1600)
})

test('TST kick upgrades a mini to a full T-spin (double, front corner empty)', () => {
  const g = mk({ ...TST_OVERHANG, 37: 'XXXXX.XXXX', 38: 'XXXX..XXXX', 39: 'XXXX..XXXX' }, A('T', 0, 3, 35))
  const d = drop(g, ['rotateCCW', 'hardDrop'])
  expect(d.ev!.kind).toBe('tspinDouble')
  expect(d.game.score).toBe(1200)
})

test('hard drop: +2 per row, event carries from, to and columns', () => {
  const g = mk({}, A('I', 0, 3, 30))
  const r = step(g, ['hardDrop'], 0)
  expect(r.game.score).toBe(16)
  const e = r.events.find(x => x.type === 'hardDrop')
  expect(e).toEqual({ type: 'hardDrop', from: 30, to: 38, columns: [3, 4, 5, 6] })
  expect(types(r.events)).toEqual(['hardDrop', 'lock'])
  expect(r.game.board[39]!.slice(3, 7)).toEqual(['I', 'I', 'I', 'I'])
})

test('ghostY lands on the stack, null without an active piece', () => {
  expect(ghostY(mk({}, A('I', 0, 3, 30)))).toBe(38)
  expect(ghostY(mk({ 39: 'XXXXXXXXXX'.replace('X', '.') + '' , 38: '...X......' }, A('T', 0, 3, 30)))).toBe(36)
  expect(ghostY({ ...mk({}, A('T', 0, 3, 30)), active: null })).toBe(null)
})

test('gravity level 1: one row per second', () => {
  const g = newGame('marathon', 3)
  const a = step(g, [], 999).game
  expect(a.active!.y).toBe(19)
  expect(step(a, [], 1).game.active!.y).toBe(20)
})

test('gravity level 2 is 793 ms per row, level 15 about 7 ms per row', () => {
  const g2 = { ...newGame('marathon', 3), level: 2 }
  expect(step(g2, [], 790).game.active!.y).toBe(19)
  expect(step(g2, [], 800).game.active!.y).toBe(20)
  const g15 = { ...newGame('marathon', 3), level: 15 }
  expect(step(g15, [], 100).game.active!.y).toBe(33)
})

test('soft drop falls 20x faster and pays 1 point per row', () => {
  const g = mk({}, A('T', 0, 3, 10))
  const r = step(g, ['softDropOn'], 500).game
  expect(r.active!.y).toBe(20)
  expect(r.score).toBe(10)
  const off = step(r, ['softDropOff'], 500).game
  expect(off.active!.y).toBe(20)
  expect(off.score).toBe(10)
})

// Each softDropStep input moves exactly one row (the game sends a fixed number per down press, since a
// terminal sends no key-up). Landing this way must keep the full lock delay, so the piece can still be
// rotated into a slot.
test('a soft-drop step moves one row, pays 1 point, and never locks the piece', () => {
  const g = mk({}, A('T', 0, 3, 10))
  const one = step(g, ['softDropStep'], 0).game
  expect(one.active!.y).toBe(11)
  expect(one.score).toBe(1)
  const three = step(g, ['softDropStep', 'softDropStep', 'softDropStep'], 0).game
  expect(three.active!.y).toBe(13)
  // One row above the floor: the first step lands it, the second does nothing.
  const above = mk({}, A('T', 0, 3, 37))
  const landed = step(above, ['softDropStep', 'softDropStep'], 0).game
  expect(landed.active!.y).toBe(38)
  expect(landed.score).toBe(1)
  // The whole 500 ms lock delay is still ahead of it: alive at 499 ms, locked on the next 1 ms.
  const waited = step(landed, [], 499)
  expect(types(waited.events)).not.toContain('lock')
  expect(types(step(waited.game, [], 1).events)).toContain('lock')
})

test('lock delay: 499 ms still alive, 500 ms locks', () => {
  const g = mk({}, A('T', 0, 3, 38))
  const a = step(g, [], 499)
  expect(a.game.active).toBeTruthy()
  expect(types(a.events)).toEqual([])
  const b = step(a.game, [], 1)
  expect(types(b.events)).toContain('lock')
})

test('lock delay: a move resets the timer', () => {
  const g = mk({}, A('T', 0, 3, 38))
  const a = step(g, [], 400).game
  const b = step(a, ['left'], 400)
  expect(types(b.events)).toEqual([])
  expect(b.game.active!.x).toBe(2)
})

test('lock delay: the 16th grounded move does not reset the timer', () => {
  let g = mk({}, A('T', 0, 3, 38))
  for (let i = 0; i < 15; i++) {
    const r = step(g, [i % 2 === 0 ? 'left' : 'right'], 400)
    expect(types(r.events)).toEqual([])
    g = r.game
  }
  expect(g.resets).toBe(15)
  const last = step(g, ['right'], 400)
  expect(types(last.events)).toContain('lock')
})

test('lock delay: reaching a new lowest row clears the reset counter', () => {
  const g = mk({}, A('T', 0, 3, 30), { resets: 15 })
  const r = step(g, ['softDropOn'], 100).game
  expect(r.active!.y).toBe(32)
  expect(r.resets).toBe(0)
})

test('hold: swaps once per piece, canHold returns after a lock', () => {
  const g = newGame('marathon', 5)
  const first = g.active!.kind
  const second = g.next[0]!
  const a = step(g, ['hold'], 0)
  expect(a.events).toEqual([{ type: 'hold' }])
  expect(a.game.hold).toBe(first)
  expect(a.game.active!.kind).toBe(second)
  expect(a.game.canHold).toBe(false)
  expect(a.game.next.length).toBe(5)
  const again = step(a.game, ['hold'], 0)
  expect(again.events).toEqual([])
  expect(again.game.hold).toBe(first)
  const locked = step(a.game, ['hardDrop'], 0).game
  expect(locked.canHold).toBe(true)
  const third = locked.active!.kind
  const swap = step(locked, ['hold'], 0).game
  expect(swap.active!.kind).toBe(first)
  expect(swap.hold).toBe(third)
})

test('scoring: single, double, triple, tetris', () => {
  const kinds = ['single', 'double', 'triple', 'tetris']
  const scores = [100, 300, 500, 800]
  for (let k = 1; k <= 4; k++) {
    const d = drop(mk(WELL(k, k === 4), I_WELL))
    expect(d.ev!.kind).toBe(kinds[k - 1])
    expect(d.ev!.rows).toEqual([36, 37, 38, 39].slice(4 - k))
    expect(d.ev!.perfectClear).toBe(false)
    expect(d.game.score).toBe(scores[k - 1])
    expect(d.game.lines).toBe(k)
  }
})

test('scoring: T-spin with no lines, full and mini', () => {
  const full = drop(mk({ ...TSS, 38: '...XXXXXX.', 39: 'X.XXXXXXX.' }, TS_L), ['rotateCCW', 'hardDrop'])
  expect(full.ev!.kind).toBe('tspin')
  expect(full.ev!.rows).toEqual([])
  expect(full.game.score).toBe(400)
  const mini = drop(mk({ ...MINI_TOP, 38: '...XXXXXX.', 39: '..XXXXXXXX' }, TS_L), ['rotateCCW', 'hardDrop'])
  expect(mini.ev!.kind).toBe('tspinMini')
  expect(mini.game.score).toBe(100)
})

test('scoring: T-spin single 800, mini single 200', () => {
  const full = drop(mk({ ...TSS, 38: '...XXXXXX.', 39: 'X.XXXXXXXX' }, TS_L), ['rotateCCW', 'hardDrop'])
  expect(full.ev!.kind).toBe('tspinSingle')
  expect(full.ev!.rows).toEqual([39])
  expect(full.game.score).toBe(800)
  const mini = drop(mk({ ...MINI_TOP, 38: '...XXXXXXX', 39: '..XXXXXXX.' }, TS_L), ['rotateCCW', 'hardDrop'])
  expect(mini.ev!.kind).toBe('tspinMiniSingle')
  expect(mini.ev!.rows).toEqual([38])
  expect(mini.game.score).toBe(200)
})

const MINI_DOUBLE = () => mk(
  { 37: '...X......', 38: 'XXXX..XXXX', 39: 'XXXX.XXXXX' },
  A('T', 1, 3, 37),
  { rotated: true, kickIdx: 0 },
)

test('scoring: T-spin mini double 400 (spin state set directly, a double needs a kick)', () => {
  const d = drop(MINI_DOUBLE())
  expect(d.ev!.kind).toBe('tspinMiniDouble')
  expect(d.ev!.rows).toEqual([38, 39])
  expect(d.game.score).toBe(400)
})

test('a T that is not last moved by rotation is not a spin', () => {
  const g = mk({ ...TSS, 38: '...XXXXXXX', 39: 'X.XXXXXXXX' }, A('T', 2, 0, 37), { rotated: false })
  expect(drop(g).ev!.kind).toBe('double')
  expect(drop({ ...g, rotated: true }).ev!.kind).toBe('tspinDouble')
})

test('scoring multiplies by level and a level-up fires at 10 lines', () => {
  const lv3 = drop(mk(I_FLAT_ROWS(), I_FLAT, { lines: 20, level: 3 }))
  expect(lv3.game.score).toBe(300)
  const up = drop(mk(I_FLAT_ROWS(), I_FLAT, { lines: 9 }))
  expect(up.game.score).toBe(100)
  expect(up.game.level).toBe(2)
  expect(up.events.find(e => e.type === 'levelUp')).toEqual({ type: 'levelUp', level: 2 })
  const cap = drop(mk(I_FLAT_ROWS(), I_FLAT, { lines: 149, level: 15 }))
  expect(cap.game.level).toBe(15)
  expect(types(cap.events)).not.toContain('levelUp')
  expect(cap.game.score).toBe(1500)
})

function I_FLAT_ROWS(): Record<number, string> {
  return { 38: I_FLAT_ROW, 39: I_FLAT_ROW }
}

test('combo: +50 per step x level, resets on a lock without a clear', () => {
  const first = drop(mk({ 37: I_FLAT_ROW, ...I_FLAT_ROWS() }, I_FLAT))
  expect(first.ev!.combo).toBe(0)
  expect(first.game.score).toBe(100)
  const second = drop({ ...first.game, active: I_FLAT })
  expect(second.ev!.combo).toBe(1)
  expect(second.game.score).toBe(250)
  expect(second.game.combo).toBe(1)
  const third = drop({ ...mk({}, A('O', 0, 3, 30)), combo: 1 })
  expect(third.game.combo).toBe(-1)
})

test('combo bonus grows with the combo and the level', () => {
  const g = mk(I_FLAT_ROWS(), I_FLAT, { combo: 3, lines: 10, level: 2 })
  const d = drop(g)
  expect(d.ev!.combo).toBe(4)
  expect(d.game.score).toBe(200 + 50 * 4 * 2)
})

test('back-to-back: second tetris is x1.5, and a combo is stacked on top', () => {
  const rows = WELL(9)
  const first = drop(mk(rows, I_WELL))
  expect(first.ev!.b2b).toBe(false)
  expect(first.game.score).toBe(800)
  expect(first.game.b2b).toBe(true)
  const second = drop({ ...first.game, active: I_WELL })
  expect(second.ev!.b2b).toBe(true)
  expect(second.game.score).toBe(800 + 1200 + 50)
})

test('back-to-back: a plain single breaks it, a zero-line T-spin keeps it', () => {
  const broke = drop(mk(I_FLAT_ROWS(), I_FLAT, { b2b: true }))
  expect(broke.game.score).toBe(100)
  expect(broke.game.b2b).toBe(false)
  const kept = drop(mk({ ...TSS, 38: '...XXXXXX.', 39: 'X.XXXXXXX.' }, TS_L, { b2b: true }), ['rotateCCW', 'hardDrop'])
  expect(kept.game.score).toBe(400)
  expect(kept.game.b2b).toBe(true)
})

test('back-to-back: a T-spin double followed by a tetris scores 1200 for the tetris', () => {
  const g = mk(WELL(4, true), I_WELL, { b2b: true })
  expect(drop(g).game.score).toBe(1200)
})

test('perfect clear bonuses: single 800, double 1200, triple 1800, tetris 2000, b2b tetris 3200', () => {
  const single = drop(mk({ 39: I_FLAT_ROW }, I_FLAT))
  expect(single.ev!.perfectClear).toBe(true)
  expect(single.game.score).toBe(100 + 800)
  const double = drop(mk({ 38: 'XXXXXXXX..', 39: 'XXXXXXXX..' }, A('O', 0, 7, 38)))
  expect(double.game.score).toBe(300 + 1200)
  const triple = drop(mk({ 37: 'XXXXXXXX.X', 38: 'XXXXXXXX.X', 39: 'XXXXXXXX..' }, A('L', 1, 7, 37)))
  expect(triple.ev!.kind).toBe('triple')
  expect(triple.game.score).toBe(500 + 1800)
  const tetris = drop(mk(WELL(4), I_WELL))
  expect(tetris.ev!.perfectClear).toBe(true)
  expect(tetris.game.score).toBe(800 + 2000)
  const b2b = drop(mk(WELL(4), I_WELL, { b2b: true }))
  expect(b2b.game.score).toBe(1200 + 3200)
})

test('attack table (battle): line clears', () => {
  const expected = [0, 1, 2, 4]
  for (let k = 1; k <= 4; k++) {
    expect(drop(mk(WELL(k, k === 4), I_WELL, {}, 'battle')).ev!.attack).toBe(expected[k - 1])
  }
})

test('attack table (battle): T-spins', () => {
  const b = 'battle'
  expect(drop(mk({ ...MINI_TOP, 38: '...XXXXXX.', 39: '..XXXXXXXX' }, TS_L, {}, b), ['rotateCCW', 'hardDrop']).ev!.attack).toBe(0)
  expect(drop(mk({ ...MINI_TOP, 38: '...XXXXXXX', 39: '..XXXXXXX.' }, TS_L, {}, b), ['rotateCCW', 'hardDrop']).ev!.attack).toBe(0)
  const md = MINI_DOUBLE()
  expect(drop({ ...md, mode: 'battle' }).ev!.attack).toBe(1)
  expect(drop(mk({ ...TSS, 38: '...XXXXXX.', 39: 'X.XXXXXXXX' }, TS_L, {}, b), ['rotateCCW', 'hardDrop']).ev!.attack).toBe(2)
  expect(drop(mk({ ...TSS, 38: '...XXXXXXX', 39: 'X.XXXXXXXX' }, TS_L, {}, b), ['rotateCCW', 'hardDrop']).ev!.attack).toBe(4)
  expect(drop(mk(TST_BOARD, A('T', 0, 3, 35), {}, b), ['rotateCCW', 'hardDrop']).ev!.attack).toBe(6)
})

test('attack table (battle): combo ladder on a single, clamped at 5', () => {
  const ladder = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5]
  for (let k = 0; k < ladder.length; k++) {
    const d = drop(mk(I_FLAT_ROWS(), I_FLAT, { combo: k - 1 }, 'battle'))
    expect(d.ev!.attack).toBe(ladder[k])
  }
  const d = drop(mk(I_FLAT_ROWS(), I_FLAT, { combo: 19 }, 'battle'))
  expect(d.ev!.attack).toBe(5)
})

test('attack table (battle): back-to-back adds 1, perfect clear is 10, marathon sends nothing', () => {
  expect(drop(mk(WELL(4), I_WELL, { b2b: true, combo: 1 }, 'battle')).ev!.attack).toBe(10)
  const rows: Record<number, string> = {}
  for (let r = 32; r < 40; r++) rows[r] = 'XXXXXXXXX.'
  expect(drop(mk(rows, I_WELL, { b2b: true }, 'battle')).ev!.attack).toBe(5)
  expect(drop(mk({ 39: I_FLAT_ROW }, I_FLAT, {}, 'battle')).ev!.attack).toBe(10)
  expect(drop(mk(rows, I_WELL, { b2b: true })).ev!.attack).toBe(0)
})

test('garbage: receiveGarbage queues in battle only, hole is a real column', () => {
  const m = receiveGarbage(newGame('marathon', 1), 3)
  expect(m.pendingGarbage).toEqual([])
  const b0 = newGame('battle', 1)
  const b = receiveGarbage(b0, 3)
  expect(b0.pendingGarbage).toEqual([])
  expect(b.pendingGarbage.length).toBe(1)
  expect(b.pendingGarbage[0]!.lines).toBe(3)
  expect(b.pendingGarbage[0]!.hole >= 0 && b.pendingGarbage[0]!.hole <= 9).toBe(true)
})

test('garbage: cancelled by an attack, the remainder is sent', () => {
  const rows: Record<number, string> = {}
  for (let r = 32; r < 40; r++) rows[r] = 'XXXXXXXXX.'
  const pend = [{ lines: 3, hole: 1 }]
  const d = drop(mk(rows, I_WELL, { b2b: true, pendingGarbage: pend }, 'battle'))
  expect(d.ev!.attack).toBe(2)
  expect(d.game.pendingGarbage).toEqual([])
  const partial = drop(mk(WELL(4, true), I_WELL, { pendingGarbage: [{ lines: 3, hole: 1 }, { lines: 2, hole: 8 }] }, 'battle'))
  expect(partial.ev!.attack).toBe(0)
  expect(partial.game.pendingGarbage).toEqual([{ lines: 1, hole: 8 }])
  expect(types(partial.events)).not.toContain('garbageIn')
})

test('garbage: a clearing lock leaves it queued, a lock without a clear drops it in', () => {
  const held = drop(mk(I_FLAT_ROWS(), I_FLAT, { pendingGarbage: [{ lines: 2, hole: 5 }] }, 'battle'))
  expect(held.game.pendingGarbage).toEqual([{ lines: 2, hole: 5 }])
  expect(types(held.events)).not.toContain('garbageIn')
  const g = mk({}, A('T', 0, 3, 30), { pendingGarbage: [{ lines: 2, hole: 5 }] }, 'battle')
  const r = step(g, ['hardDrop'], 0)
  expect(r.events).toContainEqual({ type: 'garbageIn', lines: 2 })
  expect(r.game.pendingGarbage).toEqual([])
  for (const row of [38, 39]) {
    expect(r.game.board[row]!).toEqual(['G', 'G', 'G', 'G', 'G', null, 'G', 'G', 'G', 'G'])
  }
  expect(r.game.board[36]![4]).toBe('T')
  expect(r.game.board[37]!.slice(3, 6)).toEqual(['T', 'T', 'T'])
})

test('game over: block out when the next piece cannot spawn', () => {
  const g = mk({ 18: '...XXXX...', 19: '...XXXX...' }, A('T', 0, 3, 30))
  const r = step(g, ['hardDrop'], 0)
  expect(r.game.isOver).toBe(true)
  expect(types(r.events)).toContain('topOut')
  expect(step(r.game, ['left'], 1000).events).toEqual([])
})

test('game over: lock out when a piece locks entirely above the visible field', () => {
  const g = mk({ 12: '....XX....' }, A('O', 0, 3, 10))
  const r = step(g, ['hardDrop'], 0)
  expect(r.game.isOver).toBe(true)
  expect(types(r.events)).toEqual(['hardDrop', 'lock', 'topOut'])
})

test('game over: garbage pushing blocks off the top of the board', () => {
  const g = mk({ 0: '.X........' }, A('T', 0, 3, 30), { pendingGarbage: [{ lines: 1, hole: 0 }] }, 'battle')
  const r = step(g, ['hardDrop'], 0)
  expect(r.game.isOver).toBe(true)
  expect(types(r.events)).toContain('topOut')
})

test('a normal lock keeps the game going and a fresh piece appears', () => {
  const r = step(mk({}, A('T', 0, 3, 30)), ['hardDrop'], 0)
  expect(r.game.isOver).toBe(false)
  expect(r.game.active!.y).toBe(19)
})

test('snapshot: 20 visible rows of 10, piece included, hidden rows left out', () => {
  const g = mk({ 39: 'XX........', 5: 'XXXXXXXXXX' }, A('T', 0, 3, 38))
  const s = snapshot(g)
  expect(s.length).toBe(200)
  expect(s.slice(0, 10)).toBe('..........')
  expect(s.slice(180, 190)).toBe('....T.....')
  expect(s.slice(190, 200)).toBe('GG.TTT....')
})

test('garbage: receiving it does not change which pieces come next', () => {
  const kinds = (g: Game) => {
    const seen: string[] = []
    for (let i = 0; i < 16; i++) {
      seen.push(g.active!.kind)
      g = step(g, ['hardDrop'], 0).game
      if (g.isOver) break
    }
    return seen.join('')
  }
  const plain = newGame('battle', 7)
  const hit = receiveGarbage(plain, 2)
  expect(hit.pendingGarbage[0]!.lines).toBe(2)
  expect(kinds(hit).slice(0, 8)).toBe(kinds(plain).slice(0, 8))
  expect(receiveGarbage(newGame('battle', 7), 2).pendingGarbage).toEqual(hit.pendingGarbage)
})

test('t-spin corner check at the top edge of the board does not throw', () => {
  // T rotation 2 spans board rows y+1..y+2 only, so y = -1 keeps every mino on the board.
  const g = mk({ 1: 'X.X.......', 2: '.X........' }, A('T', 2, 0, -1), { rotated: true })
  const r = step(g, ['hardDrop'], 0)
  expect(r.game.isOver).toBe(true)
  expect(types(r.events)).toContain('topOut')
})
