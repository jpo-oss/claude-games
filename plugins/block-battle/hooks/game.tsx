import type { ClientModule, ClientSurface, RenderChildren } from 'claude-code'

import type { ClientMsg, GameView } from '../types'
import { CLEAR_MS, COMPACT, FIELD_W, GARBAGE_MS, LABEL_MS, LEVEL_MS, OVER_FINAL_MS, TIERS, TRAIL_MS, bigWord, blankRows, emptyFx, fieldRows, overStep, pickTier, previewRows, runs, snapshotRows } from './draw'
import type { Ch, Fx, Label, Overlay, Size } from './draw'
import { newGame, receiveGarbage, snapshot, step } from './engine'
import type { Game, GameEvent, Input, Mode } from './engine'
import { STEP_MS, chunkAt, newPace, newRecorder, newSender, nextSend, recordGarbage, recordStep, stepsDue, toUpload } from './log'
import type { LogMsg, Pace, Recorder, Sender, Upload } from './log'
import { serverUrlOk } from './net'

// Rows per down press; tuned by feel (1 was too slow). A step stops at the floor, so more never locks.
const SOFT_DROP_ROWS = 2
const SYNC_MS = 200
const START_WAIT_MS = 3_000

type Screen = 'menu' | 'servers' | 'lobby' | 'play' | 'leaderboard' | 'starting'

// Everything mutable lives here, so the 16 ms tick changes it in place and asks for a redraw only when
// something visible moved. `rev` is what setState carries to make the engine call the module again.
type Live = {
  props: GameView
  rev: number
  screen: Screen
  menu: number
  mode: Mode
  game: Game | null
  inputs: Input[]
  t: number
  pace: Pace
  rec: Recorder
  gameId: string | null
  nonce: number
  waitMs: number
  waitAt: number
  uploads: Upload[]
  sender: Sender
  hasSentLog: boolean
  isPaused: boolean
  fx: Fx
  overMs: number
  // How many of the room's incoming attacks were taken; the list only grows.
  applied: number
  outbox: ClientMsg[]
  attacks: number[]
  syncMs: number
  seq: number
  roomId: string | null
  hasPostedOver: boolean
  result: 'win' | 'loss' | null
  isDirty: boolean
  hasKeyed: boolean
  pick: number
  // The address being typed on the server screen, or null while choosing from the list.
  typing: string | null
  typeError: string | null
}

const MENU = [
  { label: 'Marathon', hint: 'solo, endless levels' },
  { label: 'Battle', hint: 'online 1v1' },
  { label: 'Leaderboard', hint: 'top 5' },
] as const

const emptyProps = (): GameView => ({
  me: null,
  leaderboard: null,
  notice: null,
  battle: { status: 'idle', roomId: null, seed: 0, opponent: null, incoming: [], result: null },
  servers: { home: '', isHomeOfficial: true, last: null, active: '' },
  marathon: null,
  uploaded: null,
})

const newLive = (props: GameView): Live => ({
  props, rev: 0, screen: 'menu', menu: 0, mode: 'marathon', game: null, inputs: [], t: 0,
  pace: newPace(0), rec: newRecorder(), gameId: null, nonce: 0, waitMs: 0, waitAt: 0, uploads: [], sender: newSender(), hasSentLog: false,
  isPaused: false, fx: emptyFx(), overMs: 0, applied: 0, outbox: [], attacks: [], syncMs: 0, seq: 0, roomId: null,
  hasPostedOver: false, result: null, isDirty: true, hasKeyed: false, pick: 0, typing: null, typeError: null,
})

const CLEAR_NAMES: Record<string, string> = {
  single: 'SINGLE', double: 'DOUBLE', triple: 'TRIPLE', quad: 'QUAD',
  tspinMini: 'T-SPIN MINI', tspinMiniSingle: 'T-SPIN MINI SINGLE', tspinMiniDouble: 'T-SPIN MINI DOUBLE',
  tspin: 'T-SPIN', tspinSingle: 'T-SPIN SINGLE', tspinDouble: 'T-SPIN DOUBLE', tspinTriple: 'T-SPIN TRIPLE',
}

function pushLabel(fx: Fx, text: string, color: string) {
  fx.labels = [...fx.labels, { text, color, age: 0 }].slice(-3)
}

function applyEvents(live: Live, before: Game, events: readonly GameEvent[]) {
  const { fx } = live
  for (const ev of events) {
    if (ev.type === 'lineClear') {
      fx.clear = { rows: ev.rows, age: 0 }
      if (ev.perfectClear) pushLabel(fx, 'PERFECT CLEAR', '#ffffff')
      pushLabel(fx, CLEAR_NAMES[ev.kind] ?? String(ev.kind).toUpperCase(), ev.kind === 'quad' ? '#00e5ff' : ev.kind.startsWith('tspin') ? '#b44cff' : '#ffd400')
      if (ev.b2b) pushLabel(fx, 'BACK-TO-BACK', '#ff9a1f')
      if (ev.combo >= 1) pushLabel(fx, `COMBO x${ev.combo}`, '#38d64a')
      if (live.mode === 'battle' && ev.attack > 0) live.attacks.push(ev.attack)
    } else if (ev.type === 'hardDrop') {
      const kind = before.active?.kind
      if (kind && Array.isArray(ev.columns)) fx.trail = { cols: ev.columns, from: ev.from, to: ev.to, kind, age: 0 }
    } else if (ev.type === 'garbageIn') {
      fx.garbage = { lines: ev.lines, age: 0 }
    } else if (ev.type === 'levelUp') {
      fx.levelUp = 0
      pushLabel(fx, `LEVEL ${ev.level}`, '#ffd400')
    }
  }
}

function ageFx(fx: Fx, dt: number): boolean {
  let isLive = false
  const grow = <T extends { age: number }>(x: T | null, limit: number): T | null => {
    if (!x) return null
    const next = { ...x, age: x.age + dt }
    isLive = true

    return next.age >= limit ? null : next
  }
  fx.clear = grow(fx.clear, CLEAR_MS)
  fx.trail = grow(fx.trail, TRAIL_MS)
  fx.garbage = grow(fx.garbage, GARBAGE_MS)
  if (fx.levelUp !== null) {
    isLive = true
    fx.levelUp += dt
    if (fx.levelUp >= LEVEL_MS) fx.levelUp = null
  }
  if (fx.labels.length > 0) {
    isLive = true
    fx.labels = fx.labels.map(l => ({ ...l, age: l.age + dt })).filter(l => l.age < LABEL_MS)
  }

  return isLive
}

function startGame(live: Live, mode: Mode, seed: number) {
  live.screen = 'play'
  live.mode = mode
  live.game = newGame(mode, seed)
  live.inputs = []
  live.isPaused = false
  live.fx = emptyFx()
  live.overMs = 0
  live.attacks = []
  live.syncMs = 0
  live.hasPostedOver = false
  live.result = null
  live.pace = newPace(performance.now())
  live.rec = newRecorder()
  live.hasSentLog = false
  live.isDirty = true
}

const randomSeed = () => Math.floor(Math.random() * 0x100000000)

function askMarathon(live: Live) {
  live.screen = 'starting'
  live.nonce++
  live.waitMs = 0
  live.waitAt = performance.now()
  live.outbox.push({ type: 'menu', choice: 'marathon', nonce: live.nonce })
  live.isDirty = true
}

function queueUpload(live: Live, kind: 'marathon' | 'battle') {
  const key = kind === 'marathon' ? live.gameId : live.roomId
  if (key === null) return
  const u = toUpload(kind, key, live.rec)
  if (u) live.uploads.push(u)
}

// One chunk at a time: the next goes when the hooks' acknowledged position moves, or again after a
// pause if it did not. Done once the hooks hold the whole stream for its key, or dropped if they never move.
function nextChunk(live: Live): LogMsg | null {
  const u = live.uploads[0]
  if (!u) return null
  const ack = live.props.uploaded
  const isAcked = ack !== null && ack.key === u.key
  const have = isAcked ? ack.have : 0
  const next = isAcked && have >= u.stream.length ? 'drop' : nextSend(live.sender, have)
  if (next === 'drop') {
    live.uploads.shift()
    live.sender = newSender()
    return nextChunk(live)
  }
  return next === 'send' ? chunkAt(u, have) : null
}

function leave(live: Live) {
  if (live.mode === 'marathon' && live.game && !live.game.isOver) queueUpload(live, 'marathon')
  live.screen = 'menu'
  live.game = null
  live.result = null
  live.outbox.push({ type: 'menu', choice: 'back' })
  live.isDirty = true
}

type ServerChoice = { label: string; url: string | null }

function serverChoices(live: Live): ServerChoice[] {
  const { home, isHomeOfficial, last } = live.props.servers
  const list: ServerChoice[] = [
    { label: isHomeOfficial ? 'Official server' : `Your server  ${hostOf(home)}`, url: home },
    { label: 'Enter a server address...', url: null },
  ]
  if (last && last !== home) list.push({ label: `${hostOf(last)}  (last used)`, url: last })

  return list
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function playOn(live: Live, server: string) {
  live.screen = 'lobby'
  live.typing = null
  live.outbox.push({ type: 'menu', choice: 'battle', server: server.replace(/\/+$/, '') })
}

function onServerKey(live: Live, key: string) {
  if (live.typing !== null) {
    if (key === 'return') {
      const url = live.typing.trim()
      if (serverUrlOk(url)) playOn(live, url)
      else live.typeError = 'The address must start with https://'
    } else if (key === 'backspace' || key === 'delete') live.typing = live.typing.slice(0, -1)
    else if (key === 'up' || key === 'down') live.typing = null
    else if (key.length === 1 && key >= ' ' && live.typing.length < 200) live.typing += key
    if (key !== 'return') live.typeError = null

    return
  }
  const choices = serverChoices(live)
  const k = key.length === 1 && key !== ' ' ? key.toLowerCase() : key
  if (k === 'up' || k === 'k') live.pick = (live.pick + choices.length - 1) % choices.length
  else if (k === 'down' || k === 'j') live.pick = (live.pick + 1) % choices.length
  else if (k === 'q') live.screen = 'menu'
  else if (k === 'return' || k === ' ') {
    const c = choices[live.pick]!
    if (c.url === null) live.typing = ''
    else playOn(live, c.url)
  }
}

function onKey(live: Live, key: string) {
  live.hasKeyed = true
  const k = key.length === 1 && key !== ' ' ? key.toLowerCase() : key
  if (live.screen === 'menu') {
    if (k === 'up' || k === 'k') live.menu = (live.menu + MENU.length - 1) % MENU.length
    else if (k === 'down' || k === 'j') live.menu = (live.menu + 1) % MENU.length
    else if (k === 'return' || k === ' ') {
      if (live.menu === 0) askMarathon(live)
      else if (live.menu === 1) {
        live.screen = 'servers'
        live.pick = 0
        live.typing = null
        live.typeError = null
      } else {
        live.screen = 'leaderboard'
        live.outbox.push({ type: 'menu', choice: 'leaderboard' })
      }
    }
    live.isDirty = true

    return
  }
  if (live.screen === 'servers') {
    onServerKey(live, key)
    live.isDirty = true

    return
  }
  if (live.screen === 'lobby' || live.screen === 'leaderboard' || live.screen === 'starting') {
    if (k === 'q' || (k === 'return' && live.screen !== 'starting')) leave(live)
    else if (k === 'r' && live.screen === 'leaderboard') live.outbox.push({ type: 'menu', choice: 'leaderboard' })
    live.isDirty = true

    return
  }
  if (k === 'q') return leave(live)
  const game = live.game
  if (!game) return
  if (game.isOver || live.result) {
    if (k === 'r' && live.mode === 'marathon') askMarathon(live)

    return
  }
  if (k === 'p' && live.mode === 'marathon') {
    live.isPaused = !live.isPaused
    live.pace = newPace(performance.now(), live.pace.ran)
    live.isDirty = true

    return
  }
  if (live.isPaused) return
  if (k === 'left') live.inputs.push('left')
  else if (k === 'right') live.inputs.push('right')
  // SOFT_DROP_ROWS per press: a terminal sends no key-up, so a held soft drop could not be told apart
  // from a tap and would slam the piece down. Holding the key rides the keyboard's own repeat.
  else if (k === 'down') for (let i = 0; i < SOFT_DROP_ROWS; i++) live.inputs.push('softDropStep')
  else if (k === 'up' || k === 'x') live.inputs.push('rotateCW')
  else if (k === 'z') live.inputs.push('rotateCCW')
  else if (k === 'a') live.inputs.push('rotate180')
  else if (k === ' ' || k === 'space') live.inputs.push('hardDrop')
  else if (k === 'c') live.inputs.push('hold')
}

function tick(live: Live) {
  const p = live.props
  if (live.screen === 'lobby' && p.battle.status === 'matched' && p.battle.roomId !== null && p.battle.roomId !== live.roomId) {
    live.roomId = p.battle.roomId
    live.applied = 0
    live.gameId = null
    startGame(live, 'battle', p.battle.seed)
  }
  if (live.screen === 'starting') {
    live.waitMs += STEP_MS
    const m = p.marathon
    if (m && m.nonce === live.nonce) {
      live.gameId = m.gameId
      startGame(live, 'marathon', m.gameId === null ? randomSeed() : m.seed)
    } else if (Math.max(live.waitMs, performance.now() - live.waitAt) >= START_WAIT_MS) {
      live.gameId = null
      startGame(live, 'marathon', randomSeed())
    }
  }
  if (live.screen === 'play' && live.mode === 'battle' && live.roomId !== null && p.battle.status === 'idle') {
    // The server dropped the match under us: back to the lobby, where the notice is shown.
    live.screen = 'lobby'
    live.game = null
    live.result = null
    live.roomId = null
    live.isDirty = true
  }
  const n = live.screen === 'play' && !live.isPaused ? stepsDue(live.pace, performance.now()) : 1
  const dt = n * STEP_MS
  live.t += dt
  if (live.screen === 'starting' && live.t % 320 < STEP_MS) live.isDirty = true
  let dirty = live.isDirty
  const game = live.game
  if (live.screen === 'play' && game) {
    if (live.mode === 'battle' && live.roomId === p.battle.roomId) {
      let g = game
      if (!g.isOver && !live.result) {
        const { incoming } = p.battle
        for (; live.applied < incoming.length; live.applied++) {
          const inc = incoming[live.applied]!
          recordGarbage(live.rec, inc.id)
          g = receiveGarbage(g, inc.lines)
          dirty = true
        }
      }
      live.game = g
      if (p.battle.result && !live.result) {
        live.result = p.battle.result
        dirty = true
      }
      if (live.result && !live.hasSentLog) {
        live.hasSentLog = true
        queueUpload(live, 'battle')
      }
    }
    if (n > 0 && !live.isPaused && !live.game!.isOver && !live.result) {
      let inputs = live.inputs
      live.inputs = []
      let g = live.game!
      const a = g.active
      let moved = inputs.length > 0
      // A full recorder freezes the board: nothing past it could be verified.
      for (let i = 0; i < n && !g.isOver && !live.rec.isFull; i++) {
        const counted = live.rec.steps
        recordStep(live.rec, inputs)
        if (live.rec.steps === counted) break
        const r = step(g, inputs, STEP_MS)
        applyEvents(live, g, r.events)
        if (r.events.length > 0) moved = true
        g = r.game
        inputs = []
      }
      live.game = g
      const b = g.active
      if (moved || a?.x !== b?.x || a?.y !== b?.y || a?.rotation !== b?.rotation || a?.kind !== b?.kind) dirty = true
    }
    const now = live.game!
    if (now.isOver || live.result) {
      const next = overStep(live.overMs, dt)
      if (next !== live.overMs) dirty = true
      live.overMs = next
    }
    if (ageFx(live.fx, dt)) dirty = true

    if (now.isOver && !live.hasPostedOver && live.mode === 'marathon') queueUpload(live, 'marathon')
    // The top-out is posted again until a result comes: one lost post must not leave the hooks unaware.
    if (live.mode === 'battle' && !live.result) {
      live.syncMs += dt
      if (live.syncMs >= SYNC_MS || (now.isOver && !live.hasPostedOver)) {
        live.syncMs = 0
        live.outbox.push({ type: 'sync', seq: ++live.seq, attacks: live.attacks.splice(0), snapshot: snapshot(now), isOver: now.isOver })
      }
    }
    if (now.isOver) live.hasPostedOver = true
  } else if (live.screen === 'lobby') {
    if (live.t % 320 < dt) dirty = true
  }

  live.isDirty = false

  return dirty
}

type Shell = { live: Live; rev: number }
type Surf = ClientSurface<Shell>

const FRAME = '#6a6a8c'
const PANEL = '#4a4a66'
const TITLE = '#9a9ab8'
const BIG: Size = { cw: 4, ch: 2 }

function gridEl(rows: Ch[][], surface: Surf) {
  const { Box, Text } = surface.elements

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box flexDirection="row">
          {runs(row).map(r => (
            <Text color={r.fg} backgroundColor={r.bg} dimColor={r.dim} bold={r.bold} inverse={r.inverse}>
              {r.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// A rounded panel `width` columns wide (border included).
function panel(surface: Surf, width: number, color: string, children: RenderChildren) {
  const { Box } = surface.elements

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={color}>
      {children}
    </Box>
  )
}

function bar(surface: Surf, fraction: number, width: number) {
  const { Box, Text } = surface.elements
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))

  return (
    <Box flexDirection="row">
      <Text color="#00e5ff">{'█'.repeat(filled)}</Text>
      <Text color="#2c2c40">{'█'.repeat(width - filled)}</Text>
    </Box>
  )
}

function kv(surface: Surf, width: number, label: string, value: string, color?: string) {
  const { Box, Text } = surface.elements

  return (
    <Box width={width} justifyContent="space-between">
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{value}</Text>
    </Box>
  )
}

const HELP_BIG = ['arrows  move', 'up/x    rotate', 'z ccw   a 180', 'space   hard drop', 'c hold  p pause', 'q menu']
const HELP_MEDIUM = ['arrows move up/x turn', 'z ccw a 180 spc drop', 'c hold p pause q menu']

// The full prompt where it fits; a short one on compact and mini layouts, which are narrower.
const activate = (width: number) => (width >= 28 ? 'click here to activate panel' : 'click to activate')

function drawTitle(live: Live, surface: Surf, width: number) {
  const { Box, Text } = surface.elements

  return (
    <Box width={width} justifyContent="center">
      {live.hasKeyed ? <Text bold color="cyan">BLOCK BATTLE</Text> : <Text bold color="yellow">{activate(width)}</Text>}
    </Box>
  )
}

function drawOpponent(live: Live, surface: Surf, framed: boolean) {
  const { Box, Text } = surface.elements
  const opp = live.props.battle.opponent
  const name = (opp ? opp.login : 'opponent').slice(0, 10)
  const body = (
    <Box flexDirection="column">
      <Box justifyContent="center">
        <Text bold color={opp?.isOver ? 'red' : undefined}>{name}</Text>
      </Box>
      {gridEl(snapshotRows(opp?.snapshot ?? ''), surface)}
    </Box>
  )

  return framed ? panel(surface, 12, PANEL, body) : <Box flexDirection="column" width={10}>{body}</Box>
}

function drawSide(live: Live, surface: Surf, tier: 'big' | 'medium', pending: number) {
  const { Box, Text } = surface.elements
  const game = live.game!
  const big = tier === 'big'
  const width = TIERS[tier].side
  const inner = width - 2
  const si = inner - 2
  const hold = game.hold ? previewRows(game.hold, big ? BIG : COMPACT, inner, !game.canHold) : blankRows(big ? 4 : 2, inner)
  const nexts = game.next.slice(0, big ? 5 : 3)
  const title = (t: string, dim = false) => <Text bold dimColor={dim} color={TITLE}>{' ' + t}</Text>
  const gap = () => <Text> </Text>
  const nextBody = nexts.map((kind, i) => (
    <Box flexDirection="column">
      {i > 0 && gap()}
      {gridEl(previewRows(kind, big && i === 0 ? BIG : COMPACT, inner), surface)}
    </Box>
  ))
  const level = game.lines % 10
  const status = [
    pending > 0 ? { t: `INCOMING ${pending}`, c: 'red' } : null,
    game.combo > 0 ? { t: `COMBO x${game.combo}`, c: 'green' } : null,
    game.b2b ? { t: big ? 'BACK-TO-BACK' : 'B2B', c: '#ff9a1f' } : null,
  ].filter((s): s is { t: string; c: string } => s !== null)
  let used = 0
  const fitted = status.filter(s => {
    if (used + s.t.length + (used > 0 ? 1 : 0) > si) return false
    used += s.t.length + (used > 0 ? 1 : 0)

    return true
  })
  const barLine = (
    <Box width={si}>
      {bar(surface, level / 10, si - 5)}
      <Text dimColor>{` ${level}/10`.padStart(5)}</Text>
    </Box>
  )
  const stats = big ? (
    <Box flexDirection="column">
      <Text dimColor>SCORE</Text>
      <Box width={si} justifyContent="flex-end">
        <Text bold color="yellow">{String(game.score)}</Text>
      </Box>
      {kv(surface, si, 'LINES', String(game.lines))}
      {kv(surface, si, 'LEVEL', String(game.level), 'cyan')}
      {barLine}
      <Text color="green">{game.combo > 0 ? `COMBO x${game.combo}` : ' '}</Text>
      <Text color="#ff9a1f">{game.b2b ? 'BACK-TO-BACK' : ' '}</Text>
      <Text color="red">{pending > 0 ? `INCOMING ${pending}` : ' '}</Text>
    </Box>
  ) : (
    <Box flexDirection="column">
      {kv(surface, si, 'SCORE', String(game.score), 'yellow')}
      <Box width={si} gap={2}>
        {kv(surface, 8, 'LN', String(game.lines))}
        {kv(surface, 10, 'LEVEL', String(game.level), 'cyan')}
      </Box>
      {barLine}
      <Box width={si} gap={1}>
        {fitted.length === 0 ? <Text> </Text> : fitted.map(s => <Text color={s.c}>{s.t}</Text>)}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" width={width}>
      {panel(surface, width, PANEL, <Box flexDirection="column">{title('HOLD', !game.canHold)}{gridEl(hold, surface)}</Box>)}
      {panel(surface, width, PANEL, <Box flexDirection="column">{title('NEXT')}{nextBody}</Box>)}
      {panel(surface, width, PANEL, <Box flexDirection="column" paddingX={1}>{stats}</Box>)}
      <Box flexDirection="column">
        {(big ? HELP_BIG : HELP_MEDIUM).map(l => <Text dimColor>{' ' + l}</Text>)}
      </Box>
    </Box>
  )
}

function drawPlay(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements
  const game = live.game!
  const { fx } = live
  const isBattle = live.mode === 'battle'
  const tier = pickTier(surface.columns, surface.rows, isBattle)
  if (tier === 'tiny') {
    return (
      <Box paddingX={1}>
        <Text color="yellow">Too small for Block Battle: widen and heighten this pane (21 x 22 at least).</Text>
      </Box>
    )
  }
  const size = tier === 'big' ? BIG : COMPACT
  const extra: Label[] = []
  if (live.isPaused) extra.push({ text: 'PAUSED', color: '#ffffff', age: 200 })
  const isDone = game.isOver || live.result !== null
  let overlay: Overlay | null = null
  if (isDone && live.overMs > OVER_FINAL_MS) {
    const text = live.result ? (live.result === 'win' ? 'YOU WIN' : 'YOU LOSE') : 'GAME OVER'
    overlay = { title: text, color: live.result === 'win' ? '#38d64a' : '#ff3b3b', lines: [`SCORE ${game.score}`, live.mode === 'marathon' && live.gameId === null ? 'unranked' : '', live.mode === 'marathon' ? 'r restart  q menu' : 'q menu'] }
  }
  const pending = game.pendingGarbage.reduce((n, g) => n + g.lines, 0)
  const flash = fx.levelUp !== null && Math.floor(fx.levelUp / 100) % 2 === 0
  const frame = flash ? 'yellow' : FRAME
  const rows = fieldRows(game, fx, extra, live.overMs, size, overlay)
  const warn = pending > 0 && Math.floor(live.t / 200) % 2 === 0
  const barOn = (i: number) => rows.length - i <= pending * size.ch
  const bars = rows.map((_, i) => <Text color={warn ? '#ff8080' : '#ff3b3b'}>{barOn(i) ? '█' : ' '}</Text>)
  const width = FIELD_W * size.cw
  const opp = isBattle ? drawOpponent(live, surface, tier !== 'mini') : null

  if (tier === 'mini') {
    const side = surface.columns >= TIERS.mini.columns
    const hold = game.hold ? previewRows(game.hold, COMPACT, 10, !game.canHold) : blankRows(2, 10)
    const sideEl = (
      <Box flexDirection="column" width={10}>
        <Text bold dimColor={!game.canHold} color={TITLE}>HOLD</Text>
        {gridEl(hold, surface)}
        <Text bold color={TITLE}>NEXT</Text>
        {game.next.slice(0, 3).map((kind, i) => (
          <Box flexDirection="column">
            {i > 0 && <Text> </Text>}
            {gridEl(previewRows(kind, COMPACT, 10), surface)}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="row">
            <Box flexDirection="column">{bars}</Box>
            {gridEl(rows, surface)}
          </Box>
          {side && !isBattle ? sideEl : null}
          {isBattle && surface.columns >= 21 + 1 + 10 ? opp : null}
        </Box>
        <Text color={live.hasKeyed ? undefined : 'yellow'}>{live.hasKeyed ? `${game.score}  L${game.lines}  Lv${game.level}` : activate(surface.columns)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="column">
        {drawTitle(live, surface, width + 3)}
        <Box flexDirection="row">
          <Box flexDirection="column" marginTop={1}>{bars}</Box>
          <Box borderStyle="round" borderColor={frame}>
            {gridEl(rows, surface)}
          </Box>
        </Box>
      </Box>
      {drawSide(live, surface, tier, pending)}
      {opp ? <Box flexDirection="column" marginTop={1}>{opp}</Box> : null}
    </Box>
  )
}

function drawMenu(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements
  const cols = surface.columns
  const isBig = cols >= 37 && surface.rows >= 26
  const top = live.props.leaderboard?.marathon[0]
  const mw = cols >= 46 ? 44 : Math.max(20, cols - 2)
  const inner = mw - 2
  const GRAD = ['#00e5ff', '#2fb8ff', '#5a8cff', '#8a62ff', '#b44cff']
  const word = (w: string, flip: boolean) =>
    bigWord(w).map((line, i) => <Text bold color={GRAD[flip ? 4 - i : i]}>{line}</Text>)

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1}>
      {isBig ? (
        <Box flexDirection="column">
          {word('BLOCK', false)}
          <Text> </Text>
          {word('BATTLE', true)}
        </Box>
      ) : (
        <Text bold color="cyan">BLOCK BATTLE</Text>
      )}
      <Text dimColor>Play while Claude works</Text>
      <Box marginTop={1}>
        {panel(
          surface,
          mw,
          FRAME,
          MENU.map((m, i) => {
            const sel = i === live.menu
            const text = (' ' + (sel ? '> ' : '  ') + m.label.padEnd(12) + (inner >= 38 ? m.hint : '')).padEnd(inner).slice(0, inner)

            return <Text bold={sel} inverse={sel} color={sel ? 'cyan' : undefined}>{text}</Text>
          }),
        )}
      </Box>
      <Text dimColor>{top ? `Marathon best: ${top.login} ${top.score}` : ' '}</Text>
      <Text dimColor>up/down choose  enter starts</Text>
      <Text dimColor>Esc hands the keys back</Text>
      {live.hasKeyed ? <Text dimColor>keys: arrows up/x space c q</Text> : <Text bold color="yellow">{activate(cols)}</Text>}
    </Box>
  )
}

function drawStarting(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1}>
      <Text bold color="cyan">MARATHON</Text>
      <Text>{`Starting${'.'.repeat(1 + (Math.floor(live.t / 320) % 3))}`}</Text>
    </Box>
  )
}

function drawServers(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements
  const w = Math.min(46, Math.max(24, surface.columns - 2))
  const inner = w - 2
  const choices = serverChoices(live)
  const typing = live.typing

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1}>
      <Text bold color="cyan">BATTLE</Text>
      <Text dimColor>Where do you want to play?</Text>
      {panel(
        surface,
        w,
        FRAME,
        typing === null ? (
          choices.map((c, i) => {
            const sel = i === live.pick
            const text = (' ' + (sel ? '> ' : '  ') + c.label).padEnd(inner).slice(0, inner)

            return <Text bold={sel} inverse={sel} color={sel ? 'cyan' : undefined}>{text}</Text>
          })
        ) : (
          <Box flexDirection="column" paddingX={1}>
            <Text>Server address:</Text>
            <Text color="cyan">{(typing + '_').slice(-(inner - 2))}</Text>
            {live.typeError ? <Text color="red">{live.typeError}</Text> : <Text dimColor>enter connects, up goes back</Text>}
          </Box>
        ),
      )}
      <Text dimColor>{typing === null ? 'enter picks, q goes back' : ' '}</Text>
    </Box>
  )
}

function drawLobby(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements
  const { notice, battle } = live.props
  const dots = '.'.repeat(1 + (Math.floor(live.t / 320) % 3))
  const w = Math.min(46, Math.max(24, surface.columns - 2))

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1}>
      <Text bold color="cyan">BATTLE</Text>
      {panel(
        surface,
        w,
        FRAME,
        <Box paddingX={1} flexDirection="column">
          {notice && battle.status === 'idle' ? <Text color="red">{notice}</Text> : <Text>{`Looking for an opponent${dots}`}</Text>}
        </Box>,
      )}
      <Text dimColor>q goes back</Text>
    </Box>
  )
}

type Entry = { login: string; value: number }

function board(surface: Surf, title: string, empty: string, entries: Entry[], width: number, me: string | null) {
  const { Box, Text } = surface.elements
  const inner = width - 2
  const num = 7

  return panel(
    surface,
    width,
    FRAME,
    <Box flexDirection="column">
      <Text bold color={TITLE}>{' ' + title}</Text>
      {entries.length === 0 && <Text dimColor>{' ' + empty}</Text>}
      {entries.map((r, i) => {
        const mine = r.login === me
        const name = r.login.slice(0, Math.max(4, inner - num - 4))
        const text = (` ${i + 1}  ${name}`.padEnd(inner - num) + String(r.value).padStart(num - 1) + ' ').slice(0, inner)

        return <Text bold={mine} inverse={mine} color={mine ? 'yellow' : undefined}>{text}</Text>
      })}
    </Box>,
  )
}

function drawLeaderboard(live: Live, surface: Surf) {
  const { Box, Text } = surface.elements
  const { leaderboard, notice, me } = live.props
  const wide = surface.columns >= 62
  const w = wide ? 30 : Math.min(36, Math.max(24, surface.columns - 2))

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1}>
      <Text bold color="cyan">LEADERBOARD</Text>
      <Text dimColor>{hostOf(live.props.servers.active)}</Text>
      {leaderboard ? (
        <Box flexDirection={wide ? 'row' : 'column'} gap={1}>
          {board(surface, 'Marathon top 5', 'no scores yet', leaderboard.marathon.map(r => ({ login: r.login, value: r.score })), w, me)}
          {board(surface, 'Battle wins top 5', 'no wins yet', leaderboard.wins.map(r => ({ login: r.login, value: r.wins })), w, me)}
        </Box>
      ) : (
        <Text color={notice ? 'red' : undefined}>{notice ?? 'Loading...'}</Text>
      )}
      <Text dimColor>r refreshes, q goes back</Text>
    </Box>
  )
}

const Game: ClientModule<GameView, Shell> = (props, surface) => {
  let shell = surface.state
  if (shell === undefined) {
    const live = newLive(props)
    shell = { live, rev: 0 }
    const commit = () => surface.setState({ live, rev: ++live.rev })
    surface.every(STEP_MS, () => {
      const dirty = tick(live)
      // One post per tick: a later post in the same frame would replace this one.
      const msg = live.outbox.shift() ?? nextChunk(live)
      if (msg) surface.post(msg)
      if (dirty) commit()
    })
    surface.onKey(e => {
      onKey(live, e.key)
      commit()
    })
    surface.setState(shell)
  }
  const { live } = shell
  live.props = props ?? emptyProps()

  if (live.screen === 'play' && live.game) return drawPlay(live, surface)
  if (live.screen === 'starting') return drawStarting(live, surface)
  if (live.screen === 'servers') return drawServers(live, surface)
  if (live.screen === 'lobby') return drawLobby(live, surface)
  if (live.screen === 'leaderboard') return drawLeaderboard(live, surface)

  return drawMenu(live, surface)
}

export default Game
