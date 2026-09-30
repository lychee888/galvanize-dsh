import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readHeartbeat } from './heartbeat.js'

/** Observe proof while the exact probe process is alive, then stop our probe. */
export async function probeProfile(
  dsh: { cmd: string; args: string[]; shell?: boolean }, profile: string, timeoutMs = 30_000, task = false,
): Promise<{ ok: boolean; detail: string }> {
  const token = randomUUID()
  const child = spawn(dsh.cmd, [...dsh.args, '--profile', profile, ...(task ? ['Reply with exactly: GALVANIZE_PROBE'] : [])], {
    env: { ...process.env, GALVANIZE_PROBE_TOKEN: token },
    shell: dsh.shell === true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let error = ''
  let exited = false
  let provenPid: number | undefined
  child.on('error', e => { error = e.message; exited = true })
  child.on('exit', () => { exited = true })
  child.stdout?.on('data', c => { error = (error + String(c)).slice(-8000) })
  child.stderr?.on('data', c => { error = (error + String(c)).slice(-8000) })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline && !exited) {
      const beat = readHeartbeat(profile, token)
      if (beat) {
        provenPid = beat.pid
        return { ok: true, detail: `profile ${profile}, live pid ${beat.pid}, unique probe, healthy core` }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { ok: false, detail: `No healthy live proof for profile ${profile}: ${error || 'probe exited or timed out'}` }
  } finally {
    // Only a process that proved possession of this invocation's random token.
    if (provenPid && provenPid !== child.pid) {
      try { process.kill(provenPid) } catch { /* already exited */ }
    }
    if (!exited) {
      const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill()
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000))])
    }
  }
}
