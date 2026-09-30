/** Real Python core + official DSH CLI, with isolated homes and no model calls. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { _resetHandshakeCache, callOp, handshake } from '../src/core-client.js'
import { buildTools } from '../src/index.js'
import { probeProfile } from '../src/probe.js'
import { heartbeatDirectory, PLUGIN_VERSION } from '../src/heartbeat.js'

const coreSource = resolve(process.env.GALVANIZE_CORE_SOURCE || '../galvanize')
const python = process.env.GALVANIZE_CORE_PYTHON || 'python'
let home: string
let core: ChildProcess
let errors = ''
const previousEnv = { ...process.env }

beforeAll(async () => {
  if (!existsSync(join(coreSource, 'galvanize', 'serve.py'))) throw new Error('Set GALVANIZE_CORE_SOURCE to the follow-up core checkout (see README).')
  home = mkdtempSync(join(tmpdir(), 'gz-real-integration-'))
  process.env.GALVANIZE_HOME = join(home, 'galvanize')
  process.env.HERMES_HOME = join(home, 'hermes')
  process.env.DSH_HOME = join(home, 'dsh')
  process.env.PYTHONPATH = coreSource
  core = spawn(python, ['-u', '-m', 'galvanize.cli', 'serve', '--foreground'], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  core.stdout?.on('data', c => { errors += c })
  core.stderr?.on('data', c => { errors += c })
  core.on('error', e => { errors += e.message })
  // Allow slow runner startup, checking actual API readiness throughout.
  const deadline = Date.now() + 45_000
  let lastError = ''
  while (Date.now() < deadline && core.exitCode === null) {
    _resetHandshakeCache()
    const result = await handshake()
    if (result.info) return
    lastError = result.incompatible
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Real core failed to start (exit ${core.exitCode}): ${lastError}\n${errors}`)
}, 60_000)

afterAll(async () => {
  if (core && core.exitCode === null) {
    const exited = new Promise<void>(r => core.once('exit', () => r()))
    core.kill()
    await exited
  }
  for (const key of ['GALVANIZE_HOME', 'HERMES_HOME', 'DSH_HOME', 'PYTHONPATH']) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  _resetHandshakeCache()
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it.each(['headless', 'custom-wake'])('CLI and plugin persist identical %s wake commands through the real core', async profile => {
  expect((await callOp('configure_dsh_profile', { wake_profile: profile })).ok).toBe(true)
  const cli = spawnSync(python, ['-m', 'galvanize.cli', 'add', 'emit', '--name', `cli-${profile}`, '--wake', 'dsh'], { env: process.env, encoding: 'utf8', windowsHide: true })
  expect(cli.status, cli.stderr).toBe(0)
  const add = buildTools({ wakeProfile: profile }).find(t => t.name === 'trigger_add')!
  expect((await add.execute({ kind: 'emit', name: `plugin-${profile}` }, {})).ok).toBe(true)
  const result = await callOp('list', {})
  const rows = result.triggers as Record<string, { wake: { command: string } }>
  expect(rows[`plugin-${profile}`]?.wake.command).toBe(`dsh --profile ${profile} "{prompt}"`)
  expect(rows[`cli-${profile}`]?.wake.command).toEqual(rows[`plugin-${profile}`]?.wake.command)
})

it('boots the official DSH runtime and observes this plugin activating against the real core', async () => {
  const profile = 'integration'
  const dir = join(process.env.DSH_HOME!, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'integration', private: true, type: 'module', dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), stringify([{ insert: [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'galvanize/tools', name: pathToFileURL(resolve('lib/index.js')).href, config: { profileIdentity: profile, wakeProfile: 'headless' } },
  ] }]))
  const result = await probeProfile({ cmd: process.execPath, args: [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')] }, profile, 20_000)
  expect(result.ok, result.detail).toBe(true)
}, 25_000)

it.each([
  ['other profile', { profile: 'other' }],
  ['other version', { plugin_version: '0.0.0' }],
  ['dead PID', { pid: 2147483647 }],
  ['failed core access', { core_api_ok: false }],
])('actual verify CLI refuses %s despite a valid patch and healthy core', (_label, override) => {
  const dir = heartbeatDirectory('integration')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'invalid.json'), JSON.stringify({
    profile: 'integration', plugin_version: PLUGIN_VERSION, pid: process.pid,
    core_api_ok: true, ts: Date.now(), session_token: 'test-session', ...override,
  }))
  const result = spawnSync(process.execPath, [resolve('lib/cli.js'), 'verify', '--profile', 'integration'], {
    env: { ...process.env, DSH_BIN: resolve('node_modules/@deepseek-ai/dsh/lib/bin.js') },
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  })
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(result.stdout).toContain('row present, package resolvable')
  expect(result.stdout).toContain('NOT LOADED')
  expect(result.stdout).not.toContain('LOADED: all three checks green')
})
