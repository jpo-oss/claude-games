import type { Input } from './engine'

export const STEP_MS = 16
export const MAX_STEPS = 450_000
const MAX_INPUTS = 200_000
const MAX_GARBAGE = 10_000
// Steps run in one tick at most: a longer stall skips time rather than fast-forwarding the board.
const MAX_CATCH_UP = 15
export const CHUNK = 10_000

// The server's list (claude-games-server src/protocol.ts). A logged code is an index here.
export const INPUT_NAMES = [
  'left', 'right', 'softDropOn', 'softDropOff', 'softDropStep', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold',
] as const satisfies readonly Input[]

export type GameLog = { steps: number; inputs: number[]; garbage?: number[] }

// Kept in wire form as the game runs: flat [stepDelta, value] pairs, each delta from the previous pair.
export type Recorder = { steps: number; inputs: number[]; garbage: number[]; lastInput: number; lastGarbage: number; isFull: boolean }

export const newRecorder = (): Recorder => ({ steps: 0, inputs: [], garbage: [], lastInput: 0, lastGarbage: 0, isFull: false })

// Called before the step it lands on runs, as the server applies it.
export function recordGarbage(rec: Recorder, id: number): void {
  if (rec.isFull) return
  if (rec.garbage.length >= MAX_GARBAGE * 2) {
    rec.isFull = true
    return
  }
  rec.garbage.push(rec.steps - rec.lastGarbage, id)
  rec.lastGarbage = rec.steps
}

// A full recorder stops counting, so what it holds is still a log the server can replay.
export function recordStep(rec: Recorder, inputs: readonly Input[]): void {
  if (rec.isFull) return
  if (rec.inputs.length + inputs.length * 2 > MAX_INPUTS * 2) {
    rec.isFull = true
    return
  }
  for (const i of inputs) {
    rec.inputs.push(rec.steps - rec.lastInput, INPUT_NAMES.indexOf(i))
    rec.lastInput = rec.steps
  }
  rec.steps++
  if (rec.steps >= MAX_STEPS) rec.isFull = true
}

// At least one step per tick: the test kit's frame clock has no real time behind it.
// ponytail: if the host fires several ticks back to back after a stall, the board runs a little ahead of real time; the server allows 5 s.
export type Pace = { lastAt: number; owed: number }

export const newPace = (): Pace => ({ lastAt: -1, owed: 0 })

export function stepsDue(p: Pace, at: number): number {
  const gap = p.lastAt < 0 ? STEP_MS : Math.max(0, at - p.lastAt)
  p.lastAt = at
  p.owed = Math.min(p.owed + gap, MAX_CATCH_UP * STEP_MS)
  const n = Math.max(1, Math.floor(p.owed / STEP_MS))
  p.owed = Math.max(0, p.owed - n * STEP_MS)

  return n
}

export type Upload = { kind: 'marathon' | 'battle'; key: string; steps: number; inputsLen: number; stream: number[] }

export function toUpload(kind: Upload['kind'], key: string, rec: Recorder): Upload | null {
  if (rec.steps < 1) return null

  return { kind, key, steps: rec.steps, inputsLen: rec.inputs.length, stream: [...rec.inputs, ...rec.garbage] }
}

export type LogMsg = {
  type: 'log'
  kind: Upload['kind']
  key: string
  steps: number
  inputsLen: number
  total: number
  at: number
  values: number[]
}

export const chunkAt = (u: Upload, at: number): LogMsg => ({
  type: 'log', kind: u.kind, key: u.key, steps: u.steps, inputsLen: u.inputsLen, total: u.stream.length, at, values: u.stream.slice(at, at + CHUNK),
})

export type Assembly = { kind: Upload['kind']; key: string; steps: number; inputsLen: number; total: number; values: number[] }

const whole = (v: number) => Number.isSafeInteger(v) && v >= 0

// Appends a chunk only at the position already held; anything else is answered with that position
// so the Client re-sends from there.
export function takeChunk(cur: Assembly | null, m: LogMsg): { asm: Assembly | null; have: number; log: GameLog | null } {
  if (!m.values.every(whole)) return { asm: cur, have: cur?.key === m.key ? cur.values.length : 0, log: null }
  let asm = cur
  if (!asm || asm.key !== m.key || asm.kind !== m.kind) {
    if (m.at !== 0) return { asm: cur, have: 0, log: null }
    asm = { kind: m.kind, key: m.key, steps: m.steps, inputsLen: m.inputsLen, total: m.total, values: [] }
  }
  if (m.at === asm.values.length && asm.values.length + m.values.length <= asm.total) {
    asm = { ...asm, values: [...asm.values, ...m.values] }
  }
  const have = asm.values.length
  if (have < asm.total) return { asm, have, log: null }
  const garbage = asm.values.slice(asm.inputsLen)
  const log: GameLog = { steps: asm.steps, inputs: asm.values.slice(0, asm.inputsLen), ...(garbage.length > 0 ? { garbage } : {}) }

  return { asm, have, log }
}
