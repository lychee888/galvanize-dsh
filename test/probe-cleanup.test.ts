import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveNpmDshEntry } from '../src/dsh-bin.js'
import { livePid } from '../src/heartbeat.js'
import { probeProfile } from '../src/probe.js'

it.each(['global', 'local'])('stops a failed %s npm runtime probe without a shell descendant', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-probe-cleanup-'))
  const previousHome = process.env.GALVANIZE_HOME
  let pid: number | undefined
  try {
    process.env.GALVANIZE_HOME = home
    const binDir = kind === 'global' ? join(home, 'npm') : join(home, 'project', 'node_modules', '.bin')
    const entry = kind === 'global'
      ? join(binDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : join(binDir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pidFile = join(home, 'runtime.pid')
    mkdirSync(dirname(entry), { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const resolved = resolveNpmDshEntry([binDir])
    expect(resolved).not.toBeNull()
    const probing = probeProfile({ cmd: process.execPath, args: [resolved!] }, 'web', 5000)
    const deadline = Date.now() + 4000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(existsSync(pidFile)).toBe(true)
    pid = Number(readFileSync(pidFile, 'utf8'))
    expect(livePid(pid)).toBe(true)
    expect((await probing).ok).toBe(false)
    expect(livePid(pid)).toBe(false)
  } finally {
    if (pid && livePid(pid)) process.kill(pid)
    if (previousHome === undefined) delete process.env.GALVANIZE_HOME
    else process.env.GALVANIZE_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 10000)
