// A rough text layout of a drawn tree, enough to check what lines up with what. It knows the Box
// and Text props the game uses and nothing more.
type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
type Block = string[]

const widthOf = (b: Block) => Math.max(0, ...b.map(l => [...l].length))
const pad = (l: string, w: number) => l + ' '.repeat(Math.max(0, w - [...l].length))
const spanOf = (node: unknown): string =>
  typeof node === 'string' ? node : node && typeof node === 'object' ? ((node as Node).children ?? []).map(spanOf).join('') : ''

function layout(node: unknown): Block {
  if (typeof node === 'string') return [node]
  if (!node || typeof node !== 'object') return []
  const n = node as Node
  const p = n.props ?? {}
  if (n.type === 'Text') return spanOf(n).split('\n')
  const isRow = p.flexDirection !== 'column'
  const gap = Number((isRow ? p.columnGap : p.rowGap) ?? p.gap ?? 0)
  const kids = (n.children ?? []).map(layout).filter(b => b.length > 0)
  const border = p.borderStyle ? 1 : 0
  const fixedW = typeof p.width === 'number' ? p.width - 2 * border : undefined
  const fixedH = typeof p.height === 'number' ? p.height - 2 * border : undefined
  let lines: Block
  if (isRow) {
    const h = Math.max(fixedH ?? 0, ...kids.map(k => k.length))
    const used = kids.reduce((a, k) => a + widthOf(k), 0)
    const spread = p.justifyContent === 'space-between' && fixedW !== undefined && kids.length > 1
    const between = spread ? Math.floor((fixedW! - used) / (kids.length - 1)) : gap
    const lead = p.justifyContent === 'center' && fixedW !== undefined ? Math.floor((fixedW - used - between * (kids.length - 1)) / 2) : 0
    lines = Array.from({ length: h }, () => ' '.repeat(Math.max(0, lead)))
    kids.forEach((k, i) => {
      const top = p.alignItems === 'center' ? Math.floor((h - k.length) / 2) : 0
      const w = widthOf(k)
      for (let y = 0; y < h; y++) lines[y] += pad(k[y - top] ?? '', w) + (i < kids.length - 1 ? ' '.repeat(between) : '')
    })
  } else {
    const w = fixedW ?? Math.max(0, ...kids.map(widthOf))
    lines = []
    kids.forEach((k, i) => {
      if (i > 0) for (let g = 0; g < gap; g++) lines.push('')
      const left = p.alignItems === 'center' ? Math.floor((w - widthOf(k)) / 2) : 0
      for (const l of k) lines.push(' '.repeat(Math.max(0, left)) + l)
    })
    if (fixedH !== undefined) {
      const top = p.justifyContent === 'center' ? Math.floor((fixedH - lines.length) / 2) : 0
      lines = [...Array(Math.max(0, top)).fill(''), ...lines]
      while (lines.length < fixedH) lines.push('')
    }
  }
  const w = fixedW ?? widthOf(lines)
  lines = lines.map(l => pad(l, w))
  if (!border) return lines

  return [`╭${'─'.repeat(w)}╮`, ...lines.map(l => `│${l}│`), `╰${'─'.repeat(w)}╯`]
}

export const screen = (tree: unknown): string[] => layout(tree).map(l => l.trimEnd())
