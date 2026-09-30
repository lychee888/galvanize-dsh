/**
 * galvanize-dsh installer / verifier.
 *
 * install   — mount the bundle into a DSH profile and PROVE it loaded
 * verify    — the three-part LOADED check (patch row, heartbeat, handshake)
 * uninstall — remove the bundle row + surface entry
 *
 * The heartbeat-based verification is the product here (PLAN §3): DSH
 * PENDING fibers fail silently, so an installer that only writes config can
 * never claim success. We never print "should be fine".
 *
 * @module galvanize-dsh/cli
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { sep as SEP, delimiter, dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { callOp, fetchVersion, galvanizeHome, handshake, readServeInfo, surfacesPath, versionOk } from './core-client.js'
import { PLUGIN_VERSION, readHeartbeat } from './heartbeat.js'
import { probeProfile } from './probe.js'
import { resolveNpmDshEntry } from './dsh-bin.js'
import { persistWakeProfile, removeManagedWakeProfile, validateProfileName } from './profile-config.js'

const ROW_ID = 'galvanize/tools'
const PKG = 'galvanize-dsh'

/**
 * What to hand `dsh plugin add`. Priority:
 *  1. explicit --source
 *  2. the package the CLI itself runs from, whenever that's a directory we
 *     can install from (dev checkout *or* the npx cache — `npx github:…`
 *     runs from a cache dir whose published file list is exactly what a
 *     profile needs: lib/ + cordis.patch.yml + package.json)
 *  3. the npm name (only meaningful once published)
 * A profile's node_modules layout is identical either way; dsh's loader
 * resolves packages by walking node_modules upward from the profile, so an
 * absolute install spec works (verified: dsh plugin add accepts abs paths).
 */
function resolvePkgSpec(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..')
    if (existsSync(join(root, 'cordis.patch.yml')) && existsSync(join(root, 'package.json'))) {
      // Directory sources (dev checkout, npx cache) are packed to a tgz:
      // `npm install <dir>` records a SYMLINK and Node ESM resolves through
      // the realpath — a bundle living outside the profile tree can't see
      // @deepseek-ai/* peers there (ERR_MODULE_NOT_FOUND at plugin load).
      // A tarball installs like the published package does: real files,
      // resolvable peers, garbage-collect-safe (npx cache dirs are not).
      const tgz = packToTgz(root)
      if (tgz) return tgz.split(SEP).join('/')
      return root.split(SEP).join('/') // packing failed; last resort
    }
  } catch {
    /* fall through to the npm name */
  }
  return PKG
}

/**
 * Pack a directory package into a tgz under ~/.galvanize and return its
 * path. Packs a CLEANED COPY: npm pack runs lifecycle scripts (prepare =
 * full rebuild, impossible in an npx cache without devDeps; --ignore-scripts
 * was not honored), and the staged copy is a built artifact — we ship lib/
 * as-is.
 */
function packToTgz(root: string): string | null {
  try {
    const workDir = join(galvanizeHome(), 'pack-tmp')
    rmSync(workDir, { recursive: true, force: true })
    const src = join(workDir, 'pkg')
    cpSync(root, src, {
      recursive: true,
      // exclude the package's OWN node_modules — test the path relative
      // to root; in the npx cache every absolute path contains a
      // node_modules ancestor, which used to exclude everything.
      filter: (s) => !relative(root, s).split(SEP).includes('node_modules'),
    })
    const pj = join(src, 'package.json')
    const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { scripts?: Record<string, string> }
    if (pkg.scripts) {
      delete pkg.scripts.prepare
      delete pkg.scripts.prepack
      delete pkg.scripts.postinstall
      writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n')
    }
    const outDir = galvanizeHome()
    const r = spawnSync('npm', ['pack', '--pack-destination', outDir, src], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120_000,
    })
    rmSync(workDir, { recursive: true, force: true })
    if (r.status !== 0) return null
    const name = r.stdout.trim().split('\n').filter(Boolean).pop()
    const p = name ? join(outDir, name) : null
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** Wake profile resolved from --wake-profile (default: headless). */
let WAKE_PROFILE = 'headless'
function cfgWakeProfile(): string {
  return WAKE_PROFILE
}

// ---------------------------------------------------------------- dsh probe

interface DshBin {
  cmd: string
  args: string[]
  note: string
  /** Windows .cmd shims (npm bin on PATH) cannot be spawned without a shell. */
  shell?: boolean
}

/** Locate the dsh CLI: $DSH_BIN, PATH, then the npx cache on this box. */
function findDsh(): DshBin | null {
  const envBin = (process.env['DSH_BIN'] ?? '').trim()
  if (envBin && existsSync(envBin)) return { cmd: process.execPath, args: [envBin], note: `$DSH_BIN=${envBin}` }
  // Resolve npm's Windows shim to Node directly so stopping a probe stops
  // the real process even when it fails before writing a heartbeat.
  if (process.platform === 'win32') {
    const bin = resolveNpmDshEntry((process.env.PATH || '').split(delimiter))
    if (bin) return { cmd: process.execPath, args: [bin], note: `npm entry: ${bin}` }
  }
  const probe = spawnSync('dsh', ['--version'], { shell: process.platform === 'win32', timeout: 15_000, encoding: 'utf8' })
  if (probe.status === 0) return { cmd: 'dsh', args: [], note: 'dsh on PATH', shell: process.platform === 'win32' }
  // npx cache fallback (how DSH is often launched: npx @deepseek-ai/dsh) —
  // npm's cache dir differs per OS.
  const cacheRoots = [
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'), // Windows
    join(homedir(), '.npm', '_npx'), // Linux
    join(homedir(), 'Library', 'Caches', 'npm-cache', '_npx'), // macOS
    join(homedir(), '.cache', 'npx'),
  ]
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue
    try {
      for (const dir of readdirSync(root)) {
        const bin = join(root, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (existsSync(bin)) return { cmd: process.execPath, args: [bin], note: `npx cache: ${bin}` }
      }
    } catch {
      /* keep looking */
    }
  }
  return null
}

function runDsh(dsh: DshBin, argv: string[], timeoutMs = 120_000): { code: number; out: string } {
  const r = spawnSync(dsh.cmd, [...dsh.args, ...argv], {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: dsh.shell === true,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function dshHome(): string {
  const env = (process.env['DSH_HOME'] ?? '').trim()
  if (env) return env
  return join(homedir(), '.dsh')
}

// ---------------------------------------------------------------- verify

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function checkHandshake(): Promise<Check> {
  const info = readServeInfo()
  if (!info) {
    return { name: 'core /version handshake', ok: false, detail: 'no ~/.galvanize/serve.json — start the core: `galvanize run` (install: `uvx galvanize init`)' }
  }
  const v = await fetchVersion(info.port)
  if (!v) return { name: 'core /version handshake', ok: false, detail: `serve.json says port ${info.port} but nothing answered — restart the core` }
  if (!versionOk(v)) {
    return { name: 'core /version handshake', ok: false, detail: `core ${v.core_version} api_version ${v.api_version} outside plugin compat` }
  }
  return { name: 'core /version handshake', ok: true, detail: `core ${v.core_version}, api ${v.api_version}` }
}

async function checkCoreAccess(): Promise<Check> {
  const result = await callOp('list', {}, 2000)
  return { name: 'authenticated core access', ok: result.ok === true,
    detail: result.ok === true ? 'read-only trigger list succeeded' : result.error || 'core access failed' }
}

function checkPatchRow(dsh: DshBin | null, profile: string): Check {
  if (!dsh) return { name: `patch row '${ROW_ID}' in profile ${profile}`, ok: false, detail: 'dsh CLI not found (set DSH_BIN or install @deepseek-ai/dsh)' }
  const { code, out } = runDsh(dsh, ['--profile', profile, '--dump-config'], 60_000)
  if (code !== 0) return { name: `patch row '${ROW_ID}' in profile ${profile}`, ok: false, detail: `dsh --dump-config failed (exit ${code}): ${out.slice(-300)}` }
  const has = new RegExp(`id: ${ROW_ID.replace('/', '\\/')}`).test(out)
  const installed = out.includes(PKG)
  return {
    name: `patch row '${ROW_ID}' in profile ${profile}`,
    ok: has && installed,
    detail: has ? (installed ? 'row present, package resolvable' : `row present but '${PKG}' not found in composed tree`) : 'row missing — run: galvanize-dsh install',
  }
}

function checkHeartbeat(profile: string): Check {
  const beat = readHeartbeat(profile)
  if (!beat) {
    return {
      name: `live plugin heartbeat (profile ${profile})`,
      ok: false,
      detail:
        'no healthy live session proof for this profile and plugin version — start the profile and re-run verify, or reinstall to write its profile identity.',
    }
  }
  const ageS = Math.round((Date.now() - beat.ts) / 1000)
  return {
    name: `live plugin heartbeat (profile ${profile})`,
    ok: true,
    detail: `plugin ${beat.plugin_version}, core_api_ok=${beat.core_api_ok}, ${ageS}s ago (pid ${beat.pid})`,
  }
}

async function cmdVerify(profile: string, dsh: DshBin | null): Promise<number> {
  const checks = [await checkHandshake(), await checkCoreAccess(), checkPatchRow(dsh, profile), checkHeartbeat(profile)]
  console.log(`galvanize-dsh v${PLUGIN_VERSION} — verify (profile: ${profile})`)
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}\n      ${c.detail}`)
  const ok = checks.every((c) => c.ok)
  console.log(ok ? '\nLOADED: all four checks green.' : '\nNOT LOADED: fix the ✘ items above — do not trust the tools until this passes.')
  return ok ? 0 : 1
}


// ------------------------------------------------------------- package add

/** Read profile package.json (null when absent/unparsable). */
function readProfilePkg(profile: string): any | null {
  try {
    return JSON.parse(readFileSync(join(dshHome(), 'profiles', profile, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function depNames(pkg: any): string[] {
  return Object.keys(pkg?.dependencies ?? {})
}

/**
 * Add package specs to a profile: `dsh plugin add` first (the blessed path;
 * it also reconciles dsh.profile.bundles). On failure — e.g. a network stack
 * that kills pnpm's parallel fetches — fall back to npm install in the
 * profile dir and reconcile the bundles list ourselves. Both layouts are
 * plain hoisted node_modules, which is all Cordis resolution needs.
 */
function addPkgsToProfile(dsh: DshBin, profile: string, specs: string[]): { ok: boolean; via: string; out: string } {
  console.log(`> dsh plugin --profile ${profile} add ${specs.join(' ')}`)
  const before = depNames(readProfilePkg(profile))
  const r = runDsh(dsh, ['plugin', '--profile', profile, 'add', ...specs], 300_000)
  if (r.code === 0) return { ok: true, via: 'dsh plugin (pnpm)', out: r.out }
  console.log(`  dsh plugin add failed (exit ${r.code}) — falling back to npm install in the profile dir`)

  const verProbe = runDsh(dsh, ['--version'], 30_000).out.trim()
  const ver = /(\d+\.\d+\.\d+[^\s]*)/.exec(verProbe)?.[1] ?? ''
  const npmSpecs = specs.map((sp) =>
    /^@deepseek-ai\/[a-z0-9-]+$/.test(sp) && ver ? `${sp}@${ver}` : sp)

  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--save-exact', ...npmSpecs], {
    cwd: join(dshHome(), 'profiles', profile),
    shell: process.platform === 'win32',
    timeout: 600_000,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if ((npm.status ?? -1) !== 0) {
    return { ok: false, via: 'npm fallback', out: `${r.out.slice(-400)}
--- npm fallback ---
${(npm.stdout ?? '') + (npm.stderr ?? '')}`.slice(-1600) }
  }
  // Reconcile dsh.profile.bundles: every newly added dependency becomes a
  // bundle row (same rule `dsh plugin add` applies).
  const pkgPath = join(dshHome(), 'profiles', profile, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const after = depNames(pkg)
    const added = after.filter((n) => !before.includes(n))
    const bundles: string[] = pkg?.dsh?.profile?.bundles ?? []
    const merged = [...new Set([...bundles, ...added])]
    pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: merged } }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`  npm fallback ok — bundles now: ${merged.join(', ') || '(none)'}`)
  } catch {
    /* package.json shape unexpected; the installed deps still resolve */
  }
  return { ok: true, via: 'npm fallback', out: (npm.stdout ?? '').slice(-400) }
}

// ---------------------------------------------------------------- install

async function cmdInstall(profile: string, dsh: DshBin | null, pkgSpec: string): Promise<number> {
  const hs = await handshake()
  if (!hs.info) {
    console.error(`galvanize core unreachable: ${hs.incompatible}`)
    console.error('Install/start the core first, then re-run: `uvx galvanize init`')
    return 1
  }
  console.log(`core reachable (${hs.info.core_version}, api ${hs.info.api_version})`)
  if (!dsh) {
    console.error('dsh CLI not found. Fix either way, then re-run install:')
    console.error('  npm install -g @deepseek-ai/dsh          # any OS')
    console.error('  DSH_BIN=<path-to>/dsh/lib/bin.js        # or point at an existing checkout')
    console.error('Meanwhile a DSH wake works with no plugin at all: galvanize add <source> ... --wake shell --command "dsh --profile headless \\"{prompt}\\""')
    return 1
  }
  console.log(`using ${dsh.note}`)

  // Target profile: add our bundle row (dsh plugin add reconciles
  // dsh.profile.bundles automatically). Fresh profiles get base + the app
  // bundle too, or there is nothing to boot.
  const pkgJson = join(dshHome(), 'profiles', profile, 'package.json')
  let needBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  let fresh = true
  if (existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      if ((parsed?.dsh?.profile?.bundles?.length ?? 0) > 0) {
        needBundles = []
        fresh = false
      }
    } catch {
      /* fall through: dsh plugin add reconciles anyway */
    }
  }
  const add = addPkgsToProfile(dsh, profile, [...needBundles, pkgSpec])
  if (!add.ok) {
    console.error(add.out)
    console.error(`install failed while adding bundles to profile '${profile}'`)
    return 1
  }
  console.log(`  via ${add.via}`)
  if (fresh) {
    console.log(`profile '${profile}' was empty — created it with base + web app bundles.`)
    console.log('LLM provider/model still come from $DSH_HOME/settings.yaml.')
  }

  // Wake profile bootstrap: the core spawns `dsh --profile <wakeProfile>
  // "<prompt>"` per event; a fresh profile needs base + the headless app.
  const wakePkg = join(dshHome(), 'profiles', cfgWakeProfile(), 'package.json')
  let wakeBundles: string[] = []
  if (existsSync(wakePkg)) {
    try {
      const parsed = JSON.parse(readFileSync(wakePkg, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      wakeBundles = parsed?.dsh?.profile?.bundles ?? []
    } catch {
      /* bootstrap below */
    }
  }
  if (!wakeBundles.includes('@deepseek-ai/dsh-headless')) {
    const wp = cfgWakeProfile()
    console.log(`wake profile '${wp}' missing the headless app — bootstrapping it`)
    const addW = addPkgsToProfile(dsh, wp, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    if (!addW.ok) {
      console.error(addW.out)
      console.error(`wake-profile bootstrap failed for '${wp}'`)
      return 1
    }
  }
  // Also mount the tools into the wake profile: a session woken by an event
  // can then manage its own triggers, and (the real reason) the installer can
  // prove LOADED autonomously via a headless boot probe below.
  if (!wakeBundles.includes(PKG)) {
    const addW2 = addPkgsToProfile(dsh, cfgWakeProfile(), [pkgSpec])
    if (!addW2.ok) {
      console.error(addW2.out)
      console.error(`wake-profile plugin add failed`)
      return 1
    }
  }

  // Persist the same selection used by the probe into both runtime profiles.
  try {
    for (const p of new Set([profile, cfgWakeProfile()])) {
      persistWakeProfile(join(dshHome(), 'profiles', p), cfgWakeProfile(), p)
    }
  } catch (error) {
    console.error(`Could not save wake profile: ${error}`)
    return 1
  }

  // Surface registry (exactly-one-surface rule): even before first boot,
  // record that DSH should get the plugin, not the MCP tools.
  try {
    const { writeFileSync } = await import('node:fs')
    let existing: Record<string, string> = {}
    try {
      existing = JSON.parse(readFileSync(surfacesPath(), 'utf8'))
    } catch {
      /* new file */
    }
    writeFileSync(surfacesPath(), JSON.stringify({ ...existing, dsh: 'plugin' }, null, 2))
  } catch {
    /* doctor still detects the row */
  }

  const shared = await callOp('configure_dsh_profile', { wake_profile: cfgWakeProfile() })
  if (!shared.ok) {
    console.error(`Could not configure the core's DSH profile: ${shared.error}. Update galvanize core first.`)
    return 1
  }
  const checks: Check[] = [await checkHandshake(), await checkCoreAccess(), checkPatchRow(dsh, profile)]
  for (const p of new Set([profile, cfgWakeProfile()])) {
    console.log(`Probing profile ${p} while its process is alive…`)
    const proof = await probeProfile(dsh, p, 30_000, p === cfgWakeProfile())
    checks.push({ name: `live plugin proof (${p})`, ...proof })
  }
  for (const check of checks) console.log(`  ${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}`)
  const ok = checks.every(check => check.ok)
  console.log(ok ? 'LOADED: all profile probes passed while alive; probe processes stopped.' : 'NOT LOADED: fix the failed checks.')
  return ok ? 0 : 1
}

async function cmdUninstall(profile: string, dsh: DshBin | null): Promise<number> {
  let code = 0
  if (dsh) {
    const targets = profile === cfgWakeProfile() ? [profile] : [profile, cfgWakeProfile()]
    for (const p of targets) {
      const r = runDsh(dsh, ['plugin', '--profile', p, 'remove', PKG], 300_000)
      console.log(r.out.slice(-600))
      if (r.code !== 0) code = r.code
      else removeManagedWakeProfile(join(dshHome(), 'profiles', p))
    }
  } else {
    console.error('dsh CLI not found — remove manually: `dsh plugin --profile ' + profile + ' remove ' + PKG + '`')
    code = 1
  }
  try {
    const { writeFileSync } = await import('node:fs')
    let existing: Record<string, string> = {}
    try {
      existing = JSON.parse(readFileSync(surfacesPath(), 'utf8'))
    } catch {
      /* nothing to clean */
    }
    delete existing['dsh']
    writeFileSync(surfacesPath(), JSON.stringify(existing, null, 2))
    console.log('surface registry updated (dsh → unset; core init may re-register MCP).')
  } catch {
    /* ignore */
  }
  return code
}

// ---------------------------------------------------------------- main

/** Enforce package.json engines (^22.19 || >=24) with a clear message. */
function nodeOk(): boolean {
  const m = /v(\d+)\.(\d+)/.exec(process.versions.node)
  if (!m) return true
  const major = Number(m[1])
  const minor = Number(m[2])
  return (major === 22 && minor >= 19) || major >= 24 || (major > 22 && major < 24 && process.env.GALVANIZE_DSH_UNSAFE_NODE === '1')
}

/**
 * Offer to install the dsh CLI when it's missing (TTY only — non-interactive
 * contexts keep the guidance message). npm -g is the blessed path on all OS.
 */
async function maybeInstallDsh(): Promise<DshBin | null> {
  if (!process.stdin.isTTY) return null
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Install @deepseek-ai/dsh globally via npm now? [Y/n] ')
  rl.close()
  if (/^\s*[nN]/.test(answer)) return null
  console.log('> npm install -g @deepseek-ai/dsh')
  const r = spawnSync('npm', ['install', '-g', '@deepseek-ai/dsh', '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 600_000,
  })
  if ((r.status ?? -1) !== 0) {
    console.error('npm global install failed — on Linux use a user-owned npm prefix (nvm) rather than sudo, then re-run install.')
    return null
  }
  return findDsh()
}

async function main(): Promise<number> {
  if (!nodeOk()) {
    console.error(`Node ${process.versions.node} is unsupported: galvanize-dsh requires ^22.19 || >=24 (DSH's range). Install one, e.g.: nvm install 22`)
    return 1
  }
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'help'
  const profileIdx = argv.indexOf('--profile')
  const profile = profileIdx >= 0 ? (argv[profileIdx + 1] ?? 'web') : 'web'
  const wakeIdx = argv.indexOf('--wake-profile')
  if (wakeIdx >= 0 && argv[wakeIdx + 1]) WAKE_PROFILE = argv[wakeIdx + 1]
  try {
    validateProfileName(profile)
    validateProfileName(cfgWakeProfile())
  } catch (error) {
    console.error(String(error))
    return 2
  }
  const srcIdx = argv.indexOf('--source')
  const pkgSpec = srcIdx >= 0 && argv[srcIdx + 1] ? argv[srcIdx + 1] : resolvePkgSpec()
  let dsh = findDsh()

  switch (cmd) {
    case 'install':
      if (!dsh && process.stdin.isTTY) dsh = await maybeInstallDsh()
      return cmdInstall(profile, dsh, pkgSpec)
    case 'verify':
      return cmdVerify(profile, dsh)
    case 'uninstall':
      return cmdUninstall(profile, dsh)
    default:
      console.log(`galvanize-dsh v${PLUGIN_VERSION}

Usage:
  galvanize-dsh install   [--profile <p>] [--wake-profile <wp>] [--source <spec>]  mount the bundle into a DSH profile (default: web), bootstrap the wake profile (default: headless), boot-probe, then verify
                          --source: npm name | path | tarball (default: this checkout when run from one, else the npm name)
  galvanize-dsh verify    [--profile <p>]                        LOADED check: patch row ∧ fresh heartbeat ∧ /version handshake
  galvanize-dsh uninstall [--profile <p>] [--wake-profile <wp>]  remove the bundle + surface registry entry

The verify step is not a formality: DSH loads a broken plugin as a silent
PENDING fiber. Only these three green checks mean the trigger_* tools exist.`)
      return cmd === 'help' ? 0 : 2
  }
}

main().then((code) => {
  process.exitCode = code
})
