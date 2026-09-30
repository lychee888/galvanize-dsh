import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { heartbeatDirectory, PLUGIN_VERSION, readHeartbeat, writeHeartbeat } from '../src/heartbeat.js'
import { probeProfile } from '../src/probe.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-proof-')); process.env.GALVANIZE_HOME = home })
afterEach(() => { delete process.env.GALVANIZE_HOME; rmSync(home, { recursive: true, force: true }) })

it.each([
  ['other profile', { profile: 'other' }],
  ['other version', { plugin_version: '0.0.0' }],
  ['dead PID', { pid: 2147483647 }],
  ['failed core access', { core_api_ok: false }],
  ['other session token', { session_token: 'unrelated' }],
  ['stale proof', { ts: Date.now() - 180_000 }],
])('rejects %s', (_label, override) => {
  const dir = heartbeatDirectory('web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'test.json'), JSON.stringify({
    profile: 'web', plugin_version: PLUGIN_VERSION, pid: process.pid,
    core_api_ok: true, ts: Date.now(), session_token: 'expected', ...override,
  }))
  expect(readHeartbeat('web', 'expected')).toBeNull()
})

it('requires profile-scoped proof even when the legacy heartbeat looks healthy', () => {
  writeFileSync(join(home, 'dsh-heartbeat.json'), JSON.stringify({
    profile: 'web', plugin_version: PLUGIN_VERSION, pid: process.pid,
    core_api_ok: true, ts: Date.now(), session_token: 'expected',
  }))
  expect(readHeartbeat('web')).toBeNull()
})

it('accepts a healthy live session only for its own profile and token', () => {
  expect(writeHeartbeat(true, '0.2.0', 'web', 'expected')).toBe(true)
  expect(readHeartbeat('web', 'expected')?.pid).toBe(process.pid)
  expect(readHeartbeat('headless', 'expected')).toBeNull()
})

it('does not let another live session satisfy a failed boot probe', async () => {
  writeHeartbeat(true, '0.2.0', 'web', 'other-session')
  const script = join(home, 'failed.cjs')
  writeFileSync(script, 'process.exit(1)')
  const result = await probeProfile({ cmd: process.execPath, args: [script] }, 'web', 1000)
  expect(result.ok).toBe(false)
})
