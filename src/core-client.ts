/**
 * Core-client plumbing for the galvanize-dsh bundle: serve discovery
 * (~/.galvanize/serve.json + serve.token), the version handshake, and the
 * /manage/<op> proxy. No business logic lives here — the core answers
 * everything; this module only knows the contract (galvanize PLAN rev.4
 * item 9 / this repo PLAN §3).
 *
 * @module galvanize-dsh/core-client
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** API versions this plugin speaks. Bump only together with the core. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1]

export interface ServeInfo {
  port: number
  pid: number
  ts: number
  api_version?: number
}

export interface VersionInfo {
  core_version: string
  api_version: number
}

/** GALVANIZE_HOME override, same resolution order as the core's paths.py. */
export function galvanizeHome(): string {
  const override = (process.env['GALVANIZE_HOME'] ?? '').trim()
  if (override) return override
  return join(homedir(), '.galvanize')
}

export function serveInfoPath(): string {
  return join(galvanizeHome(), 'serve.json')
}

export function serveTokenPath(): string {
  return join(galvanizeHome(), 'serve.token')
}

export function heartbeatPath(): string {
  return join(galvanizeHome(), 'dsh-heartbeat.json')
}

export function surfacesPath(): string {
  return join(galvanizeHome(), 'surfaces.json')
}

/** Read + parse serve.json; null when absent/unparsable (never throws). */
export function readServeInfo(): ServeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(serveInfoPath(), 'utf8')) as Record<string, unknown>
    if (typeof raw?.port !== 'number' || !Number.isFinite(raw.port)) return null
    return { port: raw.port, pid: Number(raw.pid ?? 0), ts: Number(raw.ts ?? 0), api_version: raw.api_version as number | undefined }
  } catch {
    return null
  }
}

export function readToken(): string | null {
  try {
    const tok = readFileSync(serveTokenPath(), 'utf8').trim()
    return tok || null
  } catch {
    return null
  }
}

/**
 * GET /version — deliberately token-free in the core contract, so the
 * installer can probe compat before touching a secret.
 */
export async function fetchVersion(port: number, timeoutMs = 2000): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as VersionInfo
    return typeof body?.api_version === 'number' ? body : null
  } catch {
    return null
  }
}

export function versionOk(info: VersionInfo | null): boolean {
  return !!info && SUPPORTED_API_VERSIONS.includes(info.api_version)
}

export interface OpResult {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

/** Ops whose dispatch is synchronous and can outlive a model turn. */
const LONG_OPS: Record<string, number> = { test: 300_000, add: 120_000, emit: 300_000 }

/**
 * POST /manage/<op> with the bearer token. Network/parse failures come back
 * as {ok:false, error} — tools must return strings, never throw transport
 * errors at the model. test/emit wait for a full wake (headless spawn +
 * model turn), so their budget must cover the slowest dispatch.
 */
export async function callOp(op: string, body: Record<string, unknown>, timeoutMs?: number): Promise<OpResult> {
  const budget = timeoutMs ?? LONG_OPS[op] ?? 30_000
  const info = readServeInfo()
  if (!info) {
    return {
      ok: false,
      error:
        'galvanize core is not serving (no ~/.galvanize/serve.json). Start it: `galvanize run` (or reinstall: `uvx galvanize init`).',
    }
  }
  const token = readToken()
  if (!token) {
    return { ok: false, error: 'galvanize serve token missing at ~/.galvanize/serve.token — restart the core (`galvanize run`).' }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/manage/${encodeURIComponent(op)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(budget),
    })
    const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as OpResult
    if (!res.ok && data.ok === undefined) data.ok = false
    return data
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const timedOut = /timeout|abort/i.test(msg)
    if (timedOut) {
      return { ok: false, error: `galvanize core did not answer /manage/${op} within ${Math.round(budget / 1000)}s (the trigger may still have fired — check trigger_status before retrying; duplicate wakes are deduped anyway)` }
    }
    return { ok: false, error: `galvanize core unreachable on port ${info.port} (${msg}). Is the daemon running? Try: galvanize status` }
  }
}

/**
 * Handshake result cached briefly so every tool call doesn't re-probe.
 * Returns a compatible-version info or a human-readable incompatibility
 * string (tools surface it verbatim instead of failing silently — PLAN §3).
 */
let handshakeCache: { at: number; value: VersionInfo | null } | null = null
const HANDSHAKE_TTL_MS = 15_000

export async function handshake(): Promise<{ info: VersionInfo; incompatible?: undefined } | { info: null; incompatible: string }> {
  if (handshakeCache && Date.now() - handshakeCache.at < HANDSHAKE_TTL_MS) {
    const cached = handshakeCache.value
    return cached && versionOk(cached)
      ? { info: cached }
      : { info: null, incompatible: incompatMessage(cached) }
  }
  const info = readServeInfo()
  const value = info ? await fetchVersion(info.port) : null
  handshakeCache = { at: Date.now(), value }
  if (value && versionOk(value)) return { info: value }
  return { info: null, incompatible: incompatMessage(value) }
}

/** Read-only health proof; always check current credentials, never cache auth. */
export async function probeCoreHealth(): Promise<{ ok: boolean; core_version?: string; error?: string }> {
  const discovery = readServeInfo()
  const info = discovery ? await fetchVersion(discovery.port) : null
  if (!versionOk(info)) return { ok: false, error: incompatMessage(info) }
  const access = await callOp('list', {}, 2000)
  return {
    ok: access.ok === true,
    core_version: info!.core_version,
    ...(access.ok === true ? {} : { error: access.error || 'Authenticated core access failed' }),
  }
}

function incompatMessage(value: VersionInfo | null): string {
  if (!value) return 'galvanize core not reachable — start it (`galvanize run`) or install it (`uvx galvanize init`).'
  return `galvanize core api_version ${value.api_version} (core ${value.core_version}) is outside this plugin's compat range [${SUPPORTED_API_VERSIONS.join(', ')}]. Upgrade either side: pip install -U galvanize | npm install -U galvanize-dsh`
}

/** Test seam: clear the handshake cache. */
export function _resetHandshakeCache(): void {
  handshakeCache = null
}
