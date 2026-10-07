import { expect, test } from 'claude-code/testing'

import { TUNING, botInputs, botSaw, newBot } from '../hooks/bot'
import type { Level } from '../hooks/bot'
import { snapshot } from '../hooks/engine'
import type { Cell, Game, Input } from '../hooks/engine'
import { INPUT_NAMES, newRecorder, recordStep } from '../hooks/log'
import { newMatch, stepMatch } from '../hooks/match'
import type { Match } from '../hooks/match'

// The same script and digest live in claude-games-server test/record.ts.
const script = (i: number): Input[] => (i % 40 === 39 ? ['hardDrop'] : i % 13 === 0 ? ['left'] : [])

function record(seed: number, level: Level, cap: number, pilot?: Level): Match {
  const m = newMatch(seed, level)
  const brain = pilot ? newBot(pilot, seed + 1) : null
  for (let i = 0; i < cap && !m.winner; i++) {
    const inputs = brain ? botInputs(brain, m.me) : script(i)
    const r = stepMatch(m, inputs)
    if (brain) botSaw(brain, r.me)
  }
  return m
}

function digest(m: Match): string {
  let h = 0x811c9dc5
  const s = snapshot(m.me) + snapshot(m.bot)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${m.steps} ${m.winner} ${(h >>> 0).toString(16)}`
}

// The server's replayBot (claude-games-server src/replay.ts), reduced to the wire form.
function replayVs(seed: number, level: Level, steps: number, flat: number[]) {
  const inputs: [number, Input][] = []
  let at = 0
  for (let i = 0; i < flat.length; i += 2) {
    at += flat[i]!
    inputs.push([at, INPUT_NAMES[flat[i + 1]!]!])
  }
  const m = newMatch(seed, level)
  let ii = 0
  for (let i = 0; i < steps && !m.winner; i++) {
    const now: Input[] = []
    while (ii < inputs.length && inputs[ii]![0] === i) now.push(inputs[ii++]![1])
    stepMatch(m, now)
  }
  return { winner: m.winner, steps: m.steps }
}

// Rows 20 to 39 full but for column 0, and an O resting on them about to lock above the visible field.
function doomed(g: Game): Game {
  const board = g.board.map((r, y) => (y >= 20 ? r.map((_, x): Cell => (x === 0 ? null : 'G')) : r.slice()))
  return { ...g, board, active: { kind: 'O', rotation: 0, x: 3, y: 18 }, lockMs: 490, lowestY: 18 }
}

test('both boards topping out on the same step is a loss for the player', () => {
  const m = newMatch(1, 'hard')
  m.me = doomed(m.me)
  m.bot = doomed(m.bot)
  stepMatch(m, [])
  expect(m.me.isOver).toBe(true)
  expect(m.bot.isOver).toBe(true)
  expect(m.winner).toBe('bot')
  expect(m.steps).toBe(1)
  expect(stepMatch(m, ['hardDrop'])).toEqual({ me: [], bot: [] })
  expect(m.steps).toBe(1)
})

test('only the bot topping out is a win for the player', () => {
  const m = newMatch(1, 'hard')
  m.bot = doomed(m.bot)
  stepMatch(m, [])
  expect(m.winner).toBe('me')
})

test('the bot board is held at its top speed and the player board is not', () => {
  const m = newMatch(1, 'medium')
  m.me = { ...m.me, level: 15 }
  m.bot = { ...m.bot, level: 15 }
  stepMatch(m, [])
  expect(m.bot.level).toBe(TUNING.medium.top)
  expect(m.me.level).toBe(15)
})

test('a double the player clears lands in the bot pending garbage', () => {
  const m = newMatch(1, 'easy')
  const board = m.me.board.map((r, y): Cell[] => {
    if (y === 37) return r.map((_, x): Cell => (x === 0 ? 'G' : null))
    if (y >= 38) return r.map((_, x): Cell => (x === 4 || x === 5 ? null : 'G'))
    return r.slice()
  })
  m.me = { ...m.me, board, active: { kind: 'O', rotation: 0, x: 3, y: 18 }, lowestY: 18 }
  const r = stepMatch(m, ['hardDrop'])
  expect(r.me.some(e => e.type === 'lineClear' && e.attack === 1)).toBe(true)
  expect(m.bot.pendingGarbage.reduce((n, p) => n + p.lines, 0)).toBe(1)
})

test('a match recorded the way the Client records it replays to the same end', () => {
  const m = newMatch(4242, 'hard')
  const rec = newRecorder()
  for (let i = 0; i < 20_000 && !m.winner; i++) {
    const inputs = script(i)
    recordStep(rec, inputs)
    stepMatch(m, inputs)
  }
  expect(m.winner).not.toBe(null)
  expect(rec.steps).toBe(m.steps)
  expect(replayVs(4242, 'hard', rec.steps, rec.inputs)).toEqual({ winner: m.winner, steps: m.steps })
})

// Asserted with the same value in claude-games-server test/replay.test.ts: the Client's runtime and Node must agree.
const GOLDEN = '591 bot 86e2d9fb'

test('the golden match', () => {
  expect(digest(record(4242, 'hard', 20_000))).toBe(GOLDEN)
})

test('a bot in the player seat plays a whole match the same way twice', { timeoutMs: 60_000 }, () => {
  expect(digest(record(5, 'easy', 60_000, 'hard'))).toBe(digest(record(5, 'easy', 60_000, 'hard')))
})
