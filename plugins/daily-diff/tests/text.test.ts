import { expect, test } from 'claude-code/testing'
import { countdown, keyMarks, shareText } from '../hooks/text'

const won = {
  number: 112, day: '2026-10-07', endsAt: 0, answer: 'qqqqa', state: 'won' as const,
  guesses: [
    { word: 'zzzzz', marks: 'xyxxx' }, { word: 'zzzzz', marks: 'ygxgx' }, { word: 'zzzzz', marks: 'xgggy' }, { word: 'qqqqa', marks: 'ggggg' },
  ],
}

test('share text: squares only, no letters, install line', () => {
  expect(shareText(won)).toBe('Daily Diff #112  4/6\n\n□▒□□□\n▒■□■□\n□■■■▒\n■■■■■\n\n/plugin install daily-diff@claude-games')
  expect(shareText({ ...won, state: 'lost' }).split('\n')[0]).toBe('Daily Diff #112  X/6')
  expect(shareText(won)).not.toContain('qqqqa')
})

test('a key takes the best mark its letter has had', () => {
  expect(keyMarks([{ word: 'abcde', marks: 'yxxxx' }, { word: 'axxxx', marks: 'gxxxx' }])).toEqual({ a: 'g', b: 'x', c: 'x', d: 'x', e: 'x', x: 'x' })
})

test('countdown', () => {
  expect(countdown(5 * 3600_000 + 3 * 60_000 + 59_000)).toBe('5h 03m')
  expect(countdown(12 * 60_000 + 9_000)).toBe('12m 09s')
  expect(countdown(-5)).toBe('0m 00s')
})
