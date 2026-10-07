import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { Board, ClientMsg, Period, Stats, Today, View } from '../types'
import { countdown, keyMarks } from './text'

const GREEN = '#538d4e'
const YELLOW = '#b59f3b'
const GRAY = '#3a3a3c'
const MARK: Record<string, string> = { g: GREEN, y: YELLOW, x: GRAY }
const EDGE = '#565758'

const TICK_MS = 100
const FLASH_MS = 600
const PERIODS: Period[] = ['today', 'week', 'month', 'all']
const TAB: Record<Period, string> = { today: 'Today', week: 'Week', month: 'Month', all: 'All' }
const KEYS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']
const BAR_W = 20
const LOGIN_W = 20

// Smallest regions each screen fits in, measured from the layouts below.
const PLAY_MIN = { columns: 44, rows: 30 }
const DONE_MIN = { columns: 58, rows: 37 }

type Live = {
  props: View
  rev: number
  t: number
  typed: string
  flashUntil: number
  tab: number
  seenRejected: number
  // Puzzle number and guess count, so a new guess or a new puzzle clears the typing.
  seenGuesses: string
  seenPeriod: Period | null
}
type Shell = { live: Live; rev: number }
type Surf = ClientSurface<Shell>

const isDone = (t: Today | null) => t !== null && t.state !== 'playing'

function onKey(live: Live, key: string, post: (m: ClientMsg) => void) {
  const { today, isSending } = live.props
  const k = key.length === 1 ? key.toLowerCase() : key
  if (today === null) {
    if (k === 'r') post({ type: 'retry' })

    return
  }
  if (isDone(today)) {
    if (k === 'left' || k === 'right') {
      live.tab = (live.tab + (k === 'left' ? PERIODS.length - 1 : 1)) % PERIODS.length
      post({ type: 'board', period: PERIODS[live.tab]! })
    } else if (k === 's') post({ type: 'share' })

    return
  }
  if (isSending) return
  if (/^[a-z]$/.test(k) && live.typed.length < 5) live.typed += k
  else if (k === 'backspace' || k === 'delete') live.typed = live.typed.slice(0, -1)
  else if (k === 'return' && live.typed.length === 5) post({ type: 'guess', word: live.typed })
}

const guessKey = (t: Today | null) => `${t?.number}:${t?.guesses.length}`

// Picks up what changed in the props since the last call: a new guess clears the typing, a rejection
// flashes, and the tab follows the board the hooks show (they only ever show the one asked for last).
function sync(live: Live, props: View) {
  live.props = props
  const g = guessKey(props.today)
  if (g !== live.seenGuesses) {
    live.seenGuesses = g
    live.typed = ''
  }
  const period = props.board?.period ?? null
  if (period !== live.seenPeriod) {
    live.seenPeriod = period
    if (period) live.tab = PERIODS.indexOf(period)
  }
  if (props.rejected !== live.seenRejected) {
    live.seenRejected = props.rejected
    live.flashUntil = live.t + FLASH_MS
  }
}

function tile(s: Surf, letter: string, opts: { bg?: string; border: string; dim?: boolean }) {
  const { Box, Text } = s.elements

  return (
    <Box width={5} height={3} borderStyle="round" borderColor={opts.border} backgroundColor={opts.bg} justifyContent="center" alignItems="center">
      <Text bold color={opts.bg ? 'white' : undefined} dimColor={opts.dim}>
        {letter.toUpperCase() || ' '}
      </Text>
    </Box>
  )
}

function grid(live: Live, s: Surf, today: Today) {
  const { Box } = s.elements
  const flash = live.t < live.flashUntil
  const rows: RenderElement[] = []
  for (let i = 0; i < 6; i++) {
    const g = today.guesses[i]
    const isTyping = i === today.guesses.length
    const cells = [0, 1, 2, 3, 4].map(j => {
      if (g) return tile(s, g.word[j]!, { bg: MARK[g.marks[j]!], border: MARK[g.marks[j]!]! })
      if (!isTyping) return tile(s, '', { border: GRAY })
      const ch = live.typed[j] ?? ''

      return tile(s, ch, { border: flash ? 'red' : ch ? EDGE : GRAY, dim: live.props.isSending })
    })
    rows.push(
      <Box key={`row-${i}`} flexDirection="row" gap={1}>
        {cells}
      </Box>,
    )
  }

  return <Box flexDirection="column">{rows}</Box>
}

// One cell per letter, so the finished screen keeps room for the board.
function smallGrid(s: Surf, today: Today) {
  const { Box, Text } = s.elements

  return (
    <Box flexDirection="column">
      {[0, 1, 2, 3, 4, 5].map(i => {
        const g = today.guesses[i]

        return (
          <Box key={`row-${i}`} flexDirection="row" gap={1}>
            {[0, 1, 2, 3, 4].map(j =>
              g ? (
                <Text bold color="white" backgroundColor={MARK[g.marks[j]!]}>{` ${g.word[j]!.toUpperCase()} `}</Text>
              ) : (
                <Text dimColor>{' · '}</Text>
              ),
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function keyboard(s: Surf, today: Today) {
  const { Box, Text } = s.elements
  const marks = keyMarks(today.guesses)
  const key = (label: string, m?: string) => (
    <Text bold color={m ? 'white' : undefined} backgroundColor={m ? MARK[m] : undefined}>{` ${label} `}</Text>
  )

  return (
    <Box flexDirection="column" alignItems="center" rowGap={1}>
      {KEYS.map((letters, i) => (
        <Box flexDirection="row" gap={1}>
          {i === 2 ? key('ENTER') : null}
          {[...letters].map(c => key(c, marks[c.toLowerCase()]))}
          {i === 2 ? key('BACK') : null}
        </Box>
      ))}
    </Box>
  )
}

function statsBlock(s: Surf, today: Today, stats: Stats | null) {
  const { Box, Text } = s.elements
  const result = today.state === 'won' ? `Solved in ${today.guesses.length}/6` : `The word was ${(today.answer ?? '').toUpperCase()}`
  if (!stats) return <Text bold>{result}</Text>
  const win = stats.played ? Math.round((stats.won / stats.played) * 100) : 0
  const most = Math.max(1, ...stats.distribution)
  const winRow = today.state === 'won' ? today.guesses.length - 1 : -1

  return (
    <Box flexDirection="column">
      <Text bold>{result}</Text>
      <Text>{`Played ${stats.played}  Win ${win}%  Streak ${stats.streak}  Best ${stats.bestStreak}`}</Text>
      {stats.distribution.map((n, i) => (
        <Box flexDirection="row" gap={1}>
          <Text>{String(i + 1)}</Text>
          <Text color={i === winRow ? GREEN : GRAY}>{'█'.repeat(Math.max(1, Math.round((n / most) * BAR_W)))}</Text>
          <Text>{String(n)}</Text>
        </Box>
      ))}
    </Box>
  )
}

function boardLine(r: Board['rows'][number], period: Period) {
  const login = r.login.length > LOGIN_W ? r.login.slice(0, LOGIN_W - 1) + '~' : r.login
  const score = period === 'today' ? r.guesses : r.points

  return `${String(r.rank).padStart(3)}  ${login.padEnd(LOGIN_W)}  ${String(score ?? '-').padStart(7)}  ${String(r.played).padStart(6)}`
}

function boardBlock(live: Live, s: Surf, board: Board | null) {
  const { Box, Text } = s.elements
  const me = live.props.me
  const period = PERIODS[live.tab]!
  const tabs = (
    <Box flexDirection="row" gap={2}>
      {PERIODS.map((p, i) => (
        <Text inverse={i === live.tab} bold={i === live.tab}>
          {` ${TAB[p]} `}
        </Text>
      ))}
    </Box>
  )
  if (!board || board.period !== period) return <Box flexDirection="column">{tabs}<Text dimColor>Loading...</Text></Box>
  const isIn = board.rows.some(r => r.login === me)

  return (
    <Box flexDirection="column">
      {tabs}
      <Text dimColor>{`${'#'.padStart(3)}  ${'player'.padEnd(LOGIN_W)}  ${(period === 'today' ? 'guesses' : 'points').padStart(7)}  ${'played'.padStart(6)}`}</Text>
      {board.rows.slice(0, 20).map(r => (
        <Text bold={r.login === me}>{boardLine(r, period)}</Text>
      ))}
      {board.you && !isIn ? <Text dimColor>{'  ...'}</Text> : null}
      {board.you && !isIn ? <Text bold>{boardLine(board.you, period)}</Text> : null}
    </Box>
  )
}

function shareLine(s: Surf, copied: View['copied']) {
  const { Box, Text } = s.elements

  return (
    <Box flexDirection="row" gap={2}>
      <Text dimColor>s share  arrows switch board</Text>
      {copied === 'ok' ? <Text color={GREEN}>Copied</Text> : null}
      {copied === 'failed' ? <Text color="red">Copy failed</Text> : null}
    </Box>
  )
}

function draw(live: Live, s: Surf) {
  const { Box, Text } = s.elements
  const { today, notice, stats, board, copied } = live.props
  const noticeLine = notice ? <Text color="yellow">{notice}</Text> : null
  if (today === null) {
    return (
      <Box flexDirection="column" alignItems="center" paddingY={1}>
        <Text bold>DAILY DIFF</Text>
        <Text>{notice ?? 'Loading...'}</Text>
        <Text dimColor>r retry</Text>
      </Box>
    )
  }
  const done = isDone(today)
  const min = done ? DONE_MIN : PLAY_MIN
  // 0 before the first layout: the region is sized by the hooks, so draw the full screen.
  if (s.columns > 0 && (s.columns < min.columns || s.rows < min.rows)) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">{`Make the pane bigger to play Daily Diff (${min.columns} x ${min.rows} at least).`}</Text>
      </Box>
    )
  }
  const header = (
    <Box flexDirection="row" justifyContent="space-between" width={done ? 57 : 41}>
      <Text bold>{`DAILY DIFF #${today.number}`}</Text>
      <Text dimColor>{`next in ${countdown(today.endsAt - Date.now())}`}</Text>
    </Box>
  )
  if (!done) {
    return (
      <Box flexDirection="column" alignItems="center" gap={1}>
        {header}
        {grid(live, s, today)}
        {keyboard(s, today)}
        {noticeLine}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" alignItems="center" gap={1}>
      {header}
      <Box flexDirection="row" gap={2} width={57}>
        {smallGrid(s, today)}
        {statsBlock(s, today, stats)}
      </Box>
      {noticeLine}
      <Box width={57}>{boardBlock(live, s, board)}</Box>
      <Box width={57}>{shareLine(s, copied)}</Box>
    </Box>
  )
}

const Game: ClientModule<View, Shell> = (props, surface) => {
  let shell = surface.state
  if (shell === undefined) {
    const live: Live = { props, rev: 0, t: 0, typed: '', flashUntil: 0, tab: 0, seenRejected: props.rejected, seenGuesses: guessKey(props.today), seenPeriod: null }
    shell = { live, rev: 0 }
    const commit = () => surface.setState({ live, rev: ++live.rev })
    surface.every(TICK_MS, () => {
      const wasFlashing = live.t < live.flashUntil
      live.t += TICK_MS
      if ((wasFlashing && live.t >= live.flashUntil) || live.t % 1000 === 0) commit()
    })
    surface.onKey(e => {
      if (e.ctrl || e.meta) return
      onKey(live, e.key, m => surface.post(m))
      commit()
    })
    surface.setState(shell)
  }
  const { live } = shell
  sync(live, props)

  return draw(live, surface)
}

export default Game
