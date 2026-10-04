import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Battle, ClientMsg, GameView } from '../types'
import { OPP_COLUMNS, TIERS } from './draw'
import {
  call,
  emptyOutbox,
  mergeIncoming,
  nextPayload,
  parseClientMsg,
  parseLeaderboard,
  parseQueue,
  parseSync,
  queueAttacks,
} from './net'
import type { Outbox, Reply } from './net'

const PANE = 'block-battle'
const NUDGE_MS = 120_000
const NUDGE_RETRY_MS = 10_000
const QUEUE_POLL_MS = 1_500
const QUEUE_GIVE_UP_MS = 120_000

export const idleBattle = (): Battle => ({ status: 'idle', roomId: null, seed: 0, opponent: null, incoming: [], result: null })
const startView = (): GameView => ({ me: null, leaderboard: null, notice: null, battle: idleBattle() })

const view = atom({ plugin: 'block-battle', key: 'view' } as const, startView())

const NO_TOKEN = 'Sign in with the GitHub CLI (gh auth login) to use the leaderboard and battles.'
const DOWN = 'Game server unreachable. Solo play still works.'
const SIGNED_OUT = 'Signed out. Pick Battle or Leaderboard to sign in again.'
const OUTDATED = 'Block Battle is out of date. Run /plugin update block-battle@claude-games'

const rt: {
  base: string
  // The GitHub token lives here and nowhere else: never in state, props, logs or a message.
  token: string | null
  queueTimer: Timer | null
  isPolling: boolean
  isSyncing: boolean
  outbox: Outbox
  latest: { snapshot: string; isOver: boolean }
  opponentLogin: string
  isAsking: boolean
  nudge: Timer | null
  isTurnOn: boolean
  wasNudged: boolean
} = {
  base: 'https://games.jpoapps.com',
  token: null,
  queueTimer: null,
  isPolling: false,
  isSyncing: false,
  outbox: emptyOutbox(),
  latest: { snapshot: '', isOver: false },
  opponentLogin: '',
  isAsking: false,
  nudge: null,
  isTurnOn: false,
  wasNudged: false,
}

async function ensureToken($: EngineInterface): Promise<string | null> {
  if (rt.token !== null) return rt.token
  try {
    const { exitCode, stdout } = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 })
    const found = stdout.trim()
    if (exitCode === 0 && found !== '') rt.token = found
  } catch {
    rt.token = null
  }

  return rt.token
}

async function ensureMe($: EngineInterface) {
  if ((await read($, view)).me !== null) return
  try {
    const { exitCode, stdout } = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: 10_000 })
    const login = stdout.trim()
    if (exitCode === 0 && login !== '') await update($, view, v => ({ ...v, me: login }))
  } catch {
    // the leaderboard just does not highlight a row
  }
}

const setView = ($: EngineInterface, patch: Partial<GameView>) => update($, view, v => ({ ...v, ...patch }))
const setBattle = ($: EngineInterface, patch: Partial<Battle>) =>
  update($, view, v => ({ ...v, battle: { ...v.battle, ...patch } }))

function noticeFor(r: { status: number; error: string }): string {
  if (r.status === 0) return DOWN
  if (r.status === 426) return OUTDATED
  if (r.status === 401 || r.status === 403) return SIGNED_OUT

  return `Server said: ${r.error}`
}

async function api($: EngineInterface, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reply<unknown>> {
  const t = await ensureToken($)
  if (t === null) return { ok: false, status: -1, error: NO_TOKEN }
  const reply = await call((url, init) => $.http.fetch(url, init), rt.base, method, path, t, body)
  if (!reply.ok && reply.status === 401) rt.token = null

  return reply
}

const fail = (r: { status: number; error: string }) => (r.status === -1 ? NO_TOKEN : noticeFor(r))

async function loadLeaderboard($: EngineInterface) {
  void ensureMe($)
  const r = await api($, 'GET', '/v1/leaderboard')
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board) await setView($, { leaderboard: board, notice: null })
  else await setView($, { leaderboard: null, notice: r.ok ? DOWN : fail(r) })
}

// For the menu's Marathon best only: it never touches the notice line, which a slow reply
// would otherwise overwrite after the person has moved on (a matchmaking error, say).
async function prefetchBest($: EngineInterface) {
  const r = await api($, 'GET', '/v1/leaderboard')
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board) await setView($, { leaderboard: board })
}

async function submitScore($: EngineInterface, m: Extract<ClientMsg, { type: 'gameOver' }>) {
  const r = await api($, 'POST', '/v1/scores', {
    mode: 'marathon',
    score: m.score,
    lines: m.lines,
    level: m.level,
    durationMs: Math.max(1, m.durationMs),
  })
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board) await setView($, { leaderboard: board, notice: null })
}

function stopQueue() {
  rt.queueTimer?.cancel()
  rt.queueTimer = null
}

async function resetBattle($: EngineInterface, isLeaving: boolean) {
  const wasQueueing = rt.queueTimer !== null
  stopQueue()
  rt.outbox = emptyOutbox()
  rt.latest = { snapshot: '', isOver: false }
  rt.opponentLogin = ''
  if (isLeaving && wasQueueing) await api($, 'DELETE', '/v1/battle/queue')
  await setBattle($, idleBattle())
}

async function pollQueue($: EngineInterface, startedAt: number) {
  if (rt.isPolling || rt.queueTimer === null) return
  rt.isPolling = true
  try {
    if ((await $.clock.now()) - startedAt > QUEUE_GIVE_UP_MS) {
      await resetBattle($, true)
      await setView($, { notice: 'No opponent found. Try again in a moment.' })

      return
    }
    const r = await api($, 'POST', '/v1/battle/queue')
    if (!r.ok) {
      stopQueue()
      if (r.status !== 401) await api($, 'DELETE', '/v1/battle/queue')
      await setBattle($, idleBattle())
      await setView($, { notice: fail(r) })

      return
    }
    const q = parseQueue(r.data)
    if (q?.status === 'matched' && rt.queueTimer !== null) {
      stopQueue()
      rt.opponentLogin = q.opponent
      // Room for the big board and the opponent's beside it; a width the person dragged still wins.
      $.ui.open({ id: PANE, title: 'Block Battle', columns: TIERS.big.columns + OPP_COLUMNS + 1, rows: 46 }).catch(() => undefined)
      await setBattle($, {
        status: 'matched',
        roomId: q.roomId,
        seed: q.seed,
        opponent: { login: q.opponent, snapshot: '', isOver: false },
        incoming: [],
        result: null,
      })
    }
  } finally {
    rt.isPolling = false
  }
}

async function startQueue($: EngineInterface) {
  await resetBattle($, true)
  void ensureMe($)
  await setView($, { notice: null })
  await setBattle($, { status: 'queueing' })
  const startedAt = await $.clock.now()
  rt.queueTimer = $.clock.every(QUEUE_POLL_MS, () => void pollQueue($, startedAt))
  void pollQueue($, startedAt)
}

async function flushSync($: EngineInterface) {
  if (rt.isSyncing) return
  const { battle } = await read($, view)
  if (battle.roomId === null || battle.status !== 'matched') return
  rt.isSyncing = true
  try {
    const { seq, attacks } = nextPayload(rt.outbox)
    const r = await api($, 'POST', `/v1/battle/${battle.roomId}/sync`, { seq, attacks, snapshot: rt.latest.snapshot, isOver: rt.latest.isOver })
    if (!r.ok) {
      if (r.status === 404 || r.status === 403) {
        await setBattle($, { status: 'ended', result: null })
        await setView($, { notice: 'The match is no longer available.' })
      } else if (r.status === 410) {
        await resetBattle($, false)
        await setView($, { notice: 'Match cancelled: your opponent left before it started.' })
      } else if (r.status === 401) {
        await setBattle($, { status: 'ended', result: null })
        await setView($, { notice: fail(r) })
      }

      return
    }
    rt.outbox.inflight = null
    const s = parseSync(r.data)
    if (!s) return
    await update($, view, v => ({
      ...v,
      battle: {
        ...v.battle,
        opponent: s.opponent ?? v.battle.opponent,
        incoming: mergeIncoming(v.battle.incoming, s.incoming),
        ...(s.winner === null ? {} : { status: 'ended' as const, result: s.winner === rt.opponentLogin ? ('loss' as const) : ('win' as const) }),
      },
    }))
  } finally {
    rt.isSyncing = false
  }
}

async function handle($: EngineInterface, m: ClientMsg) {
  if (m.type === 'menu') {
    if (m.choice === 'leaderboard') return loadLeaderboard($)
    if (m.choice === 'battle') return startQueue($)
    if (m.choice === 'marathon') {
      await setView($, { notice: null })

      return resetBattle($, true)
    }

    return resetBattle($, true)
  }
  if (m.type === 'gameOver') return submitScore($, m)
  const { battle } = await read($, view)
  if (battle.status !== 'matched') return
  rt.latest = { snapshot: m.snapshot, isOver: m.isOver }
  queueAttacks(rt.outbox, m.attacks)

  return flushSync($)
}

// The nudge: one toast per Claude turn that has run two minutes, never over a question dialog.
function tryNudge($: EngineInterface) {
  rt.nudge = null
  if (!rt.isTurnOn || rt.wasNudged) return
  if (rt.isAsking) {
    rt.nudge = $.clock.after(NUDGE_RETRY_MS, () => tryNudge($))

    return
  }
  rt.wasNudged = true
  $.ui.toast('Long task. /block-battle while you wait?', { timeoutMs: 8_000 })
}

export const register: Register = (on, options) => {
  rt.base = typeof options.serverUrl === 'string' && options.serverUrl !== '' ? options.serverUrl : rt.base

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'block-battle', description: 'Play Block Battle while Claude works: Marathon, 1v1 battles, leaderboard' })

    return next(e)
  })

  on('command.run', { command: 'block-battle' }, async $ => {
    await resetBattle($, true)
    await setView($, { notice: null })
    const opened = await $.ui.open({ id: PANE, title: 'Block Battle', focus: true, closeOnEscape: true, holdToasts: true, columns: 66, rows: 46 })
    if (!opened.isPlaced) return { text: `Block Battle could not be shown here: ${opened.reason}` }
    // The menu shows the Marathon best, so fetch it now rather than only when Leaderboard is chosen.
    void prefetchBest($)
    // The engine refuses $.ui.focus on a Client; only the person's click gives it the keys.
    return { text: 'Block Battle open. Click the pane to play; q returns to the menu, Esc closes it.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await resetBattle($, true)

    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.element !== 'game') return next(e)
    const m = parseClientMsg(e.data)
    if (m) void handle($, m)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Client } = $.ui.resolve(e)
    const v = await read($, view)

    // Without a size the region is as tall as what the module draws, so a one-line "too small"
    // note would measure the region as one line and keep it there.
    return <Client key="game" module="./game.tsx" props={v} width={e.props.bodyColumns} height={e.props.scroll.bodyRows} />
  })

  on('prompt.submit', async ($, e, next) => {
    if (!rt.isTurnOn) {
      rt.isTurnOn = true
      rt.wasNudged = false
      rt.nudge?.cancel()
      rt.nudge = $.clock.after(NUDGE_MS, () => tryNudge($))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      rt.isTurnOn = false
      rt.nudge?.cancel()
      rt.nudge = null
    }

    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    rt.isAsking = true
    try {
      return await next(e)
    } finally {
      rt.isAsking = false
    }
  })
}
