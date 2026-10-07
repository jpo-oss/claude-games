import { expect, test } from 'claude-code/testing'

import { LEVELS, TUNING, botInputs, botSaw, capSpeed, newBot } from '../hooks/bot'
import type { Level } from '../hooks/bot'
import { newGame, receiveGarbage, step } from '../hooks/engine'

// The bot alone on a battle board, as in a match, fed 2 garbage lines every `every` steps (0: none).
function solo(level: Level, seed: number, steps: number, every = 480) {
  let g = newGame('battle', seed)
  const b = newBot(level, seed)
  const trace: string[] = []
  let i = 0
  for (; i < steps && !g.isOver; i++) {
    if (every > 0 && i % every === every - 1) g = receiveGarbage(g, 2)
    const inputs = botInputs(b, g)
    if (inputs.length > 0) trace.push(`${i}:${inputs.join(',')}`)
    const r = step(g, inputs, 16)
    botSaw(b, r.events)
    g = capSpeed(b, r.game)
  }
  return { lines: g.lines, survived: i, trace: trace.join(' ') }
}

test('the bot only acts on a live piece, at its own pace, and holds only on medium when it may', () => {
  for (const level of LEVELS) {
    let g = newGame('battle', 3)
    const b = newBot(level, 3)
    let last = -1_000
    for (let i = 0; i < 8_000 && !g.isOver; i++) {
      if (i % 600 === 599) g = receiveGarbage(g, 2)
      const inputs = botInputs(b, g)
      if (inputs.length > 0) {
        expect(inputs).toHaveLength(1)
        expect(g.active).not.toBe(null)
        expect(i - last).toBeGreaterThanOrEqual(TUNING[level].pace)
        if (inputs[0] === 'hold') {
          expect(level).toBe('medium')
          expect(g.canHold).toBe(true)
        }
        last = i
      }
      const r = step(g, inputs, 16)
      botSaw(b, r.events)
      g = r.game
    }
  }
})

test('the same seed and level always give the same moves; another seed gives others', { timeoutMs: 30_000 }, () => {
  for (const level of LEVELS) {
    expect(solo(level, 11, 4_000).trace).toBe(solo(level, 11, 4_000).trace)
    expect(solo(level, 11, 4_000).trace).not.toBe(solo(level, 12, 4_000).trace)
  }
})

const SEEDS = [1, 2, 3, 4, 5]

test('on every seed, harder levels clear more lines and last at least as long against the same garbage', { timeoutMs: 120_000 }, () => {
  for (const seed of SEEDS) {
    const [easy, medium, hard] = LEVELS.map(level => solo(level, seed, 20_000))
    expect(hard!.lines).toBeGreaterThan(medium!.lines)
    expect(medium!.lines).toBeGreaterThan(easy!.lines)
    expect(hard!.survived).toBeGreaterThanOrEqual(medium!.survived)
    expect(medium!.survived).toBeGreaterThanOrEqual(easy!.survived)
  }
})

test('medium and hard play alone for 10 minutes on every seed without topping out', { timeoutMs: 180_000 }, () => {
  const steps = (10 * 60_000) / 16
  for (const level of ['medium', 'hard'] as const) {
    for (const seed of SEEDS) expect(solo(level, seed, steps, 0).survived).toBe(steps)
  }
})

test('the bot board never speeds up past its level top', () => {
  const b = newBot('hard', 1)
  const g = { ...newGame('battle', 1), level: 15 }
  expect(capSpeed(b, g).level).toBe(TUNING.hard.top)
  expect(capSpeed(b, { ...g, level: 2 }).level).toBe(2)
  expect(TUNING.easy.top).toBeLessThan(TUNING.hard.top)
})

test('hard thinks in small slices: no step near one frame, under 0.5 ms a step on average', () => {
  let g = newGame('battle', 9)
  const b = newBot('hard', 9)
  let worst = 0
  let steps = 0
  const t0 = performance.now()
  for (; steps < 6_000 && !g.isOver; steps++) {
    const s = performance.now()
    const inputs = botInputs(b, g)
    worst = Math.max(worst, performance.now() - s)
    const r = step(g, inputs, 16)
    botSaw(b, r.events)
    g = r.game
  }
  // A single step can catch a garbage-collection pause on a busy machine; 16 ms is one whole frame.
  expect(worst).toBeLessThan(16)
  expect((performance.now() - t0) / steps).toBeLessThan(0.5)
})
