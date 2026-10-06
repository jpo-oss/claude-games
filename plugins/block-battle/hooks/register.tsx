import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register, Timer } from 'claude-code'

import type { Battle, ClientMsg, GameView } from '../types'
import { parseConfig, parseSession, pollToken, requestDeviceCode, sessionKey } from './auth'
import type { Session } from './auth'
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
  serverUrlOk,
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

const DOWN = 'Game server unreachable. Solo play still works.'
const SIGNED_OUT = 'Signed out. Pick Battle or Leaderboard to sign in again.'
const OUTDATED = 'Block Battle is out of date. Run claude plugin update block-battle@claude-games in your shell, then /reload-plugins.'
const SIGNING_IN = 'Signing in with GitHub...'
const NO_SIGNIN = "This server isn't set up for sign-in."
const BAD_URL = 'The server address must start with https://. Change it in the plugin settings.'
const TIMEOUT_MS = 30_000
const NO_GITHUB = "Couldn't reach GitHub to sign in. Solo play still works."
const CANCELLED = 'Sign-in was cancelled or expired. Pick Battle or Leaderboard to try again.'
const signInLine = (uri: string, code: string) => `Sign in: open ${uri} and enter ${code}`

const rt: {
  base: string
  // Our server's session key. The GitHub token is never kept: it is exchanged and dropped.
  session: Session | null
  signIn: Timer | null
  isSigningIn: boolean
  // Bumped when the pane closes so a flow still waiting on a request stops when it resumes.
  signInGen: number
  signInLine: string | null
  queueTimer: Timer | null
  isPolling: boolean
  isSyncing: boolean
  outbox: Outbox
  latest: { snapshot: string; isOver: boolean }
  opponentLogin: string
  lastSyncOk: number
  isAsking: boolean
  nudge: Timer | null
  isTurnOn: boolean
  wasNudged: boolean
} = {
  base: 'https://games.jpoapps.com',
  session: null,
  signIn: null,
  isSigningIn: false,
  signInGen: 0,
  signInLine: null,
  queueTimer: null,
  isPolling: false,
  isSyncing: false,
  outbox: emptyOutbox(),
  latest: { snapshot: '', isOver: false },
  opponentLogin: '',
  lastSyncOk: 0,
  isAsking: false,
  nudge: null,
  isTurnOn: false,
  wasNudged: false,
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

async function loadSession($: EngineInterface): Promise<Session | null> {
  if (rt.session) return rt.session
  rt.session = parseSession(await $.store.get(sessionKey(rt.base)))
  if (rt.session) await setView($, { me: rt.session.login })

  return rt.session
}

async function dropSession($: EngineInterface) {
  rt.session = null
  await $.store.delete(sessionKey(rt.base))
  await setView($, { me: null })
}

async function signOut($: EngineInterface): Promise<string> {
  const s = await loadSession($)
  if (s === null) return 'Not signed in to this server.'
  if (serverUrlOk(rt.base)) {
    await call((url, init) => $.http.fetch(url, init), rt.base, 'DELETE', '/v1/session', s.session, undefined, signal =>
      $.clock.sleep(TIMEOUT_MS, { signal }),
    )
  }
  await dropSession($)

  return 'Signed out of Block Battle.'
}

async function startSignIn($: EngineInterface) {
  if (rt.isSigningIn) return
  rt.isSigningIn = true
  const gen = ++rt.signInGen
  const live = () => gen === rt.signInGen
  const end = (notice: string) => {
    if (!live()) return
    rt.isSigningIn = false
    rt.signIn = null
    rt.signInLine = null

    return setView($, { notice })
  }
  const fetch = (url: string, init?: HttpInit) => $.http.fetch(url, init)
  const giveUp = (signal: AbortSignal) => $.clock.sleep(TIMEOUT_MS, { signal })
  try {
    const config = await call(fetch, rt.base, 'GET', '/v1/config', null, undefined, giveUp)
    if (!live()) return
    if (!config.ok) return end(noticeFor(config))
    const clientId = parseConfig(config.data)
    if (!clientId) return end(NO_SIGNIN)
    const code = await requestDeviceCode(fetch, clientId, giveUp)
    if (!live()) return
    if (!code) return end(NO_GITHUB)
    rt.signInLine = signInLine(code.uri, code.userCode)
    await setView($, { leaderboard: null, notice: rt.signInLine })
    const startedAt = await $.clock.now()
    let interval = code.interval
    const tick = async () => {
      try {
        if (!live()) return
        if ((await $.clock.now()) - startedAt > code.expiresIn * 1000) return end(CANCELLED)
        const poll = await pollToken(fetch, clientId, code.deviceCode, giveUp)
        if (!live()) return
        if (poll.kind === 'pending' || poll.kind === 'slowDown') {
          if (poll.kind === 'slowDown') interval += 5
          rt.signIn = $.clock.after(interval * 1000, () => void tick())

          return
        }
        if (poll.kind === 'failed') return end(poll.reason === 'error' ? NO_GITHUB : CANCELLED)
        await setView($, { notice: SIGNING_IN })
        const r = await call(fetch, rt.base, 'POST', '/v1/session', null, { githubToken: poll.token }, signal => $.clock.sleep(TIMEOUT_MS, { signal }))
        if (!live()) return
        const s = r.ok ? parseSession(r.data) : null
        if (!s) return end(r.ok ? DOWN : noticeFor(r))
        rt.session = s
        await $.store.set(sessionKey(rt.base), s)
        await setView($, { me: s.login })
        await end(`Signed in as ${s.login}.`)
        void prefetchBest($)
      } catch {
        await end(NO_GITHUB)
      }
    }
    rt.signIn = $.clock.after(interval * 1000, () => void tick())
  } catch {
    await end(NO_GITHUB)
  }
}

async function api($: EngineInterface, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reply<unknown>> {
  if (!serverUrlOk(rt.base)) return { ok: false, status: -2, error: BAD_URL }
  const s = await loadSession($)
  if (s === null) {
    void startSignIn($)
    return { ok: false, status: -1, error: rt.signInLine ?? SIGNING_IN }
  }
  const reply = await call((url, init) => $.http.fetch(url, init), rt.base, method, path, s.session, body, signal => $.clock.sleep(TIMEOUT_MS, { signal }))
  if (!reply.ok && reply.status === 401) await dropSession($)

  return reply
}

function resultFor(winner: string, me: string | null): 'win' | 'loss' | null {
  if (me !== null && winner === me) return 'win'
  if (winner === rt.opponentLogin) return 'loss'

  return null
}

const fail = (r: { status: number; error: string }) => (r.status < 0 ? r.error : noticeFor(r))

async function loadLeaderboard($: EngineInterface) {
  const r = await api($, 'GET', '/v1/leaderboard')
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board) await setView($, { leaderboard: board, notice: null })
  else await setView($, { leaderboard: null, notice: r.ok ? DOWN : fail(r) })
}

// For the menu's Marathon best only: it never touches the notice line, which a slow reply
// would otherwise overwrite after the person has moved on (a matchmaking error, say).
async function prefetchBest($: EngineInterface) {
  if ((await loadSession($)) === null) return
  const r = await api($, 'GET', '/v1/leaderboard')
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board) await setView($, { leaderboard: board })
}

async function submitScore($: EngineInterface, m: Extract<ClientMsg, { type: 'gameOver' }>) {
  if ((await loadSession($)) === null) return
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
      if (r.status !== 401 && r.status !== -1) await api($, 'DELETE', '/v1/battle/queue')
      await setBattle($, idleBattle())
      await setView($, { notice: fail(r) })

      return
    }
    const q = parseQueue(r.data)
    if (q?.status === 'matched' && rt.queueTimer !== null) {
      stopQueue()
      rt.opponentLogin = q.opponent
      rt.lastSyncOk = await $.clock.now()
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
    const r = await api($, 'POST', `/v1/battle/${encodeURIComponent(battle.roomId)}/sync`, { seq, attacks, snapshot: rt.latest.snapshot, isOver: rt.latest.isOver })
    if (!r.ok) {
      if (r.status === 404 || r.status === 403) await endMatch($, 'The match is no longer available.')
      else if (r.status === 410) await endMatch($, 'Match cancelled: your opponent left before it started.')
      else if (r.status === 401) await endMatch($, fail(r))
      else if (r.status === 0 && (await $.clock.now()) - rt.lastSyncOk >= TIMEOUT_MS) await endMatch($, DOWN)

      return
    }
    rt.outbox.inflight = null
    rt.lastSyncOk = await $.clock.now()
    const s = parseSync(r.data)
    if (!s) return
    if (s.winner !== null && resultFor(s.winner, (await read($, view)).me) === null) return endMatch($, 'The match ended with no result.')
    await update($, view, v => ({
      ...v,
      battle: {
        ...v.battle,
        opponent: s.opponent ?? v.battle.opponent,
        incoming: mergeIncoming(v.battle.incoming, s.incoming),
        ...(s.winner === null ? {} : { status: 'ended' as const, result: resultFor(s.winner, v.me) }),
      },
    }))
  } finally {
    rt.isSyncing = false
  }
}

async function endMatch($: EngineInterface, notice: string) {
  await resetBattle($, false)
  await setView($, { notice })
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
  $.ui.toast('Long task. /cg-block-battle while you wait?', { timeoutMs: 8_000 })
}

export const register: Register = (on, options) => {
  rt.base = typeof options.serverUrl === 'string' && options.serverUrl !== '' ? options.serverUrl : rt.base

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cg-block-battle', description: 'Play Block Battle while Claude works. Add "signout" to sign out' })

    return next(e)
  })

  on('command.run', { command: 'cg-block-battle' }, async ($, e) => {
    if (e.args.trim() === 'signout') return { text: await signOut($) }
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
    if (e.id === PANE) {
      rt.signIn?.cancel()
      rt.signIn = null
      rt.isSigningIn = false
      rt.signInLine = null
      rt.signInGen++
      await resetBattle($, true)
    }

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
