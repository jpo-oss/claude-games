import { login, withGiveUp } from './net'
import type { Fetch, GiveUp } from './net'

const DEVICE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const FORM = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }

export type DeviceCode = { deviceCode: string; userCode: string; uri: string; interval: number; expiresIn: number }
export type TokenPoll =
  | { kind: 'token'; token: string }
  | { kind: 'pending' }
  | { kind: 'slowDown' }
  | { kind: 'failed'; reason: 'expired' | 'denied' | 'error' }
export type Session = { session: string; login: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/
const SESSION = /^[\x21-\x7e]{1,200}$/
const never: GiveUp = () => new Promise(() => undefined)

export function parseConfig(data: unknown): string | null {
  if (!isRecord(data)) return null
  const id = data.githubClientId

  return typeof id === 'string' && CLIENT_ID.test(id) ? id : null
}

export const sessionKey = (base: string) => 'session:' + base.replace(/\/+$/, '')

export function parseDeviceCode(data: unknown): DeviceCode | null {
  if (!isRecord(data)) return null
  const deviceCode = str(data.device_code)
  const userCode = str(data.user_code)
  const uri = str(data.verification_uri)
  if (!deviceCode || !userCode || !uri) return null

  return {
    deviceCode,
    userCode,
    uri,
    interval: typeof data.interval === 'number' ? data.interval : 5,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
  }
}

export function parseTokenPoll(data: unknown): TokenPoll {
  if (!isRecord(data)) return { kind: 'failed', reason: 'error' }
  const token = str(data.access_token)
  if (token) return { kind: 'token', token }
  if (data.error === 'authorization_pending') return { kind: 'pending' }
  if (data.error === 'slow_down') return { kind: 'slowDown' }
  if (data.error === 'expired_token') return { kind: 'failed', reason: 'expired' }
  if (data.error === 'access_denied') return { kind: 'failed', reason: 'denied' }

  return { kind: 'failed', reason: 'error' }
}

export function parseSession(data: unknown): Session | null {
  if (!isRecord(data)) return null
  const session = typeof data.session === 'string' && SESSION.test(data.session) ? data.session : null
  const name = login(data.login)

  return session && name ? { session, login: name } : null
}

export async function requestDeviceCode(fetch: Fetch, clientId: string, giveUp: GiveUp = never): Promise<DeviceCode | null> {
  fetch = withGiveUp(fetch, giveUp)
  try {
    const body = new URLSearchParams({ client_id: clientId, scope: '' }).toString()
    const res = await fetch(DEVICE_URL, { method: 'POST', headers: FORM, body })

    return parseDeviceCode(JSON.parse(res.text))
  } catch {
    return null
  }
}

// A dropped or timed-out request counts as pending so the next tick asks again.
export async function pollToken(fetch: Fetch, clientId: string, deviceCode: string, giveUp: GiveUp = never): Promise<TokenPoll> {
  fetch = withGiveUp(fetch, giveUp)
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString()
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: FORM, body })

    return parseTokenPoll(JSON.parse(res.text))
  } catch {
    return { kind: 'pending' }
  }
}
