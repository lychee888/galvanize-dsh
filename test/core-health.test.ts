import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { _resetHandshakeCache, probeCoreHealth } from '../src/core-client.js'
import { readHeartbeat } from '../src/heartbeat.js'
import { fakeCtx, startStubCore } from './helpers.js'

it.each(['missing', 'wrong'])('rejects a %s credential and recovers after replacement', async kind => {
  const core = await startStubCore()
  const fake = fakeCtx()
  try {
    _resetHandshakeCache()
    expect((await probeCoreHealth()).ok).toBe(true)
    if (kind === 'missing') unlinkSync(join(core.home, 'serve.token'))
    else writeFileSync(join(core.home, 'serve.token'), 'incorrect-token')
    expect((await probeCoreHealth()).ok).toBe(false)
    apply(fake.ctx as never, { profileIdentity: 'web', heartbeatMs: 5000 })
    await fake.settle()
    const diagnostic = JSON.parse(readFileSync(join(core.home, 'dsh-heartbeat.json'), 'utf8'))
    expect(diagnostic.core_api_ok).toBe(false)
    expect(readHeartbeat('web')).toBeNull()
    writeFileSync(join(core.home, 'serve.token'), 'test-token')
    expect((await probeCoreHealth()).ok).toBe(true)
  } finally {
    fake.disposeAll()
    await core.close()
    delete process.env.GALVANIZE_HOME
    _resetHandshakeCache()
  }
})
