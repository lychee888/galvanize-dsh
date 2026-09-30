/**
 * Plugin behavior tests (PLAN §6): tool registration, dsh-wake translation,
 * handshake gating, heartbeat-on-ACTIVE (and its PENDING counterpart),
 * compat range, core-client proxying.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { apply, buildTools } from '../src/index.js'
import { _resetHandshakeCache, callOp, handshake, SUPPORTED_API_VERSIONS } from '../src/core-client.js'
import { PLUGIN_VERSION, readHeartbeat } from '../src/heartbeat.js'
import { fakeCtx, startStubCore, type StubCore } from './helpers.js'

let core: StubCore
let fake: ReturnType<typeof fakeCtx>

beforeEach(async () => {
  core = await startStubCore()
  fake = fakeCtx()
  _resetHandshakeCache()
})

afterEach(async () => {
  fake.disposeAll()
  await core.close()
  delete process.env.GALVANIZE_HOME
})

const CFG = { wakeProfile: 'headless', heartbeatMs: 5_000 }

describe('apply / registration', () => {
  it('removes session proof when the plugin unloads in a still-live host', async () => {
    apply(fake.ctx as never, { ...CFG, profileIdentity: 'web' })
    await fake.settle()
    expect(readHeartbeat('web')).not.toBeNull()
    fake.disposeAll()
    expect(readHeartbeat('web')).toBeNull()
  })
  it('registers exactly the five trigger tools', () => {
    apply(fake.ctx as never, CFG)
    const names = fake.registered.map((t) => t.name).sort()
    expect(names).toEqual(['trigger_add', 'trigger_list', 'trigger_remove', 'trigger_status', 'trigger_test'])
  })

  it('trigger_add description steers against poll jobs', () => {
    apply(fake.ctx as never, CFG)
    const add = fake.registered.find((t) => t.name === 'trigger_add')
    expect(add.description).toContain('INSTEAD OF')
  })

  it('writes the heartbeat only when ACTIVE (apply ran), and the verify file proves LOADED', async () => {
    apply(fake.ctx as never, CFG)
    await fake.settle()
    const beat = JSON.parse(readFileSync(join(core.home, 'dsh-heartbeat.json'), 'utf8'))
    expect(beat).toMatchObject({ plugin_version: PLUGIN_VERSION, core_api_ok: true, core_version: '0.1.0' })
  })

  it('a PENDING fiber (apply never runs) writes NO heartbeat — what verify catches', async () => {
    // Simulate the unsatisfied-inject case: nothing calls apply().
    await new Promise((r) => setTimeout(r, 50))
    let exists = true
    try {
      readFileSync(join(core.home, 'dsh-heartbeat.json'), 'utf8')
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('records surfaces.json dsh=plugin (exactly-one-surface rule)', async () => {
    apply(fake.ctx as never, CFG)
    await fake.settle()
    const surfaces = JSON.parse(readFileSync(join(core.home, 'surfaces.json'), 'utf8'))
    expect(surfaces).toMatchObject({ dsh: 'plugin' })
  })

  it('heartbeat reflects an unreachable core (core_api_ok=false, still writes)', async () => {
    await core.stopServing()
    _resetHandshakeCache()
    apply(fake.ctx as never, CFG)
    await fake.settle()
    const beat = JSON.parse(readFileSync(join(core.home, 'dsh-heartbeat.json'), 'utf8'))
    expect(beat.core_api_ok).toBe(false)
  })
})

describe('trigger_add wake translation', () => {
  it('refuses a DSH webhook without a relay before contacting the core', async () => {
    const add = buildTools({ wakeProfile: 'custom-wake' }).find(t => t.name === 'trigger_add')!
    const result = await add.execute({ kind: 'webhook', name: 'github' }, {})
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('relay_url')
    expect(core.calls.filter(c => c.op === 'add')).toHaveLength(0)
  })

  it('passes relay configuration and the selected profile into webhook creation', async () => {
    const add = buildTools({ wakeProfile: 'custom-wake' }).find(t => t.name === 'trigger_add')!
    const result = await add.execute({ kind: 'webhook', name: 'github', relay_url: 'https://relay.example', relay_token: 'read-secret' }, {})
    expect(result.ok).toBe(true)
    expect(core.calls.find(c => c.op === 'add')!.body).toMatchObject({
      relay_url: 'https://relay.example', relay_token: 'read-secret',
      command: 'dsh --profile custom-wake "{prompt}"', wake: 'shell',
    })
  })

  it("wake defaults to the dsh preset: wake=shell + command 'dsh --profile headless \"{prompt}\"'", async () => {
    apply(fake.ctx as never, CFG)
    await fake.settle()
    const add = fake.registered.find((t) => t.name === 'trigger_add')
    const out = await add.execute({ kind: 'emit', name: 'demo' }, {})
    expect(out.ok).toBe(true)
    const call = core.calls.find((c) => c.op === 'add')!
    expect(call.body.wake).toBe('shell')
    expect(call.body.command).toBe('dsh --profile headless "{prompt}"')
  })

  it('wakeProfile config flows into the preset command', async () => {
    const tools = buildTools({ wakeProfile: 'web' })
    const add = tools.find((t) => t.name === 'trigger_add')!
    await add.execute({ kind: 'folder', name: 'drops', target: 'C:/tmp' }, {})
    const call = core.calls.find((c) => c.op === 'add')!
    expect(call.body.command).toBe('dsh --profile web "{prompt}"')
  })

  it('wake=shell without command is refused client-side (no core round-trip)', async () => {
    const tools = buildTools({ wakeProfile: 'headless' })
    const add = tools.find((t) => t.name === 'trigger_add')!
    const out = await add.execute({ kind: 'emit', name: 'x', wake: 'shell' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('command')
    expect(core.calls.filter((c) => c.op === 'add')).toHaveLength(0)
  })

  it('explicit command overrides the preset', async () => {
    const tools = buildTools({ wakeProfile: 'headless' })
    const add = tools.find((t) => t.name === 'trigger_add')!
    await add.execute({ kind: 'emit', name: 'x', wake: 'shell', command: 'echo hi' }, {})
    expect(core.calls.find((c) => c.op === 'add')!.body.command).toBe('echo hi')
  })
})

describe('handshake gating + compat', () => {
  it('tools return the upgrade string when core api_version is outside range', async () => {
    core.version = { core_version: '9.9.9', api_version: 99 }
    const tools = buildTools({ wakeProfile: 'headless' })
    const status = tools.find((t) => t.name === 'trigger_status')!
    const out = await status.execute({}, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('outside')
    expect(String(out.error)).toContain('api_version 99')
  })

  it('tools return a clear message when the core is unreachable', async () => {
    await core.stopServing()
    _resetHandshakeCache()
    const tools = buildTools({ wakeProfile: 'headless' })
    const list = tools.find((t) => t.name === 'trigger_list')!
    const out = await list.execute({}, {})
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/not reachable|unreachable/i)
    // ...and no exception escaped — the model must see a value, not a crash
  })

  it('declared compat range is [1]', () => {
    expect(SUPPORTED_API_VERSIONS).toEqual([1])
  })

  it('handshake succeeds against api 1', async () => {
    const hs = await handshake()
    expect(hs.info?.api_version).toBe(1)
  })
})

describe('core-client proxy', () => {
  it('sends the bearer token from serve.token', async () => {
    const res = await callOp('status', {})
    expect(res.ok).toBe(true)
    expect(core.calls[0]!.auth).toBe('Bearer test-token')
  })

  it('proxies op bodies verbatim (core owns behavior)', async () => {
    await callOp('add', { kind: 'folder', name: 'a', foo: { bar: [1, 2] } })
    expect(core.calls[0]!.body).toEqual({ kind: 'folder', name: 'a', foo: { bar: [1, 2] } })
  })

  it('surfaces a core error response unchanged', async () => {
    core.responses['test'] = { ok: false, error: 'no such trigger' }
    const res = await callOp('test', { name: 'ghost' })
    expect(res).toEqual({ ok: false, error: 'no such trigger' })
  })

  it('missing serve.json yields the start-the-core hint', async () => {
    await core.stopServing()
    const { rmSync } = await import('node:fs')
    rmSync(join(core.home, 'serve.json'))
    const res = await callOp('status', {})
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('galvanize run')
  })
})
