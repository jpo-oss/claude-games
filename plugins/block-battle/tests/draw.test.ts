import { expect, test } from 'claude-code/testing'

import { COLORS, COMPACT, bigWord, emptyFx, fade, fieldRows, overStep, pickTier, previewRows, reconstruct, runs, snapshotRows } from '../hooks/draw'
import type { Ch, Size } from '../hooks/draw'
import { newGame } from '../hooks/engine'
import type { Cell } from '../hooks/engine'

const BIG: Size = { cw: 4, ch: 2 }
const empty = (): Cell[] => new Array<Cell>(10).fill(null)
const text = (row: Ch[]) => row.map(c => c.c).join('')

// A calm game with nothing falling, so only what the test puts on the board is drawn.
function still() {
  const game = newGame('marathon', 1)

  return { ...game, active: null }
}

test('reconstruct puts cleared rows back where they were', () => {
  // Before the clear: rows 36-38 full, row 35 held an I at column 5, row 39 a T at column 0.
  // After the engine collapses: 3 empty rows on top, row 38 is the old 35, row 39 the old 39.
  const board = Array.from({ length: 40 }, empty)
  board[38]![5] = 'I'
  board[39]![0] = 'T'
  const before = reconstruct(board, [36, 37, 38])!
  expect(before).toHaveLength(40)
  expect(before[35]![5]).toBe('I')
  expect(before[36]).toEqual(new Array(10).fill('F'))
  expect(before[37]).toEqual(new Array(10).fill('F'))
  expect(before[38]).toEqual(new Array(10).fill('F'))
  expect(before[39]![0]).toBe('T')
  expect(before[38]![5]).toBe('F')
})

test('reconstruct refuses rows that cannot be real', () => {
  const board = Array.from({ length: 40 }, empty)
  expect(reconstruct(board, [])).toBe(null)
  expect(reconstruct(board, [40])).toBe(null)
  expect(reconstruct(board, [3, 3])).toBe(null)
})

test('line clear: white flash, then thin rows, then a gap', () => {
  const game = still()
  const board = Array.from({ length: 40 }, empty)
  board[39]![0] = 'T'
  const g = { ...game, board }
  const fx = (age: number) => ({ ...emptyFx(), clear: { rows: [37, 38], age } })
  // rows 37 and 38 cleared: visible rows 17 and 18
  const flash = fieldRows(g, fx(0), [], 0)
  expect(text(flash[17]!)).toBe('█'.repeat(20))
  expect(flash[17]![0]).toEqual({ c: '█', fg: '#ffffff', bold: true })
  expect(fieldRows(g, fx(60), [], 0)[17]![0]).toEqual({ c: '█', fg: '#9fe8ff', bold: true })
  expect(text(fieldRows(g, fx(130), [], 0)[17]!)).toBe('▂'.repeat(20))
  expect(text(fieldRows(g, fx(200), [], 0)[17]!)).toBe(' '.repeat(20))
})

test('a popping label is a centred bordered pill and fades', () => {
  const g = still()
  const label = (age: number) => [{ text: 'TETRIS', color: '#00e5ff', age }]
  const rows = (age: number) => fieldRows(g, { ...emptyFx(), labels: label(age) }, [], 0)
  // compact: pills start on row 4, three rows tall, 10 wide in a 20 wide board
  expect(text(rows(50)[4]!).slice(5, 15)).toBe('╭────────╮')
  expect(text(rows(50)[5]!).slice(5, 15)).toBe('│ TETRIS │')
  expect(text(rows(50)[6]!).slice(5, 15)).toBe('╰────────╯')
  expect(rows(50)[5]![7]).toEqual({ c: 'T', bg: '#00e5ff', fg: '#000000', bold: true })
  expect(rows(300)[5]![7]).toEqual({ c: 'T', bg: '#0b0b12', fg: '#00e5ff', bold: true })
  expect(rows(900)[5]![7]).toEqual({ c: 'T', bg: '#0b0b12', fg: '#00e5ff', bold: true, dim: true })
  // a long name still fits the board
  const long = fieldRows(g, { ...emptyFx(), labels: [{ text: 'T-SPIN MINI DOUBLE', color: '#b44cff', age: 300 }] }, [], 0)
  expect(text(long[5]!)).toBe('│T-SPIN MINI DOUBLE│')
})

test('garbage rising tints the bottom rows, then settles to grey', () => {
  const game = still()
  const board = Array.from({ length: 40 }, empty)
  board[39] = new Array<Cell>(10).fill('G')
  const g = { ...game, board }
  const rising = fieldRows(g, { ...emptyFx(), garbage: { lines: 1, age: 100 } }, [], 0)[19]!
  expect(rising[0]!.fg).toBe('#ff6b6b')
  expect(fieldRows(g, { ...emptyFx(), garbage: { lines: 1, age: 400 } }, [], 0)[19]![0]!.fg).toBe('#808080')
  expect(fieldRows(g, emptyFx(), [], 0)[19]![0]!.fg).toBe('#808080')
})

test('game over: pieces fade to their tint from the bottom, one row per 35 ms, and never use shade characters', () => {
  const board = Array.from({ length: 40 }, empty)
  for (const y of [36, 37, 38, 39]) board[y]![2] = 'T'
  const g = { ...still(), board }
  const at = (ms: number, y: number) => fieldRows(g, emptyFx(), [], ms)[y]![4]!
  expect(at(0, 19).fg).toBe(COLORS.T)
  expect(at(35 * 3, 19).fg).toBe(fade(COLORS.T, 0.3))
  expect(at(35 * 3, 17).fg).toBe(fade(COLORS.T, 0.3))
  expect(at(35 * 3, 16).fg).toBe(COLORS.T)
  const all = fieldRows(g, emptyFx(), [], 5_000, BIG, { title: 'GAME OVER', color: '#ff3b3b', lines: ['SCORE 12', '', 'r restart  q menu'] }).map(text).join('')
  expect(all).not.toMatch(/[▒░]/)
})

test('game over overlay: a closed bordered box centred on the board', () => {
  const o = { title: 'GAME OVER', color: '#ff3b3b', lines: ['SCORE 1234', '', 'r restart  q menu'] }
  for (const size of [COMPACT, BIG]) {
    const rows = fieldRows(still(), emptyFx(), [], 5_000, size, o)
    const lines = rows.map(text)
    const top = lines.findIndex(l => l.includes('╭'))
    const bottom = lines.findIndex(l => l.includes('╰'))
    expect(lines.filter(l => l.includes('╭'))).toHaveLength(1)
    // 2 border rows + blank, title, blank, 3 lines, blank
    expect(bottom - top + 1).toBe(9)
    // vertically centred, and every line of the box starts and ends on the same columns
    expect(Math.abs(top + bottom + 1 - rows.length)).toBeLessThanOrEqual(1)
    const left = lines[top]!.indexOf('╭')
    const right = lines[top]!.indexOf('╮')
    expect(Math.abs(left + right + 1 - size.cw * 10)).toBeLessThanOrEqual(1)
    for (let y = top + 1; y < bottom; y++) {
      expect(lines[y]![left]).toBe('│')
      expect(lines[y]![right]).toBe('│')
    }
    expect(lines.join('\n')).toContain('GAME OVER')
    expect(lines.join('\n')).toContain('r restart  q menu')
  }
})

test('big cells are 4 x 2 in one flat colour; compact cells are 2 x 1', () => {
  const board = Array.from({ length: 40 }, empty)
  board[39]![0] = 'T'
  const g = { ...still(), board }
  const big = fieldRows(g, emptyFx(), [], 0, BIG)
  expect(big).toHaveLength(40)
  expect(big[0]).toHaveLength(40)
  expect(text(big[38]!).slice(0, 4)).toBe('████')
  expect(big[38]![0]!.fg).toBe(COLORS.T)
  expect(big[39]![0]!.fg).toBe(COLORS.T)
  const small = fieldRows(g, emptyFx(), [], 0)
  expect(small).toHaveLength(20)
  expect(small[19]).toHaveLength(20)
  expect(small[19]![0]!.fg).toBe(COLORS.T)
})

test('empty cells are a solid two-tone checker, not dots or shades', () => {
  const row = fieldRows(still(), emptyFx(), [], 0)[0]!
  expect(text(row)).toBe(' '.repeat(20))
  expect(row[0]!.bg).not.toBe(row[2]!.bg)
  expect(row[0]!.bg).toBe(row[4]!.bg)
})

test('layout tier follows the region and the battle column', () => {
  expect(pickTier(66, 46, false)).toBe('big')
  expect(pickTier(66, 43, false)).toBe('medium')
  expect(pickTier(65, 60, false)).toBe('medium')
  expect(pickTier(48, 25, false)).toBe('medium')
  expect(pickTier(47, 25, false)).toBe('mini')
  expect(pickTier(48, 21, false)).toBe('tiny')
  expect(pickTier(66, 46, true)).toBe('medium')
  expect(pickTier(79, 46, true)).toBe('big')
  expect(pickTier(21, 22, false)).toBe('mini')
  expect(pickTier(20, 40, false)).toBe('tiny')
  expect(pickTier(0, 0, false)).toBe('tiny')
})

test('a preview centres the piece in its block', () => {
  const rows = previewRows('O', COMPACT, 12)
  expect(rows.map(text)).toEqual(['    ████    ', '    ████    '])
  const i = previewRows('I', BIG, 20)
  expect(i).toHaveLength(4)
  expect(text(i[0]!)).toBe('  ' + '█'.repeat(16) + '  ')
})

test('the block title is five rows of equal width', () => {
  for (const w of ['JPO', 'TETRIS']) {
    const rows = bigWord(w)
    expect(rows).toHaveLength(5)
    expect(new Set(rows.map(r => r.length)).size).toBe(1)
    expect(rows[0]!.length).toBe(w.length * 6 - 1)
  }
})

test('runs merge neighbours with the same style', () => {
  const row: Ch[] = [{ c: 'a', fg: 'x' }, { c: 'b', fg: 'x' }, { c: 'c' }]
  expect(runs(row)).toEqual([{ text: 'ab', fg: 'x' }, { text: 'c' }])
})

test('the opponent snapshot reads 20 rows of 10 as the server relays it', () => {
  const snap = '.'.repeat(190) + 'GGGG.....I'
  const rows = snapshotRows(snap)
  expect(rows).toHaveLength(20)
  expect(rows[19]!.map(c => c.c).join('')).toBe('████     █')
  expect(rows[19]![0]!.fg).toBe('#808080')
  expect(rows[19]![9]!.fg).toBe('#00e5ff')
})

test('game over: the animation clock advances until 700 ms, then holds so the screen stops changing', () => {
  expect(overStep(0, 16)).toBe(16)
  expect(overStep(690, 16)).toBe(706)
  expect(overStep(706, 16)).toBe(706)
  expect(overStep(5_000, 16)).toBe(5_000)
  const g = newGame('marathon', 3)
  expect(fieldRows(g, emptyFx(), [], 706)).toEqual(fieldRows(g, emptyFx(), [], 5_000))
})
