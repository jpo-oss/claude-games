import { expect, test } from 'claude-code/testing'

import { parseConfig, parseDeviceCode, parseSession, parseTokenPoll, pollToken, requestDeviceCode, sessionKey } from '../hooks/auth'
import type { Fetch } from '../hooks/net'

const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

test('a device code reply is read into the fields the pane shows', () => {
  expect(parseDeviceCode({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })).toEqual({
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    uri: 'https://github.com/login/device',
    interval: 5,
    expiresIn: 900,
  })
  expect(parseDeviceCode({ error: 'device_flow_disabled' })).toBeNull()
})

test('token polling covers every answer GitHub gives', () => {
  expect(parseTokenPoll({ access_token: 'gho_1', token_type: 'bearer', scope: '' })).toEqual({ kind: 'token', token: 'gho_1' })
  expect(parseTokenPoll({ error: 'authorization_pending' })).toEqual({ kind: 'pending' })
  expect(parseTokenPoll({ error: 'slow_down', interval: 10 })).toEqual({ kind: 'slowDown' })
  expect(parseTokenPoll({ error: 'expired_token' })).toEqual({ kind: 'failed', reason: 'expired' })
  expect(parseTokenPoll({ error: 'access_denied' })).toEqual({ kind: 'failed', reason: 'denied' })
  expect(parseTokenPoll({ error: 'incorrect_client_credentials' })).toEqual({ kind: 'failed', reason: 'error' })
  expect(parseTokenPoll('garbage')).toEqual({ kind: 'failed', reason: 'error' })
})

test('a session reply needs both fields', () => {
  expect(parseSession({ session: 's1', login: 'alice' })).toEqual({ session: 's1', login: 'alice' })
  expect(parseSession({ session: 's1' })).toBeNull()
})

test('the device code request asks for no scopes', async () => {
  const seen: { url: string; body?: string }[] = []
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, body: init?.body })
    return reply({ device_code: 'dc', user_code: 'U', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  }
  await requestDeviceCode(fetch, 'Iv1.abc')
  expect(seen[0]!.url).toBe('https://github.com/login/device/code')
  expect(new URLSearchParams(seen[0]!.body).get('scope')).toBe('')
  expect(new URLSearchParams(seen[0]!.body).get('client_id')).toBe('Iv1.abc')
})

test('polling sends the device grant and treats a network error as pending', async () => {
  let body = ''
  const ok: Fetch = async (_url, init) => {
    body = init?.body ?? ''
    return reply({ error: 'authorization_pending' })
  }
  expect(await pollToken(ok, 'Iv1.abc', 'dc')).toEqual({ kind: 'pending' })
  expect(new URLSearchParams(body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
  expect(new URLSearchParams(body).get('client_id')).toBe('Iv1.abc')
  const down: Fetch = async () => {
    throw new Error('offline')
  }
  expect(await pollToken(down, 'Iv1.abc', 'dc')).toEqual({ kind: 'pending' })
})

test('sessions are stored per server', () => {
  expect(sessionKey('https://a.example/')).toBe('session:https://a.example')
  expect(sessionKey('https://a.example')).not.toBe(sessionKey('https://b.example'))
})

test('the server config must name a well-formed client ID', () => {
  expect(parseConfig({ githubClientId: 'Iv1.abc' })).toBe('Iv1.abc')
  expect(parseConfig({})).toBeNull()
  expect(parseConfig({ githubClientId: 'a b' })).toBeNull()
  expect(parseConfig({ githubClientId: 'x'.repeat(65) })).toBeNull()
  expect(parseConfig('nope')).toBeNull()
})

test('a session reply with a login GitHub would never issue is rejected', () => {
  expect(parseSession({ session: 's1', login: 'evil\u202Eeman' })).toBeNull()
  expect(parseSession({ session: 's1', login: 'x'.repeat(40) })).toBeNull()
  expect(parseSession({ session: 'bad\nkey', login: 'alice' })).toBeNull()
  expect(parseSession({ session: 'k'.repeat(201), login: 'alice' })).toBeNull()
})

test('GitHub requests give up instead of hanging', async () => {
  const never: Fetch = () => new Promise(() => undefined)
  expect(await requestDeviceCode(never, 'Iv1.abc', () => Promise.resolve())).toBeNull()
  expect(await pollToken(never, 'Iv1.abc', 'dc', () => Promise.resolve())).toEqual({ kind: 'pending' })
})
