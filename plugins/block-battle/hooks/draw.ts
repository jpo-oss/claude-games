import { cellsOf, ghostY } from './engine'
import type { Active, Cell, Game, Kind } from './engine'

export const COLORS: Record<Kind | 'G', string> = {
  I: '#00e5ff',
  O: '#ffd400',
  T: '#b44cff',
  S: '#38d64a',
  Z: '#ff3b3b',
  J: '#3b6bff',
  L: '#ff9a1f',
  G: '#808080',
}

// The piece colour faded toward the dark board, so ghost and trail are solid blocks rather than
// shade characters, which most terminal fonts draw as a sparse, broken-looking dot pattern.
export function fade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number, bg: number) => Math.round(bg + (c - bg) * amount)
  const r = mix((n >> 16) & 255, 0x26)
  const g = mix((n >> 8) & 255, 0x26)
  const b = mix(n & 255, 0x26)

  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

export const CLEAR_MS = 250
export const FLASH_MS = 125
export const TRAIL_MS = 160
export const LABEL_MS = 1100
export const LEVEL_MS = 600
export const GARBAGE_MS = 350
export const FILL_ROW_MS = 35
// Past this the fill is full and the label is up: nothing about the game-over screen changes any more.
export const OVER_FINAL_MS = 700

export const overStep = (overMs: number, dtMs: number): number => (overMs > OVER_FINAL_MS ? overMs : overMs + dtMs)

export type Label = { text: string; color: string; age: number }
export type Fx = {
  clear: { rows: number[]; age: number } | null
  trail: { cols: number[]; from: number; to: number; kind: Kind; age: number } | null
  labels: Label[]
  levelUp: number | null
  garbage: { lines: number; age: number } | null
}
export const emptyFx = (): Fx => ({ clear: null, trail: null, labels: [], levelUp: null, garbage: null })

export type Style = { fg?: string; bg?: string; dim?: true; bold?: true; inverse?: true }
export type Ch = { c: string } & Style
export type Run = { text: string } & Style

const BOARD_H = 40
const VISIBLE = 20
export const FIELD_W = 10

// Layouts, widest first. A tier needs both numbers; below the last one the pane says it is too small.
// Columns: board column (1 garbage-bar column + framed board) + 1 gap + side column. Battle adds the opponent's board.
export type Tier = 'big' | 'medium' | 'mini' | 'tiny'
export const TIERS = {
  big: { cw: 4, ch: 2, columns: 66, rows: 44, side: 22 },
  medium: { cw: 2, ch: 1, columns: 48, rows: 25, side: 24 },
  mini: { cw: 2, ch: 1, columns: 32, rows: 22, side: 10 },
} as const
export const OPP_COLUMNS = 13
// 0 means the region has not been laid out yet (the first frame): draw the smallest thing that cannot overflow.
export function pickTier(columns: number, rows: number, isBattle: boolean): Tier {
  const extra = isBattle ? OPP_COLUMNS : 0
  for (const t of ['big', 'medium'] as const) if (columns >= TIERS[t].columns + extra && rows >= TIERS[t].rows) return t
  // mini without its side column still needs 21 wide
  if (columns >= 21 && rows >= TIERS.mini.rows) return 'mini'

  return 'tiny'
}

const same = (a: Style, b: Style) => a.fg === b.fg && a.bg === b.bg && a.dim === b.dim && a.bold === b.bold && a.inverse === b.inverse

export function runs(row: readonly Ch[]): Run[] {
  const out: Run[] = []
  let last: Ch | undefined
  for (const ch of row) {
    const { c, ...style } = ch
    if (last && same(last, ch)) out[out.length - 1]!.text += c
    else out.push({ text: c, ...style })
    last = ch
  }

  return out
}

const blocks = (text: string, style: Style): Ch[] => [...text].map(c => ({ c, ...style }))

// The engine collapses cleared rows at once; the flash needs them back where they were.
// New board = n empty rows on top + the survivors, so survivors + full rows at the old indices is the old board.
export function reconstruct(board: readonly (readonly Cell[])[], rows: readonly number[]): ((Cell | 'F')[])[] | null {
  const sorted = [...rows].sort((a, b) => a - b)
  if (sorted.length === 0 || sorted.some((r, i) => !Number.isInteger(r) || r < 0 || r >= BOARD_H || sorted[i - 1] === r)) return null
  const out: (Cell | 'F')[][] = board.slice(sorted.length).map(r => [...r])
  for (const r of sorted) out.splice(r, 0, new Array<'F'>(FIELD_W).fill('F'))

  return out.length === BOARD_H ? out : null
}

export type Line = { text: string; fg?: string; bold?: true; dim?: true; bg?: string }

// A framed box of text as characters: rounded border in `border`, one centred line per entry.
export function boxChars(lines: readonly Line[], width: number, border: string, bg: string): Ch[][] {
  const inner = Math.max(0, width - 2)
  const edge = { fg: border, bg }
  const rows: Ch[][] = [blocks('╭' + '─'.repeat(inner) + '╮', edge)]
  for (const l of lines) {
    const t = l.text.length > inner ? l.text.slice(0, inner) : l.text
    const left = Math.floor((inner - t.length) / 2)
    const style: Style = { bg: l.bg ?? bg, ...(l.fg ? { fg: l.fg } : {}), ...(l.bold ? { bold: true as const } : {}), ...(l.dim ? { dim: true as const } : {}) }
    rows.push([...blocks('│', edge), ...blocks(' '.repeat(left) + t + ' '.repeat(inner - left - t.length), style), ...blocks('│', edge)])
  }
  rows.push(blocks('╰' + '─'.repeat(inner) + '╯', edge))

  return rows
}

const POPUP_BG = '#0b0b12'

// The label as a bordered pill: lit solid when it pops in, plain while it lives, dim as it leaves.
export function labelBox(label: Label, width: number): Ch[][] {
  const w = Math.min(width, label.text.length + 4)
  const line: Line =
    label.age < 120 ? { text: label.text, fg: '#000000', bg: label.color, bold: true } : { text: label.text, fg: label.color, bold: true, ...(label.age > LABEL_MS * 0.6 ? { dim: true as const } : {}) }
  const box = boxChars([line], w, label.color, POPUP_BG)
  if (label.age > LABEL_MS * 0.6) for (const r of box) for (const c of r) c.dim = true

  return box
}

export type Overlay = { title: string; color: string; lines: readonly string[] }

export function overlayBox(o: Overlay, width: number): Ch[][] {
  const lines: Line[] = [{ text: '' }, { text: o.title, fg: o.color, bold: true }, { text: '' }, ...o.lines.map((text): Line => ({ text, fg: '#d0d0d8' })), { text: '' }]
  const w = Math.min(width, Math.max(...lines.map(l => l.text.length)) + 4)

  return boxChars(lines, w, o.color, POPUP_BG)
}

const EMPTY_A = '#14141b'
const EMPTY_B = '#191922'

type Spec = { k: 'solid'; color: string } | { k: 'empty'; x: number; y: number } | { k: 'flash'; color: string } | { k: 'thin' } | { k: 'gap' }

// One text row of one cell; solid cells are one flat colour in every size.
function rasterCell(s: Spec, cw: number, ch: number, r: number): Ch[] {
  if (s.k === 'solid') return blocks('█'.repeat(cw), { fg: s.color })
  if (s.k === 'flash') return blocks('█'.repeat(cw), { fg: s.color, bold: true })
  if (s.k === 'thin') return r === ch - 1 ? blocks('▂'.repeat(cw), { fg: '#ffffff', dim: true }) : blocks(' '.repeat(cw), {})
  if (s.k === 'gap') return blocks(' '.repeat(cw), {})

  return blocks(' '.repeat(cw), { bg: (s.x + s.y) % 2 === 0 ? EMPTY_A : EMPTY_B })
}

export type Size = { cw: number; ch: number }
export const COMPACT: Size = { cw: 2, ch: 1 }

// Stamp a box of characters onto the grid, clipped to it.
function stamp(rows: Ch[][], box: readonly Ch[][], x0: number, y0: number) {
  box.forEach((line, i) => {
    const row = rows[y0 + i]
    if (!row) return
    line.forEach((c, j) => {
      if (x0 + j >= 0 && x0 + j < row.length) row[x0 + j] = c
    })
  })
}

export function fieldRows(game: Game, fx: Fx, extra: readonly Label[], overMs: number, size: Size = COMPACT, overlay: Overlay | null = null): Ch[][] {
  const { cw, ch } = size
  let display: (Cell | 'F')[][] = game.board.map(r => [...r])
  if (fx.clear) display = reconstruct(game.board, fx.clear.rows) ?? display
  const clearAge = fx.clear?.age ?? 0
  const specs: Spec[][] = display.slice(BOARD_H - VISIBLE).map((r, y) =>
    r.map((cell, x): Spec => {
      if (cell === 'F') {
        if (clearAge < FLASH_MS) return { k: 'flash', color: Math.floor(clearAge / 40) % 2 === 0 ? '#ffffff' : '#9fe8ff' }
        if (clearAge < 190) return { k: 'thin' }

        return { k: 'gap' }
      }
      if (cell === null) return { k: 'empty', x, y }
      if (cell === 'G') {
        const isRising = fx.garbage && y >= VISIBLE - fx.garbage.lines && fx.garbage.age < GARBAGE_MS

        return { k: 'solid', color: isRising ? '#ff6b6b' : COLORS.G }
      }

      return { k: 'solid', color: COLORS[cell] }
    }),
  )
  const put = (x: number, y: number, color: string) => {
    const row = specs[y - (BOARD_H - VISIBLE)]
    if (row && x >= 0 && x < FIELD_W) row[x] = { k: 'solid', color }
  }
  const trail = () => {
    if (!fx.trail || fx.trail.age >= TRAIL_MS) return
    const { cols, from, to, kind } = fx.trail
    for (const x of cols) for (let y = from; y < to; y++) put(x, y, fade(COLORS[kind], 0.15))
  }

  if (game.active && !game.isOver) {
    const a: Active = game.active
    const gy = ghostY(game)
    if (gy !== null) for (const [x, y] of cellsOf({ ...a, y: gy })) put(x, y, fade(COLORS[a.kind], 0.28))
    trail()
    for (const [x, y] of cellsOf(a)) put(x, y, COLORS[a.kind])
  } else trail()

  // Game over: the pieces drain to their faded tint from the bottom up, and the board stays readable.
  if (overMs > 0) {
    const filled = Math.min(VISIBLE, Math.floor(overMs / FILL_ROW_MS))
    for (let y = VISIBLE - filled; y < VISIBLE; y++) {
      specs[y] = specs[y]!.map(s => (s.k === 'solid' ? { k: 'solid', color: fade(s.color, 0.3) } : s))
    }
  }

  const rows: Ch[][] = specs.flatMap(row => Array.from({ length: ch }, (_, r) => row.flatMap(s => rasterCell(s, cw, ch, r))))
  const width = FIELD_W * cw
  const pills = [...extra, ...[...fx.labels].reverse()].slice(0, 4)
  pills.forEach((label, i) => {
    const box = labelBox(label, width)
    stamp(rows, box, Math.floor((width - (box[0]?.length ?? 0)) / 2), 4 * ch + i * 3)
  })
  if (overlay) {
    const box = overlayBox(overlay, width)
    stamp(rows, box, Math.floor((width - (box[0]?.length ?? 0)) / 2), Math.floor((rows.length - box.length) / 2))
  }

  return rows
}

// A piece at rotation 0 centred in a `width`-wide block, two piece rows tall, in the given cell size.
export function previewRows(kind: Kind, size: Size, width: number, isDim = false): Ch[][] {
  const { cw, ch } = size
  const cells = cellsOf({ kind, rotation: 0, x: 0, y: 0 })
  const minX = Math.min(...cells.map(([x]) => x))
  const maxX = Math.max(...cells.map(([x]) => x))
  const minY = Math.min(...cells.map(([, y]) => y))
  const left = Math.floor((width - (maxX - minX + 1) * cw) / 2)
  const rows: Ch[][] = Array.from({ length: 2 * ch }, () => blocks(' '.repeat(width), {}))
  for (const [x, y] of cells) {
    for (let r = 0; r < ch; r++) {
      const row = rows[(y - minY) * ch + r]
      if (row) row.splice(left + (x - minX) * cw, cw, ...rasterCell({ k: 'solid', color: COLORS[kind] }, cw, ch, r).map(c => (isDim ? { ...c, dim: true as const } : c)))
    }
  }

  return rows
}

export const blankRows = (n: number, width: number): Ch[][] => Array.from({ length: n }, () => blocks(' '.repeat(width), {}))

const KINDS = 'IOTSZJL'

// One character per cell: the opponent's 20 x 10 visible board as the server relays it.
export function snapshotRows(snapshot: string): Ch[][] {
  const flat = [...snapshot.replace(/\s+/g, '')]
  const rows: Ch[][] = []
  for (let y = 0; y < VISIBLE; y++) {
    const row: Ch[] = []
    for (let x = 0; x < FIELD_W; x++) {
      const c = flat[y * FIELD_W + x] ?? '.'
      if (c === '.' || c === '0' || c === '-' || c === '_') row.push({ c: ' ', bg: (x + y) % 2 === 0 ? EMPTY_A : EMPTY_B })
      else row.push({ c: '█', fg: KINDS.includes(c) ? COLORS[c as Kind] : COLORS.G })
    }
    rows.push(row)
  }

  return rows
}

// Block-letter title, five rows of five-wide glyphs.
const FONT: Record<string, readonly string[]> = {
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
}
export const bigWord = (word: string): string[] => [0, 1, 2, 3, 4].map(r => [...word].map(c => FONT[c]![r]!).join(' '))
