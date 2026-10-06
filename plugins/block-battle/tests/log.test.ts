import { expect, test } from 'claude-code/testing'

import { newGame, receiveGarbage, step } from '../hooks/engine'
import type { Input } from '../hooks/engine'
import { CHUNK, INPUT_NAMES, chunkAt, newPace, newRecorder, newSender, nextSend, recordGarbage, recordStep, stepsDue, takeChunk, toUpload } from '../hooks/log'
import type { Assembly, GameLog } from '../hooks/log'

// The server's replay (claude-games-server src/replay.ts), reduced to what the wire form decodes to.
function replay(seed: number, mode: 'marathon' | 'battle', log: GameLog, lines: Map<number, number> = new Map()) {
  const decode = (flat: number[]) => {
    const out: [number, number][] = []
    let at = 0
    for (let i = 0; i < flat.length; i += 2) {
      at += flat[i]!
      out.push([at, flat[i + 1]!])
    }
    return out
  }
  const inputs = decode(log.inputs)
  const garbage = decode(log.garbage ?? [])
  let game = newGame(mode, seed)
  let ii = 0
  let gi = 0
  for (let i = 0; i < log.steps; i++) {
    while (gi < garbage.length && garbage[gi]![0] === i) game = receiveGarbage(game, lines.get(garbage[gi++]![1])!)
    const now: Input[] = []
    while (ii < inputs.length && inputs[ii]![0] === i) now.push(INPUT_NAMES[inputs[ii++]![1]]!)
    game = step(game, now, 16).game
    if (game.isOver) break
  }
  return game
}

test('INPUT_NAMES matches the server order', () => {
  expect([...INPUT_NAMES]).toEqual(['left', 'right', 'softDropOn', 'softDropOff', 'softDropStep', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold'])
})

test('recordStep writes delta pairs like the server encodeLog', () => {
  const rec = newRecorder()
  recordStep(rec, [])
  recordStep(rec, ['left', 'hardDrop'])
  recordStep(rec, [])
  recordStep(rec, ['hold'])
  expect(rec.steps).toBe(4)
  expect(rec.inputs).toEqual([1, 0, 0, 5, 2, 9])
})

test('garbage is logged at the step about to run', () => {
  const rec = newRecorder()
  recordStep(rec, [])
  recordGarbage(rec, 7)
  recordGarbage(rec, 8)
  recordStep(rec, [])
  recordGarbage(rec, 9)
  expect(rec.garbage).toEqual([1, 7, 0, 8, 1, 9])
})

test('a recorded game replays to the same board, score and lines', () => {
  const seed = 1234
  let game = newGame('battle', seed)
  const rec = newRecorder()
  const lines = new Map([[3, 2], [4, 1]])
  const moves: Input[] = ['left', 'rotateCW', 'right', 'hardDrop', 'softDropStep', 'hold', 'rotate180', 'hardDrop']
  for (let i = 0; i < 3000 && !game.isOver; i++) {
    if (i === 500) {
      recordGarbage(rec, 3)
      game = receiveGarbage(game, 2)
    }
    if (i === 900) {
      recordGarbage(rec, 4)
      game = receiveGarbage(game, 1)
    }
    const now = i % 7 === 0 ? [moves[(i / 7) % moves.length]!] : []
    recordStep(rec, now)
    game = step(game, now, 16).game
  }
  const log: GameLog = { steps: rec.steps, inputs: rec.inputs, garbage: rec.garbage }
  const again = replay(seed, 'battle', log, lines)
  expect(again.score).toBe(game.score)
  expect(again.lines).toBe(game.lines)
  expect(again.isOver).toBe(game.isOver)
  expect(JSON.stringify(again.board)).toBe(JSON.stringify(game.board))
})

test('a full recorder stops counting, so the log is a valid prefix', () => {
  const rec = newRecorder()
  rec.steps = 449_999
  recordStep(rec, ['left'])
  expect(rec.isFull).toBe(true)
  recordStep(rec, ['right'])
  expect(rec.steps).toBe(450_000)
  expect(rec.inputs).toEqual([449_999, 0])
})

test('stepsDue: one step per tick on the frame clock when real time stands still', () => {
  const p = newPace(1000)
  expect([1, 2, 3, 4].map(() => stepsDue(p, 1000))).toEqual([1, 1, 1, 1])
})

test('stepsDue: real time ahead of ticks catches up at most 15 per tick and carries the rest', () => {
  const p = newPace(0)
  expect(stepsDue(p, 16 * 40)).toBe(15)
  expect(stepsDue(p, 16 * 40)).toBe(15)
  expect(stepsDue(p, 16 * 40)).toBe(10)
  expect(stepsDue(p, 16 * 40)).toBe(0)
  expect(stepsDue(p, 16 * 41)).toBe(1)
  expect(p.ran).toBe(41)
})

test('stepsDue: back-to-back ticks never put it ahead of max(ticks, real time)', () => {
  const p = newPace(0)
  expect(stepsDue(p, 16 * 10)).toBe(10)
  // missed ticks fired at once after a hitch: real time already counted them
  for (let i = 0; i < 9; i++) expect(stepsDue(p, 16 * 10 + 1)).toBe(0)
  expect(stepsDue(p, 16 * 11 + 1)).toBe(1)
  expect(p.ran).toBe(11)
})

test('stepsDue: a rebase starts counting from the steps already run', () => {
  const p = newPace(0)
  stepsDue(p, 16 * 5)
  const q = newPace(10_000, p.ran)
  expect(stepsDue(q, 10_000)).toBe(1)
  expect(stepsDue(q, 10_000 + 16 * 3)).toBe(2)
  expect(q.ran).toBe(8)
})

test('toUpload skips an empty game and joins inputs then garbage', () => {
  expect(toUpload('marathon', 'g1', newRecorder())).toBe(null)
  const rec = newRecorder()
  recordGarbage(rec, 5)
  recordStep(rec, ['left'])
  expect(toUpload('battle', 'r1', rec)).toEqual({ kind: 'battle', key: 'r1', steps: 1, inputsLen: 2, stream: [0, 0, 0, 5] })
})

test('chunks reassemble into the log, duplicates and gaps are ignored', () => {
  const rec = newRecorder()
  for (let i = 0; i < 12_000; i++) recordStep(rec, ['left'])
  recordGarbage(rec, 3)
  recordStep(rec, [])
  const up = toUpload('marathon', 'g1', rec)!
  expect(up.stream.length).toBe(24_002)
  let asm: Assembly | null = null
  let r = takeChunk(asm, chunkAt(up, 0))
  asm = r.asm
  expect(r.have).toBe(CHUNK)
  r = takeChunk(asm, chunkAt(up, 0))
  expect(r.have).toBe(CHUNK)
  r = takeChunk(r.asm, chunkAt(up, 2 * CHUNK))
  expect(r.have).toBe(CHUNK)
  r = takeChunk(r.asm, chunkAt(up, CHUNK))
  r = takeChunk(r.asm, chunkAt(up, 2 * CHUNK))
  expect(r.have).toBe(24_002)
  expect(r.log).toEqual({ steps: 12_001, inputs: rec.inputs, garbage: [12_000, 3] })
})

test('takeChunk refuses values that are not whole numbers and a new key restarts', () => {
  const base = { type: 'log' as const, kind: 'marathon' as const, key: 'g1', steps: 1, inputsLen: 2, total: 2, at: 0 }
  expect(takeChunk(null, { ...base, values: [0, 1.5] }).asm).toBe(null)
  expect(takeChunk(null, { ...base, values: [0, -1] }).asm).toBe(null)
  const first = takeChunk(null, { ...base, total: 4, values: [0, 1] })
  expect(first.have).toBe(2)
  const other = takeChunk(first.asm, { ...base, key: 'g2', values: [0, 3] })
  expect(other.log).toEqual({ steps: 1, inputs: [0, 3] })
})

test('nextSend re-sends every 250 ms, resets on progress and gives up after about 10 s stuck', () => {
  const s = newSender()
  expect(nextSend(s, 0)).toBe('send')
  const ticks = (have: number) => {
    const out: string[] = []
    for (let i = 0; i < 16; i++) out.push(nextSend(s, have))
    return out
  }
  expect(ticks(0)).toEqual([...Array(15).fill('wait'), 'send'])
  // progress sends at once and clears the count
  expect(nextSend(s, 100)).toBe('send')
  let sends = 0
  let result = ''
  for (let i = 0; i < 2_000 && result === ''; i++) {
    const r = nextSend(s, 100)
    if (r === 'send') sends++
    if (r === 'drop') result = `dropped after ${sends} re-sends, ${(i + 1) * 16} ms`
  }
  expect(result).toBe('dropped after 39 re-sends, 10240 ms')
})
