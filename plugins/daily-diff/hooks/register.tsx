import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register, RenderSurface, Timer } from 'claude-code'

import type { ClientMsg, Period, View } from '../types'
import { parseConfig, parseSession, pollToken, requestDeviceCode, sessionKey } from './auth'
import type { Session } from './auth'
import { call, parseBoard, parseClientMsg, parseStats, parseToday } from './net'
import type { Reply } from './net'
import { shareText } from './text'

const PANE = 'daily-diff'
const OFFICIAL = 'https://games.jpoapps.com'
const KEY = sessionKey(OFFICIAL)
const TIMEOUT_MS = 30_000

const DOWN = 'Game server unreachable.'
const OUTDATED = 'Daily Diff is out of date. Run claude plugin update daily-diff@claude-games in your shell, then /reload-plugins.'
const UNAVAILABLE = 'Daily Diff is not available right now.'
const NOT_A_WORD = 'Not in word list'
const NEW_PUZZLE = 'A new puzzle is out.'
const SIGNING_IN = 'Signing in with GitHub...'
const NO_SIGNIN = "This server isn't set up for sign-in."
const NO_GITHUB = "Couldn't reach GitHub to sign in."
const CANCELLED = 'Sign-in was cancelled or expired.'

const startView = (): View => ({ me: null, notice: null, today: null, board: null, stats: null, isSending: false, rejected: 0, copied: null })
const view = atom({ plugin: 'daily-diff', key: 'view' } as const, startView())

type Failure = { status: number; error: string }

const rt: {
  session: Session | null
  signIn: Timer | null
  isSigningIn: boolean
  // Bumped when the pane closes so a sign-in still waiting on a request stops when it resumes.
  signInGen: number
  // Bumped on every refresh and close. An async flow keeps the value it started with and writes nothing once it has moved on.
  gen: number
  // The generation whose guess is in flight, so a stale one never blocks the next.
  sending: number | null
  period: Period | null
} = { session: null, signIn: null, isSigningIn: false, signInGen: 0, gen: 0, sending: null, period: null }

const isLive = (gen: number) => gen === rt.gen
const setView = ($: EngineInterface, patch: Partial<View>) => update($, view, v => ({ ...v, ...patch }))
// The generation is checked again inside the update: the SDK can hold a write after the caller's own check.
const setViewIf = ($: EngineInterface, gen: number, patch: Partial<View>) => update($, view, v => (isLive(gen) ? { ...v, ...patch } : v))

const fetch = ($: EngineInterface) => (url: string, init?: HttpInit) => $.http.fetch(url, init)
const giveUp = ($: EngineInterface) => (signal: AbortSignal) => $.clock.sleep(TIMEOUT_MS, { signal })

function noticeFor(r: Failure): string {
  if (r.status === 0) return DOWN
  if (r.status === 426) return OUTDATED
  if (r.status === 503) return UNAVAILABLE

  return `Server said: ${r.error}`
}

async function loadSession($: EngineInterface): Promise<Session | null> {
  if (rt.session === null) rt.session = parseSession(await $.store.get(KEY))

  return rt.session
}

function stopSignIn() {
  rt.signIn?.cancel()
  rt.signIn = null
  rt.isSigningIn = false
  rt.signInGen++
}

// Forgets only the session that was sent: a newer one saved meanwhile stays.
async function dropSession($: EngineInterface, sent: string) {
  if (rt.session?.session === sent) rt.session = null
  if (parseSession(await $.store.get(KEY))?.session === sent) await $.store.delete(KEY)
  await update($, view, v => (rt.session === null ? { ...v, me: null } : v))
}

async function signOut($: EngineInterface): Promise<string> {
  const s = await loadSession($)
  if (s === null) return 'Not signed in.'
  await call(fetch($), OFFICIAL, 'DELETE', '/v1/session', s.session, undefined, giveUp($))
  await dropSession($, s.session)

  return 'Signed out of Daily Diff.'
}

async function startSignIn($: EngineInterface) {
  if (rt.isSigningIn) return
  rt.isSigningIn = true
  const gen = ++rt.signInGen
  const live = () => gen === rt.signInGen
  const say = (notice: string) => update($, view, v => (live() ? { ...v, notice } : v))
  const end = (notice: string) => {
    if (!live()) return
    rt.isSigningIn = false
    rt.signIn = null

    return say(notice)
  }
  const f = fetch($)
  const g = giveUp($)
  try {
    const config = await call(f, OFFICIAL, 'GET', '/v1/config', null, undefined, g)
    if (!live()) return
    if (!config.ok) return end(noticeFor(config))
    const clientId = parseConfig(config.data)
    if (!clientId) return end(NO_SIGNIN)
    const code = await requestDeviceCode(f, clientId, g)
    if (!live()) return
    if (!code) return end(NO_GITHUB)
    await say(`Sign in: open ${code.uri} and enter ${code.userCode}`)
    const startedAt = await $.clock.now()
    let interval = code.interval
    const tick = async () => {
      try {
        if (!live()) return
        if ((await $.clock.now()) - startedAt > code.expiresIn * 1000) return end(CANCELLED)
        const poll = await pollToken(f, clientId, code.deviceCode, g)
        if (!live()) return
        if (poll.kind === 'pending' || poll.kind === 'slowDown') {
          if (poll.kind === 'slowDown') interval += 5
          rt.signIn = $.clock.after(interval * 1000, () => void tick())

          return
        }
        if (poll.kind === 'failed') return end(poll.reason === 'error' ? NO_GITHUB : CANCELLED)
        await say(SIGNING_IN)
        if (!live()) return
        const r = await call(f, OFFICIAL, 'POST', '/v1/session', null, { githubToken: poll.token }, g)
        if (!live()) return
        const s = r.ok ? parseSession(r.data) : null
        if (!s) return end(r.ok ? DOWN : noticeFor(r))
        rt.session = s
        await $.store.set(KEY, s)
        if (!live()) return
        rt.isSigningIn = false
        rt.signIn = null
        void refresh($, `Signed in as ${s.login}.`)
      } catch {
        await end(NO_GITHUB)
      }
    }
    rt.signIn = $.clock.after(interval * 1000, () => void tick())
  } catch {
    await end(NO_GITHUB)
  }
}

// No session answers 401, which every caller turns into a sign-in.
async function send($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply<unknown>> {
  const s = await loadSession($)
  if (s === null) return { ok: false, status: 401, error: '' }
  const r = await call(fetch($), OFFICIAL, method, path, s.session, body, giveUp($))
  if (!r.ok && r.status === 401) await dropSession($, s.session)

  return r
}

async function fail($: EngineInterface, gen: number, r: Failure) {
  if (!isLive(gen)) return
  if (r.status === 401) return startSignIn($)
  await setViewIf($, gen, { notice: noticeFor(r) })
}

const BAD_REPLY: Failure = { status: 0, error: '' }

async function loadFinished($: EngineInterface, gen: number) {
  rt.period = 'today'
  const [st, b] = await Promise.all([send($, 'GET', '/v1/daily-diff/stats'), send($, 'GET', '/v1/daily-diff/leaderboard/today')])
  const stats = st.ok ? parseStats(st.data) : null
  const board = b.ok ? parseBoard(b.data) : null
  if (!stats) return fail($, gen, st.ok ? BAD_REPLY : st)
  if (!board) return fail($, gen, b.ok ? BAD_REPLY : b)
  await update($, view, v => (isLive(gen) ? { ...v, stats, board: rt.period === 'today' ? board : v.board } : v))
}

async function refresh($: EngineInterface, notice: string | null = null) {
  const gen = ++rt.gen
  const r = await send($, 'GET', '/v1/daily-diff/today')
  const today = r.ok ? parseToday(r.data) : null
  if (!today) return fail($, gen, r.ok ? BAD_REPLY : r)
  await setViewIf($, gen, { me: rt.session?.login ?? null, today, notice, isSending: false })
  if (today.state !== 'playing') await loadFinished($, gen)
}

async function guess($: EngineInterface, word: string) {
  const gen = rt.gen
  if (rt.sending === gen) return
  const { today } = await read($, view)
  if (!isLive(gen) || rt.sending === gen || today?.state !== 'playing') return
  rt.sending = gen
  let r: Reply<unknown>
  try {
    await setViewIf($, gen, { isSending: true })
    r = await send($, 'POST', '/v1/daily-diff/guess', { number: today.number, word })
  } finally {
    if (rt.sending === gen) rt.sending = null
    await setViewIf($, gen, { isSending: false })
  }
  if (!isLive(gen)) return
  if (r.ok) {
    const next = parseToday(r.data)
    if (!next) return fail($, gen, BAD_REPLY)
    await setViewIf($, gen, { today: next, notice: null })
    if (next.state !== 'playing') await loadFinished($, gen)

    return
  }
  if (r.status === 422) return void (await update($, view, v => (isLive(gen) ? { ...v, rejected: v.rejected + 1, notice: NOT_A_WORD } : v)))
  if (r.status === 409) return refresh($, r.error === 'new puzzle' ? NEW_PUZZLE : null)

  return fail($, gen, r)
}

async function board($: EngineInterface, period: Period) {
  const gen = rt.gen
  rt.period = period
  const r = await send($, 'GET', `/v1/daily-diff/leaderboard/${period}`)
  const b = r.ok ? parseBoard(r.data) : null
  if (!b) return fail($, gen, r.ok ? BAD_REPLY : r)
  // Only the tab asked for last is shown, whatever order the replies land in.
  await update($, view, v => (isLive(gen) && rt.period === period ? { ...v, board: b } : v))
}

async function share($: EngineInterface, surface: RenderSurface) {
  const gen = rt.gen
  const { today } = await read($, view)
  if (!today || today.state === 'playing') return
  const r = await $.ui.copy({ text: shareText(today), surface })
  await setViewIf($, gen, { copied: r.isCopied ? 'ok' : 'failed' })
}

function handle($: EngineInterface, m: ClientMsg, surface: RenderSurface) {
  if (m.type === 'guess') return guess($, m.word)
  if (m.type === 'board') return board($, m.period)
  if (m.type === 'share') return share($, surface)

  return refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cg-daily-diff', description: `Today's coding word puzzle. Add "signout" to sign out` })

    return next(e)
  })

  on('command.run', { command: 'cg-daily-diff' }, async ($, e) => {
    if (e.args.trim() === 'signout') return { text: await signOut($) }
    await setView($, { notice: null, copied: null, isSending: false })
    const opened = await $.ui.open({ id: PANE, title: 'Daily Diff', focus: true, closeOnEscape: true, holdToasts: true, columns: 60, rows: 40 })
    if (!opened.isPlaced) return { text: `Daily Diff could not be shown here: ${opened.reason}` }
    void refresh($)

    // The engine refuses $.ui.focus on a Client; only the person's click gives it the keys.
    return { text: 'Daily Diff open. Click the pane to type; Esc closes it.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopSignIn()
      rt.gen++
    }

    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.element !== 'game') return next(e)
    const m = parseClientMsg(e.data)
    if (m) void handle($, m, e.surface)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const ui = $.ui.resolve(e)
    const v = await read($, view)

    // Without a size the region is as tall as what the module draws.
    return <ui.Client key="game" module="./game.tsx" props={v} width={e.props.bodyColumns} height={e.props.scroll.bodyRows} />
  })
}
