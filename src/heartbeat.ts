/**
 * Heartbeat: the LOADED proof (PLAN §3). A PENDING Cordis fiber fails
 * silently — typo'd module path or unsatisfied `inject` means `apply` never
 * runs, with no crash and no notice channel. Writing this file from inside
 * `apply` under `ctx.effect` makes "did the plugin actually load?" a
 * filesystem question the installer can verify.
 *
 * @module galvanize-dsh/heartbeat
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { galvanizeHome, heartbeatPath } from './core-client.js'

export const PLUGIN_VERSION = '0.1.6'

export interface Heartbeat {
  plugin_version: string
  core_api_ok: boolean
  core_version?: string
  ts: number
  pid: number
  profile: string
  session_token: string
}

export function heartbeatDirectory(profile: string): string {
  if (!/^[\w.-]+$/.test(profile) || profile === '.' || profile === '..') throw new Error('Invalid heartbeat profile')
  return join(galvanizeHome(), 'dsh-heartbeats', profile)
}

export function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function removeHeartbeat(profile: string, sessionToken: string): void {
  try { unlinkSync(join(heartbeatDirectory(profile), `${process.pid}-${sessionToken}.json`)) } catch { /* absent */ }
}

/** Write the heartbeat; returns false when the file could not be written. */
export function writeHeartbeat(coreApiOk: boolean, coreVersion?: string, profile = 'unknown', sessionToken = ''): boolean {
  const beat: Heartbeat = {
    plugin_version: PLUGIN_VERSION,
    core_api_ok: coreApiOk,
    ...(coreVersion ? { core_version: coreVersion } : {}),
    ts: Date.now(),
    pid: process.pid,
    profile,
    session_token: sessionToken,
  }
  try {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionToken)) return false
    const dir = heartbeatDirectory(profile)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${process.pid}-${sessionToken}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(beat), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    // Last-heartbeat diagnostic retained for older tools; never verification proof.
    writeFileSync(heartbeatPath(), JSON.stringify(beat), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Read a heartbeat written by any process; null when absent/stale/unparsable. */
export function readHeartbeat(profile: string, sessionToken?: string, maxAgeMs = 120_000): Heartbeat | null {
  try {
    const dir = heartbeatDirectory(profile)
    const beats: Heartbeat[] = []
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Heartbeat
        if (!Number.isFinite(raw.ts) || raw.ts > Date.now() + 1000 || Date.now() - raw.ts > maxAgeMs) continue
        if (raw.profile !== profile || raw.plugin_version !== PLUGIN_VERSION || raw.core_api_ok !== true) continue
        if (!raw.session_token || (sessionToken && raw.session_token !== sessionToken) || !livePid(raw.pid)) continue
        beats.push(raw)
      } catch { /* another process may be writing or removing a record */ }
    }
    return beats.sort((a, b) => b.ts - a.ts)[0] ?? null
  } catch {
    return null
  }
}
