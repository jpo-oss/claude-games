// A small flex-layout flattener for a drawn tree: rows of characters, enough to check alignment.
// Not a terminal: no colours, no wrapping; Text is one line, Box is row or column with border, padding, gap, width.
type Node = string | { type: string; props?: Record<string, string | number | boolean>; children?: Node[] }
type N = { type: 'Box' | 'Text'; props: Record<string, string | number | boolean>; children: Node[] }

const norm = (n: Node): N => (typeof n === 'string' ? { type: 'Text', props: {}, children: [n] } : { type: n.type === 'Text' ? 'Text' : 'Box', props: n.props ?? {}, children: n.children ?? [] })
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const textOf = (n: Node): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

type Insets = { l: number; r: number; t: number; b: number }
function pad(p: N['props']): Insets {
  const px = num(p.paddingX ?? p.padding)
  const py = num(p.paddingY ?? p.padding)
  const bd = p.borderStyle ? 1 : 0

  return { l: num(p.paddingLeft ?? px) + bd, r: num(p.paddingRight ?? px) + bd, t: num(p.paddingTop ?? py) + bd, b: num(p.paddingBottom ?? py) + bd }
}
function mar(p: N['props']): Insets {
  const mx = num(p.marginX ?? p.margin)
  const my = num(p.marginY ?? p.margin)

  return { l: num(p.marginLeft ?? mx), r: num(p.marginRight ?? mx), t: num(p.marginTop ?? my), b: num(p.marginBottom ?? my) }
}

export function size(node: Node): { w: number; h: number } {
  const n = norm(node)
  if (n.type === 'Text') return { w: textOf(node).length, h: 1 }
  const p = pad(n.props)
  const m = mar(n.props)
  const kids = n.children.map(size)
  const gap = num(n.props.gap)
  const row = (n.props.flexDirection ?? 'row') === 'row'
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0) + Math.max(0, xs.length - 1) * gap
  const kw = kids.map((k, i) => k.w + marX(n.children[i]!))
  const kh = kids.map((k, i) => k.h + marY(n.children[i]!))
  const cw = row ? sum(kw) : Math.max(0, ...kw)
  const ch = row ? Math.max(0, ...kh) : sum(kh)
  const w = typeof n.props.width === 'number' ? n.props.width : cw + p.l + p.r
  const h = typeof n.props.height === 'number' ? n.props.height : ch + p.t + p.b

  return { w: w + 0 * m.l, h }
}
const marX = (c: Node) => (typeof c === 'string' ? 0 : mar(norm(c).props).l + mar(norm(c).props).r)
const marY = (c: Node) => (typeof c === 'string' ? 0 : mar(norm(c).props).t + mar(norm(c).props).b)

function put(grid: string[][], x: number, y: number, s: string, clip: { w: number; h: number }) {
  if (y < 0 || y >= grid.length) return
  ;[...s].forEach((c, i) => {
    if (x + i >= 0 && x + i < (grid[y]?.length ?? 0) && x + i < clip.w) grid[y]![x + i] = c
  })
}

function paint(node: Node, grid: string[][], x: number, y: number, w: number, h: number) {
  const n = norm(node)
  if (n.type === 'Text') {
    put(grid, x, y, textOf(node), { w: x + w, h })

    return
  }
  const p = pad(n.props)
  if (n.props.borderStyle) {
    put(grid, x, y, '╭' + '─'.repeat(Math.max(0, w - 2)) + '╮', { w: x + w, h })
    for (let i = 1; i < h - 1; i++) {
      put(grid, x, y + i, '│', { w: x + w, h })
      put(grid, x + w - 1, y + i, '│', { w: x + w, h })
    }
    put(grid, x, y + h - 1, '╰' + '─'.repeat(Math.max(0, w - 2)) + '╯', { w: x + w, h })
  }
  const ix = x + p.l
  const iy = y + p.t
  const iw = w - p.l - p.r
  const ih = h - p.t - p.b
  const row = (n.props.flexDirection ?? 'row') === 'row'
  const gap = num(n.props.gap)
  const align = (n.props.alignItems as string | undefined) ?? 'stretch'
  const justify = (n.props.justifyContent as string | undefined) ?? 'flex-start'
  const kids = n.children
  const sz = kids.map(size)
  const main = kids.map((_, i) => (row ? sz[i]!.w + marX(kids[i]!) : sz[i]!.h + marY(kids[i]!)))
  const total = main.reduce((a, b) => a + b, 0) + Math.max(0, kids.length - 1) * gap
  const free = Math.max(0, (row ? iw : ih) - total)
  let pos = justify === 'center' ? Math.floor(free / 2) : justify === 'flex-end' ? free : 0
  const between = justify === 'space-between' && kids.length > 1 ? free / (kids.length - 1) : 0
  kids.forEach((k, i) => {
    const kn = norm(k)
    const m = mar(kn.props)
    const isBox = kn.type === 'Box'
    const crossAvail = row ? ih : iw
    const crossNat = row ? sz[i]!.h : sz[i]!.w
    const explicit = row ? kn.props.height : kn.props.width
    const crossSize = align === 'stretch' && isBox && explicit === undefined ? crossAvail - (row ? m.t + m.b : m.l + m.r) : align === 'stretch' && !isBox ? crossAvail : crossNat
    const crossOff = align === 'center' ? Math.floor((crossAvail - crossSize) / 2) : align === 'flex-end' ? crossAvail - crossSize : 0
    const mainSize = row ? sz[i]!.w : sz[i]!.h
    const kx = row ? ix + Math.round(pos) + m.l : ix + crossOff + m.l
    const ky = row ? iy + crossOff + m.t : iy + Math.round(pos) + m.t
    paint(k, grid, kx, ky, row ? mainSize : crossSize, row ? crossSize : mainSize)
    pos += main[i]! + gap + between
  })
}

// The tree laid out in a `columns` x `rows` region, as lines of text; trailing blanks trimmed.
export function flatten(treeIn: unknown, columns: number, rows: number): string[] {
  const tree = treeIn as Node
  const grid = Array.from({ length: rows }, () => new Array<string>(columns).fill(' '))
  const s = size(tree)
  // a Box root fills the region's width, as the surface lays it out
  paint(tree, grid, 0, 0, typeof tree !== 'string' && tree.type === 'Box' ? columns : Math.min(columns, s.w), s.h)
  const lines = grid.map(r => r.join('').replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines
}

// The tree's natural size: what it would take if the region let it.
export const natural = (tree: unknown) => size(tree as Node)
