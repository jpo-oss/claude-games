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
  parseMarathonStart,
  parseQueue,
  parseSync,
  queueAttacks,
  serverUrlOk,
} from './net'
import type { Outbox, Reply } from './net'
import { takeChunk } from './log'
import type { Assembly, LogMsg } from './log'

const PANE = 'block-battle'
const NUDGE_MS = 120_000
const NUDGE_RETRY_MS = 10_000
const QUEUE_POLL_MS = 1_500
const QUEUE_GIVE_UP_MS = 120_000

export const idleBattle = (): Battle => ({ status: 'idle', roomId: null, seed: 0, opponent: null, incoming: [], result: null })
const OFFICIAL = 'https://games.jpoapps.com'
const LAST_SERVER = 'lastServer'
const startView = (): GameView => ({
  me: null,
  leaderboard: null,
  notice: null,
  battle: idleBattle(),
  servers: { home: OFFICIAL, isHomeOfficial: true, last: null, active: OFFICIAL },
  marathon: null,
  uploaded: null,
})

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
const signInLine = (uri: string, code: string) => {
  const line = `Sign in: open ${uri} and enter ${code}`
  if (rt.base === OFFICIAL) return line

  return `Community server ${new URL(rt.base).host}, run by someone else. It will learn your GitHub username. ${line}`
}
const trimSlash = (u: string) => u.replace(/\/+$/, '')

type Owned = { key: string; base: string }

const rt: {
  base: string
  home: string
  hasLoadedLast: boolean
  // Our server's session key, with the server it belongs to. The GitHub token is never kept: it is exchanged and dropped.
  session: { base: string; s: Session } | null
  signIn: Timer | null
  isSigningIn: boolean
  // Bumped when the pane closes so a flow still waiting on a request stops when it resumes.
  signInGen: number
  signInLine: string | null
  queueTimer: Timer | null
  // Bumped on every battle start, stop, reset, server switch and match. An async flow keeps the value it
  // started with and writes nothing once it has moved on.
  battleGen: number
  // The generation whose queue poll is in flight, so a stale one never holds up the next search.
  polling: number | null
  isSyncing: boolean
  outbox: Outbox
  latest: { snapshot: string; isOver: boolean }
  opponentLogin: string
  // The login whose session made the current match; the result is judged against it.
  myLogin: string
  lastSyncOk: number
  isAsking: boolean
  nudge: Timer | null
  isTurnOn: boolean
  wasNudged: boolean
  // Logs are only taken for marathon game ids the server handed out and rooms we were matched in,
  // and go to the server that handed them out.
  games: Owned[]
  rooms: Owned[]
  asm: Assembly | null
  sentKeys: string[]
  wantsSync: boolean
  retry: Timer | null
} = {
  base: OFFICIAL,
  home: OFFICIAL,
  hasLoadedLast: false,
  session: null,
  signIn: null,
  isSigningIn: false,
  signInGen: 0,
  signInLine: null,
  queueTimer: null,
  battleGen: 0,
  polling: null,
  isSyncing: false,
  outbox: emptyOutbox(),
  latest: { snapshot: '', isOver: false },
  opponentLogin: '',
  myLogin: '',
  lastSyncOk: 0,
  isAsking: false,
  nudge: null,
  isTurnOn: false,
  wasNudged: false,
  games: [],
  rooms: [],
  asm: null,
  sentKeys: [],
  wantsSync: false,
  retry: null,
}

const setView = ($: EngineInterface, patch: Partial<GameView>) => update($, view, v => ({ ...v, ...patch }))
const isLive = (gen: number) => gen === rt.battleGen
// Battle writes recheck their generation inside the update: the SDK can hold a write after the caller's own check.
const setViewIf = ($: EngineInterface, gen: number, patch: Partial<GameView>) =>
  update($, view, v => (isLive(gen) ? { ...v, ...patch } : v))
const setBattleIf = ($: EngineInterface, gen: number, patch: Partial<Battle>) =>
  update($, view, v => (isLive(gen) ? { ...v, battle: { ...v.battle, ...patch } } : v))

function noticeFor(r: { status: number; error: string }): string {
  if (r.status === 0) return DOWN
  if (r.status === 426) return OUTDATED
  if (r.status === 401 || r.status === 403) return SIGNED_OUT

  return `Server said: ${r.error}`
}

// The server can change while the store answers, so the session is only ever returned for the base it was read for.
// The name shown follows the active server's session on every call, so a sign-in cut short by a close still shows it.
async function loadSession($: EngineInterface, base = rt.base): Promise<Session | null> {
  const loaded = rt.session?.base === base ? rt.session.s : parseSession(await $.store.get(sessionKey(base)))
  if (loaded === null || base !== rt.base) return loaded
  const s = rt.session?.base === base ? rt.session.s : loaded
  rt.session = { base, s }
  const { me } = await read($, view)
  if (me !== s.login) await update($, view, v => (base === rt.base && rt.session?.s === s ? { ...v, me: s.login } : v))

  return s
}

function stopSignIn() {
  rt.signIn?.cancel()
  rt.signIn = null
  rt.isSigningIn = false
  rt.signInLine = null
  rt.signInGen++
}

// Returns the battle generation to carry on with, or null once something newer has taken over.
async function useServer($: EngineInterface, url: string, gen: number): Promise<number | null> {
  const next = trimSlash(url)
  if (next !== rt.home) {
    await $.store.set(LAST_SERVER, next)
    await update($, view, v => ({ ...v, servers: { ...v.servers, last: next } }))
  }
  if (!isLive(gen)) return null
  if (next === rt.base) return gen
  stopSignIn()
  rt.base = next
  rt.session = null
  const switched = bump()
  await update($, view, v => (isLive(switched) ? { ...v, me: null, leaderboard: null, servers: { ...v.servers, active: next } } : v))

  return isLive(switched) ? switched : null
}

async function loadLast($: EngineInterface) {
  const last = await $.store.get(LAST_SERVER)
  if (typeof last === 'string' && serverUrlOk(last)) await update($, view, v => ({ ...v, servers: { ...v.servers, last } }))
}

// Forgets only the session that was sent: a newer one saved meanwhile stays.
async function dropSession($: EngineInterface, base: string, sent: string) {
  if (rt.session?.base === base && rt.session.s.session === sent) rt.session = null
  if (parseSession(await $.store.get(sessionKey(base)))?.session === sent) {
    await $.store.delete(sessionKey(base))
    if (rt.session?.base === base) await $.store.set(sessionKey(base), rt.session.s)
  }
  await update($, view, v => (base === rt.base && rt.session?.base !== base ? { ...v, me: null } : v))
}

async function signOut($: EngineInterface): Promise<string> {
  const base = rt.base
  const s = await loadSession($, base)
  if (s === null) return 'Not signed in to this server.'
  if (serverUrlOk(base)) {
    await call((url, init) => $.http.fetch(url, init), base, 'DELETE', '/v1/session', s.session, undefined, signal =>
      $.clock.sleep(TIMEOUT_MS, { signal }),
    )
  }
  await dropSession($, base, s.session)

  return 'Signed out of Block Battle.'
}

async function startSignIn($: EngineInterface) {
  if (rt.isSigningIn) return
  rt.isSigningIn = true
  const base = rt.base
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
    const config = await call(fetch, base, 'GET', '/v1/config', null, undefined, giveUp)
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
        if (!live()) return
        const r = await call(fetch, base, 'POST', '/v1/session', null, { githubToken: poll.token }, signal => $.clock.sleep(TIMEOUT_MS, { signal }))
        if (!live()) return
        const s = r.ok ? parseSession(r.data) : null
        if (!s) return end(r.ok ? DOWN : noticeFor(r))
        rt.session = { base, s }
        await $.store.set(sessionKey(base), s)
        if (!live() || base !== rt.base) return
        await update($, view, v => (live() && base === rt.base && rt.session?.s === s ? { ...v, me: s.login } : v))
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

// A server other than the active one is only called with its own stored session, never with a sign-in.
// isWanted is asked once the session is in hand, right before anything is sent.
async function send(
  $: EngineInterface,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  base = rt.base,
  isWanted = () => true,
): Promise<{ r: Reply<unknown>; login: string | null }> {
  if (!serverUrlOk(base)) return { r: { ok: false, status: -2, error: BAD_URL }, login: null }
  const s = await loadSession($, base)
  if (!isWanted()) return { r: { ok: false, status: -3, error: '' }, login: null }
  if (s === null) {
    if (base !== rt.base) return { r: { ok: false, status: -1, error: SIGNED_OUT }, login: null }
    void startSignIn($)
    return { r: { ok: false, status: -1, error: rt.signInLine ?? SIGNING_IN }, login: null }
  }
  const r = await call((url, init) => $.http.fetch(url, init), base, method, path, s.session, body, signal => $.clock.sleep(TIMEOUT_MS, { signal }))
  if (!r.ok && r.status === 401) await dropSession($, base, s.session)

  return { r, login: s.login }
}

async function api(
  $: EngineInterface,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  base = rt.base,
  isWanted = () => true,
): Promise<Reply<unknown>> {
  return (await send($, method, path, body, base, isWanted)).r
}

function resultFor(winner: string): 'win' | 'loss' | null {
  if (rt.myLogin !== '' && winner === rt.myLogin) return 'win'
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
  const base = rt.base
  if ((await loadSession($, base)) === null) return
  const r = await api($, 'GET', '/v1/leaderboard', undefined, base)
  const board = r.ok ? parseLeaderboard(r.data) : null
  if (board && base === rt.base) await setView($, { leaderboard: board })
}

// A new generation: whatever timers the old one left are stopped with it.
function bump(): number {
  rt.queueTimer?.cancel()
  rt.queueTimer = null
  rt.retry?.cancel()
  rt.retry = null

  return ++rt.battleGen
}

// Returns the generation it set up, or null once something newer has taken over.
async function resetBattle($: EngineInterface, isLeaving: boolean): Promise<number | null> {
  const wasQueueing = rt.queueTimer !== null
  const base = rt.base
  const gen = bump()
  rt.outbox = emptyOutbox()
  rt.latest = { snapshot: '', isOver: false }
  rt.opponentLogin = ''
  rt.myLogin = ''
  if (isLeaving && wasQueueing) await api($, 'DELETE', '/v1/battle/queue', undefined, base)
  if (!isLive(gen)) return null
  await setBattleIf($, gen, idleBattle())

  return isLive(gen) ? gen : null
}

async function pollQueue($: EngineInterface, startedAt: number, gen: number) {
  if (rt.polling === gen || !isLive(gen)) return
  rt.polling = gen
  const base = rt.base
  const live = () => isLive(gen)
  try {
    const now = await $.clock.now()
    if (!live()) return
    if (now - startedAt > QUEUE_GIVE_UP_MS) {
      const reset = await resetBattle($, true)
      if (reset !== null) await setViewIf($, reset, { notice: 'No opponent found. Try again in a moment.' })

      return
    }
    const { r, login } = await send($, 'POST', '/v1/battle/queue', undefined, base, live)
    // A match made for a search the player has left is ignored: the server ends it by forfeit once nobody syncs,
    // and until then answers this search with 409, which is retried.
    if (!live()) return
    if (!r.ok) {
      if (r.status === 409) return
      const stopped = bump()
      if (r.status !== 401 && r.status !== -1) await api($, 'DELETE', '/v1/battle/queue', undefined, base)
      await setBattleIf($, stopped, idleBattle())
      await setViewIf($, stopped, { notice: fail(r) })

      return
    }
    const q = parseQueue(r.data)
    if (q?.status !== 'matched' || login === null) return
    const matchedAt = await $.clock.now()
    if (!live()) return
    const matched = bump()
    rt.opponentLogin = q.opponent
    rt.myLogin = login
    rt.rooms = [...rt.rooms, { key: q.roomId, base }].slice(-8)
    rt.lastSyncOk = matchedAt
    // Room for the big board and the opponent's beside it; a width the person dragged still wins.
    $.ui.open({ id: PANE, title: 'Block Battle', columns: TIERS.big.columns + OPP_COLUMNS + 1, rows: 46 }).catch(() => undefined)
    await setBattleIf($, matched, {
      status: 'matched',
      roomId: q.roomId,
      seed: q.seed,
      opponent: { login: q.opponent, snapshot: '', isOver: false },
      incoming: [],
      result: null,
    })
  } finally {
    if (rt.polling === gen) rt.polling = null
  }
}

async function startQueue($: EngineInterface) {
  const gen = bump()
  await setViewIf($, gen, { notice: null })
  if (!isLive(gen)) return
  await setBattleIf($, gen, { status: 'queueing' })
  if (!isLive(gen)) return
  const startedAt = await $.clock.now()
  if (!isLive(gen)) return
  rt.queueTimer = $.clock.every(QUEUE_POLL_MS, () => void pollQueue($, startedAt, gen))
  void pollQueue($, startedAt, gen)
}

async function flushSync($: EngineInterface) {
  if (rt.isSyncing) return
  const gen = rt.battleGen
  const base = rt.base
  const live = () => isLive(gen)
  const { battle } = await read($, view)
  const room = battle.roomId
  if (!live() || rt.isSyncing || room === null || battle.status !== 'matched') return
  rt.isSyncing = true
  try {
    const again = (ms: number) => {
      rt.retry?.cancel()
      rt.retry = $.clock.after(ms, () => void flushSync($))
    }
    const end = (notice: string) => endMatch($, gen, notice)
    const timedOut = async () => {
      const now = await $.clock.now()
      return live() && now - rt.lastSyncOk >= TIMEOUT_MS
    }
    // After topping out the Client stops posting syncs, so the hooks keep asking until the result comes or the server has been silent too long.
    const stalled = async () => {
      if (!rt.latest.isOver) return
      if (await timedOut()) await end(DOWN)
      else if (live()) again(1_000)
    }
    const { seq, attacks } = nextPayload(rt.outbox)
    const path = `/v1/battle/${encodeURIComponent(room)}/sync`
    const r = await api($, 'POST', path, { seq, attacks, snapshot: rt.latest.snapshot, isOver: rt.latest.isOver }, base)
    if (!live()) return
    if (!r.ok) {
      if (r.status === 404 || r.status === 403) await end('The match is no longer available.')
      else if (r.status === 401) await end(fail(r))
      else if (r.status === 0 && !rt.latest.isOver) {
        if (await timedOut()) await end(DOWN)
      } else await stalled()

      return
    }
    rt.outbox.inflight = null
    const s = parseSync(r.data)
    if (!s) return stalled()
    const now = await $.clock.now()
    if (!live()) return
    rt.lastSyncOk = now
    if (!s.ended && rt.latest.isOver) again(250)
    const result = s.ended && s.winner !== null ? resultFor(s.winner) : null
    if (s.ended && result === null) return end('The match ended with no result.')
    await update($, view, v => {
      if (!live() || v.battle.roomId !== room) return v

      return {
        ...v,
        battle: {
          ...v.battle,
          opponent: s.opponent ?? v.battle.opponent,
          incoming: mergeIncoming(v.battle.incoming, s.incoming),
          ...(s.ended ? { status: 'ended' as const, result } : {}),
        },
      }
    })
  } finally {
    rt.isSyncing = false
    if (rt.wantsSync) {
      rt.wantsSync = false
      void flushSync($)
    }
  }
}

async function endMatch($: EngineInterface, gen: number, notice: string) {
  if (!isLive(gen)) return
  const reset = await resetBattle($, false)
  if (reset !== null) await setViewIf($, reset, { notice })
}

async function startMarathon($: EngineInterface, nonce: number) {
  const gen = await resetBattle($, true)
  if (gen === null) return
  await setViewIf($, gen, { notice: null })
  if (!isLive(gen)) return
  let gameId: string | null = null
  let seed = 0
  const base = rt.base
  const isSignedIn = serverUrlOk(base) && (await loadSession($, base)) !== null
  if (!isLive(gen)) return
  if (isSignedIn) {
    const r = await api($, 'POST', '/v1/marathon', undefined, base)
    if (!isLive(gen)) return
    const g = r.ok ? parseMarathonStart(r.data) : null
    if (g) {
      ;({ gameId, seed } = g)
      rt.games = [...rt.games, { key: g.gameId, base }].slice(-8)
    }
  }
  await setViewIf($, gen, { marathon: { nonce, gameId, seed } })
}

// Retries only when the server could not answer (status 0) or said 503.
async function sendLog($: EngineInterface, base: string, path: string, body: unknown, tries: number, waitMs: number): Promise<Reply<unknown>> {
  for (let i = 1; ; i++) {
    const r = await api($, 'POST', path, body, base)
    if (r.ok || (r.status !== 0 && r.status !== 503) || i >= tries) return r
    await $.clock.sleep(waitMs)
  }
}

async function takeLog($: EngineInterface, m: LogMsg) {
  const owner = (m.kind === 'marathon' ? rt.games : rt.rooms).find(o => o.key === m.key)
  if (!owner) return
  const r = takeChunk(rt.asm, m)
  rt.asm = r.asm
  await setView($, { uploaded: { key: m.key, have: r.have } })
  if (!r.log || rt.sentKeys.includes(m.key)) return
  rt.sentKeys = [...rt.sentKeys, m.key].slice(-8)
  if (m.kind === 'marathon') {
    const res = await sendLog($, owner.base, '/v1/scores', { gameId: m.key, log: r.log }, 3, 5_000)
    const board = res.ok ? parseLeaderboard(res.data) : null
    if (board && owner.base === rt.base) await setView($, { leaderboard: board })
  } else {
    // The server waits 30 s for the winner's log.
    await sendLog($, owner.base, `/v1/battle/${encodeURIComponent(m.key)}/log`, { log: r.log }, 5, 3_000)
  }
}

async function handle($: EngineInterface, m: ClientMsg) {
  if (m.type === 'menu') {
    if (m.choice === 'leaderboard') return loadLeaderboard($)
    if (m.choice === 'battle') {
      const gen = await resetBattle($, true)
      if (gen === null || (await useServer($, m.server, gen)) === null) return

      return startQueue($)
    }
    if (m.choice === 'marathon') return startMarathon($, m.nonce)
    await resetBattle($, true)

    return
  }
  if (m.type === 'log') return takeLog($, m)
  if (m.type !== 'sync') return
  const gen = rt.battleGen
  const { battle } = await read($, view)
  if (!isLive(gen) || battle.status !== 'matched') return
  rt.latest = { snapshot: m.snapshot, isOver: m.isOver }
  queueAttacks(rt.outbox, m.attacks)
  if (rt.isSyncing) {
    rt.wantsSync = true

    return
  }

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
  rt.home = typeof options.serverUrl === 'string' && options.serverUrl !== '' ? trimSlash(options.serverUrl) : OFFICIAL
  rt.base = rt.home

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
      stopSignIn()
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
    if (!rt.hasLoadedLast) {
      rt.hasLoadedLast = true
      void loadLast($).catch(() => undefined)
    }
    const stored = await read($, view)
    const v = { ...stored, servers: { ...stored.servers, home: rt.home, isHomeOfficial: rt.home === OFFICIAL, active: rt.base } }

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
