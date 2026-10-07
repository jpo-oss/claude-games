import type { On } from 'claude-code'

export const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

// The test engine keeps no store, so the plugin's store calls are answered from a Map.
export function store(on: On, init: Record<string, unknown> = {}): Map<string, unknown> {
  const m = new Map(Object.entries(init))
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }))
  on('store.set', async (_$, e) => {
    m.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    m.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...m.keys()] }))

  return m
}

export const DEVICE = { device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }

// The game server, plus the sign-in endpoints so a signed-out test needs nothing more.
type Row = { rank: number; login: string; points: number | null; guesses: number | null; played: number; ms: number }

// `down` holds paths that answer 500 until the test takes them out.
export function server(on: On, opts: { answer?: string; valid?: string[]; rows?: Row[]; you?: Row } = {}) {
  const answer = opts.answer ?? 'qqqqa'
  const valid = new Set([...(opts.valid ?? ['zzzza', 'zzzzb']), answer])
  const guesses: string[] = []
  const down = new Set<string>()
  const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = []
  const mark = (w: string) => [...w].map((c, i) => (c === answer[i] ? 'g' : answer.includes(c) ? 'y' : 'x')).join('')
  const state = () => (guesses.at(-1) === answer ? 'won' : guesses.length >= 6 ? 'lost' : 'playing')
  const today = () => ({
    number: 1,
    day: '2026-10-07',
    endsAt: Date.UTC(2026, 9, 8),
    guesses: guesses.map(word => ({ word, marks: mark(word) })),
    state: state(),
    answer: state() === 'playing' ? null : answer,
  })
  on('http.fetch', async (_$, e) => {
    if (e.url === 'https://github.com/login/device/code') return { value: reply(DEVICE) }
    if (e.url === 'https://github.com/login/oauth/access_token') return { value: reply({ error: 'authorization_pending' }) }
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    seen.push({ method: e.init?.method ?? 'GET', url: e.url, headers: e.init?.headers ?? {}, body })
    const path = new URL(e.url).pathname
    if (down.has(path)) return { value: reply({ error: 'boom' }, 500) }
    if (path === '/v1/config') return { value: reply({ githubClientId: 'Iv1.test' }) }
    if (path === '/v1/daily-diff/today') return { value: reply(today()) }
    if (path === '/v1/daily-diff/guess') {
      if (!valid.has(body.word)) return { value: reply({ error: 'not in word list' }, 422) }
      guesses.push(body.word)
      return { value: reply(today()) }
    }
    if (path === '/v1/daily-diff/stats') return { value: reply({ played: 1, won: 1, streak: 1, bestStreak: 1, distribution: [1, 0, 0, 0, 0, 0] }) }
    if (path.startsWith('/v1/daily-diff/leaderboard/'))
      return { value: reply({ period: path.split('/').pop(), rows: opts.rows ?? [{ rank: 1, login: 'alice', points: null, guesses: 1, played: 1, ms: 5000 }], you: opts.you ?? null }) }
    return { value: reply({ error: 'not found' }, 404) }
  })

  return { seen, guesses, down }
}
