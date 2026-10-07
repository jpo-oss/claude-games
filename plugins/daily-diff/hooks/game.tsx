import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { Board, ClientMsg, Period, Stats, Today, View } from '../types'
import { countdown, keyMarks } from './text'

const GREEN = '#538d4e'
const YELLOW = '#b59f3b'
const GRAY = '#6a6a6c'
const MARK: Record<string, string> = { g: GREEN, y: YELLOW, x: GRAY }
const EDGE = '#565758'
const EMPTY = '#3a3a3c'

const TICK_MS = 100
const FLASH_MS = 600
const PERIODS: Period[] = ['today', 'week', 'month', 'all']
const TAB: Record<Period, string> = { today: 'Today', week: 'Week', month: 'Month', all: 'All' }
const KEYS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']
const BAR_W = 20
const LOGIN_W = 20

const WIDE = 57
const MIN_COLUMNS = 44
// Rows each layout below takes, gaps included. A notice adds two more.
const PLAY_ROWS = 27
const SMALL_PLAY_ROWS = 14
const DONE_ROWS = 18
// The finished screen with full tiles: header, gap and six rows of 3-row tiles, with the results beside them.
const TILES_ROWS = 20
const RESULTS_W = 51
const TILES_W = 25 + 2 + RESULTS_W

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
  // props.now and the frame time it arrived at: the engine's time now is props.now plus the frames since.
  seenNow: number
  nowAt: number
  // Puzzle number whose countdown already asked for the next one.
  askedNext: number
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
    else if (k === 'r') post({ type: 'retry' })

    return
  }
  if (isSending) return
  if (/^[a-z]$/.test(k) && live.typed.length < 5) live.typed += k
  else if (k === 'backspace' || k === 'delete') live.typed = live.typed.slice(0, -1)
  else if (k === 'return' && live.typed.length === 5) post({ type: 'guess', word: live.typed })
}

const guessKey = (t: Today | null) => `${t?.number}:${t?.guesses.length}`
const timeLeft = (live: Live, t: Today) => t.endsAt - (live.props.now + live.t - live.nowAt)

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
  if (props.now !== live.seenNow) {
    live.seenNow = props.now
    live.nowAt = live.t
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

function grid(live: Live, s: Surf, today: Today, gap = 1) {
  const { Box } = s.elements
  const flash = live.t < live.flashUntil
  const rows: RenderElement[] = []
  for (let i = 0; i < 6; i++) {
    const g = today.guesses[i]
    const isTyping = i === today.guesses.length
    const cells = [0, 1, 2, 3, 4].map(j => {
      if (g) return tile(s, g.word[j]!, { bg: MARK[g.marks[j]!], border: MARK[g.marks[j]!]! })
      if (!isTyping) return tile(s, '', { border: EMPTY })
      const ch = live.typed[j] ?? ''

      return tile(s, ch, { border: flash ? 'red' : ch ? EDGE : EMPTY, dim: live.props.isSending })
    })
    rows.push(
      <Box key={`row-${i}`} flexDirection="row" gap={gap}>
        {cells}
      </Box>,
    )
  }

  return <Box flexDirection="column">{rows}</Box>
}

// One row per guess, for the finished screen and for short panes. Cells touch so a guess reads as a word.
function smallGrid(live: Live, s: Surf, today: Today, rowGap = 0) {
  const { Box, Text } = s.elements
  const flash = live.t < live.flashUntil
  const isPlaying = today.state === 'playing'

  return (
    <Box flexDirection="column" rowGap={rowGap}>
      {[0, 1, 2, 3, 4, 5].map(i => {
        const g = today.guesses[i]
        const isTyping = isPlaying && i === today.guesses.length

        return (
          <Box key={`row-${i}`} flexDirection="row">
            {[0, 1, 2, 3, 4].map(j => {
              if (g) return <Text bold color="white" backgroundColor={MARK[g.marks[j]!]}>{` ${g.word[j]!.toUpperCase()} `}</Text>
              const ch = isTyping ? (live.typed[j] ?? '') : ''
              if (isTyping && (ch || flash))
                return (
                  <Text bold color={flash ? 'red' : undefined} dimColor={live.props.isSending} underline>
                    {` ${ch.toUpperCase() || '·'} `}
                  </Text>
                )

              return <Text dimColor>{' · '}</Text>
            })}
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

const resultLine = (today: Today) =>
  today.state === 'won' ? `Solved in ${today.guesses.length}/6` : `The word was ${(today.answer ?? '').toUpperCase()}`

function statsLine(stats: Stats) {
  const win = stats.played ? Math.round((stats.won / stats.played) * 100) : 0

  return `Played ${stats.played}  Win ${win}%  Streak ${stats.streak}  Best ${stats.bestStreak}`
}

function statsBlock(s: Surf, today: Today, stats: Stats | null) {
  const { Box, Text } = s.elements
  const result = resultLine(today)
  if (!stats) return <Text bold>{result}</Text>
  const most = Math.max(1, ...stats.distribution)
  const winRow = today.state === 'won' ? today.guesses.length - 1 : -1

  return (
    <Box flexDirection="column">
      <Text bold>{result}</Text>
      <Text>{statsLine(stats)}</Text>
      {stats.distribution.map((n, i) => (
        <Box flexDirection="row" gap={1}>
          <Text>{String(i + 1)}</Text>
          {n > 0 ? <Text color={i === winRow ? GREEN : GRAY}>{'█'.repeat(Math.max(1, Math.round((n / most) * BAR_W)))}</Text> : null}
          <Text>{String(n)}</Text>
        </Box>
      ))}
    </Box>
  )
}

function boardLine(r: Board['rows'][number], period: Period) {
  const login = r.login.length > LOGIN_W ? r.login.slice(0, LOGIN_W - 1) + '~' : r.login
  const score = period === 'today' ? (r.guesses ?? 'X') : (r.points ?? '-')

  return `${String(r.rank).padStart(3)}  ${login.padEnd(LOGIN_W)}  ${String(score).padStart(7)}  ${String(r.played).padStart(6)}`
}

// `rows` is how many lines the board may take, tabs and column names included.
function boardBlock(live: Live, s: Surf, board: Board | null, rows: number) {
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
  const showYou = board.you !== null && !isIn && rows >= 5
  const top = Math.max(0, Math.min(20, rows - 2 - (showYou ? 2 : 0)))

  return (
    <Box flexDirection="column">
      {tabs}
      <Text dimColor>{`${'#'.padStart(3)}  ${'player'.padEnd(LOGIN_W)}  ${(period === 'today' ? 'guesses' : 'points').padStart(7)}  ${'played'.padStart(6)}`}</Text>
      {board.rows.slice(0, top).map(r => (
        <Text bold={r.login === me}>{boardLine(r, period)}</Text>
      ))}
      {showYou ? <Text dimColor>{'  ...'}</Text> : null}
      {showYou ? <Text bold>{boardLine(board.you!, period)}</Text> : null}
    </Box>
  )
}

function shareLine(s: Surf, copied: View['copied']) {
  const { Box, Text } = s.elements

  return (
    <Box flexDirection="row" gap={2}>
      <Text dimColor>s share  arrows switch board  r reload</Text>
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
  const noticeRows = notice ? 2 : 0
  // 0 before the first layout: the region is sized by the hooks, so draw the full screen.
  const room = s.rows > 0 ? s.rows : Infinity
  const hasTiles = done && s.columns >= TILES_W && room >= TILES_ROWS
  const width = hasTiles ? TILES_W : s.columns > 0 ? Math.min(WIDE, s.columns) : WIDE
  const header = (
    <Box flexDirection="row" justifyContent="space-between" width={done ? width : 41}>
      <Text bold>{`DAILY DIFF #${today.number}`}</Text>
      <Text dimColor>{`next in ${countdown(timeLeft(live, today))}`}</Text>
    </Box>
  )
  if (!done) {
    const isSmall = room < PLAY_ROWS + noticeRows
    const need = SMALL_PLAY_ROWS + noticeRows
    if (s.columns > 0 && (s.columns < MIN_COLUMNS || room < need)) {
      return (
        <Box paddingX={1}>
          <Text color="yellow">{`Make the pane bigger to play Daily Diff (${MIN_COLUMNS} x ${need} at least).`}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" alignItems="center" gap={1}>
        {header}
        {isSmall ? smallGrid(live, s, today) : grid(live, s, today)}
        {keyboard(s, today)}
        {noticeLine}
      </Box>
    )
  }
  if (hasTiles) {
    // Beside the tiles: stats, the board, share, and the gaps between them.
    const fixed = 2 + (stats ? 8 : 1) + 1 + 2 + noticeRows

    return (
      <Box flexDirection="column" alignItems="center" gap={1}>
        {header}
        <Box flexDirection="row" gap={2} width={TILES_W}>
          {grid(live, s, today, 0)}
          <Box flexDirection="column" gap={1} width={RESULTS_W}>
            {statsBlock(s, today, stats)}
            {noticeLine}
            {room - fixed >= 3 ? boardBlock(live, s, board, room - fixed) : null}
            {shareLine(s, copied)}
          </Box>
        </Box>
      </Box>
    )
  }
  // Short or narrow: the result, stats and share come first and the board gets what is left.
  if (room < DONE_ROWS + noticeRows || width < WIDE) {
    const fixed = 1 + 1 + (stats ? 1 : 0) + (notice ? 1 : 0) + 1

    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Text bold>{resultLine(today)}</Text>
        {stats ? <Text>{statsLine(stats)}</Text> : null}
        {noticeLine}
        {shareLine(s, copied)}
        {room - fixed >= 3 ? boardBlock(live, s, board, room - fixed) : null}
      </Box>
    )
  }
  // Header, the grid and stats (8, or 11 with the grid's rows spaced), board, share, and the gaps between them.
  const isSpaced = room >= DONE_ROWS + 3 + noticeRows
  const fixed = 1 + (isSpaced ? 11 : 8) + 1 + 3 + noticeRows

  return (
    <Box flexDirection="column" alignItems="center" gap={1}>
      {header}
      <Box flexDirection="row" gap={2} width={WIDE}>
        {smallGrid(live, s, today, isSpaced ? 1 : 0)}
        {statsBlock(s, today, stats)}
      </Box>
      {noticeLine}
      <Box width={WIDE}>{boardBlock(live, s, board, room - fixed)}</Box>
      <Box width={WIDE}>{shareLine(s, copied)}</Box>
    </Box>
  )
}

const Game: ClientModule<View, Shell> = (props, surface) => {
  let shell = surface.state
  if (shell === undefined) {
    const live: Live = { props, rev: 0, t: 0, typed: '', flashUntil: 0, tab: 0, seenRejected: props.rejected, seenGuesses: guessKey(props.today), seenPeriod: null, seenNow: props.now, nowAt: 0, askedNext: 0 }
    shell = { live, rev: 0 }
    const commit = () => surface.setState({ live, rev: ++live.rev })
    surface.every(TICK_MS, () => {
      const wasFlashing = live.t < live.flashUntil
      live.t += TICK_MS
      if ((wasFlashing && live.t >= live.flashUntil) || live.t % 1000 === 0) commit()
      const { today } = live.props
      if (isDone(today) && today!.number !== live.askedNext && timeLeft(live, today!) <= 0) {
        live.askedNext = today!.number
        surface.post({ type: 'retry' })
      }
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
