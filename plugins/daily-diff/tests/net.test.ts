import { expect, test } from 'claude-code/testing'
import { buildRequest, parseBoard, parseClientMsg, parseStats, parseToday } from '../hooks/net'

const today = { number: 3, day: '2026-10-07', endsAt: 1791417600000, guesses: [{ word: 'zzzza', marks: 'xxxxg' }], state: 'playing', answer: null }
const row = { rank: 1, login: 'alice', points: 5, guesses: null, played: 2, ms: 1000 }

test('requests carry the game and its protocol', () => {
  expect(buildRequest('https://games.example', 'GET', '/v1/daily-diff/today', 't').init.headers).toEqual({
    Authorization: 'Bearer t', Accept: 'application/json', 'X-Protocol-Version': '1', 'X-Game': 'daily-diff',
  })
})

test('today is checked field by field', () => {
  expect(parseToday(today)).toEqual(today)
  expect(parseToday({ ...today, guesses: [{ word: 'ZZZZA', marks: 'xxxxg' }] })).toBeNull()
  expect(parseToday({ ...today, guesses: [{ word: 'zzzza', marks: 'xxxq' }] })).toBeNull()
  expect(parseToday({ ...today, guesses: Array(7).fill(today.guesses[0]) })).toBeNull()
  expect(parseToday({ ...today, state: 'won', answer: 'qqqqa' })?.answer).toBe('qqqqa')
  expect(parseToday({ ...today, state: 'weird' })).toBeNull()
})

test('boards keep at most 20 valid rows', () => {
  expect(parseBoard({ period: 'week', rows: [...Array(25)].map((_, i) => ({ ...row, rank: i + 1 })), you: null })!.rows.length).toBe(20)
  expect(parseBoard({ period: 'week', rows: [{ ...row, login: 'bad name!' }], you: null })!.rows).toEqual([])
  expect(parseBoard({ period: 'year', rows: [], you: null })).toBeNull()
})

test('stats need a six-slot distribution', () => {
  expect(parseStats({ played: 1, won: 1, streak: 1, bestStreak: 1, distribution: [1, 0, 0, 0, 0, 0] })).not.toBeNull()
  expect(parseStats({ played: 1, won: 1, streak: 1, bestStreak: 1, distribution: [1] })).toBeNull()
})

test('client messages: guesses are trimmed and lowercased, junk is dropped', () => {
  expect(parseClientMsg({ type: 'guess', word: ' Merge' })).toEqual({ type: 'guess', word: 'merge' })
  expect(parseClientMsg({ type: 'guess', word: 'toolong' })).toBeNull()
  expect(parseClientMsg({ type: 'guess', word: 'ab1de' })).toBeNull()
  expect(parseClientMsg({ type: 'board', period: 'month' })).toEqual({ type: 'board', period: 'month' })
  expect(parseClientMsg({ type: 'board', period: 'x' })).toBeNull()
  expect(parseClientMsg({ type: 'share' })).toEqual({ type: 'share' })
  expect(parseClientMsg('nope')).toBeNull()
})
