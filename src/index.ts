/**
 * galvanize-dsh — native DSH bundle for galvanize event triggers.
 *
 * Puts trigger_add / trigger_list / trigger_remove / trigger_test /
 * trigger_status into a DSH agent's tool schema so "wake me when X happens"
 * becomes a push trigger instead of a poll job (tool-in-schema is the whole
 * point: cron is used because it sits in schema; webhooks were never used
 * because they weren't).
 *
 * Thin client by design (PLAN §3): args are validated here, everything else
 * is delegated to the core's versioned loopback API (`galvanize serve`).
 * No wake logic, no trigger logic in JS — the core answers the same ops the
 * Hermes plugin calls, so behavior can't drift between harnesses.
 *
 * Runtime imports are deliberately ONE symbol from ONE package (`defineTool`),
 * which the host profile already provides via dsh-base. An unsatisfied peer
 * import strands the fiber in PENDING — the silent-failure class this
 * plugin's heartbeat+verify story exists to catch.
 *
 * @module galvanize-dsh
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import { callOp, handshake, surfacesPath } from './core-client.js'
import { PLUGIN_VERSION, writeHeartbeat } from './heartbeat.js'

export const name = 'galvanize-tools'

/** Hard service dependency: without `tools` the fiber stays PENDING. */
export const inject = ['tools']

/** Optional bundle config (row `config:` block in cordis.patch.yml). */
export interface Config {
  /** Headless DSH profile the core's shell-wake spawns per event. */
  wakeProfile?: string
  /** Explicit wake command template; overrides the wakeProfile preset. */
  wakeCommand?: string
  /** Refresh interval for the LOADED heartbeat file, ms. */
  heartbeatMs?: number
}

const DEFAULTS = { wakeProfile: 'headless', heartbeatMs: 30_000 }

/** Unconstrained JSON out: the core owns the result shape; we render it.
 * Declared per-tool (a shared const object defeats defineTool's NoInfer<O>
 * inference and collapses the execute return type to never). */
function jsonOut() {
  return {
    schema: { type: 'json' } as const,
    render: (_args: never, value: unknown) => [
      { type: 'text' as const, text: JSON.stringify(value, null, 2) ?? String(value) },
    ],
  }
}

// ---------------------------------------------------------------- steer text
// The "use this INSTEAD OF a poll job" sentence is the discovery fix — keep
// it in the description, where the model actually reads it (PLAN §4.1).

const ADD_DESC =
  'Create an event trigger that wakes a fresh agent session when something happens. ' +
  'USE THIS INSTEAD OF a scheduled/polling job whenever the user describes an EVENT: ' +
  "'wake me when X lands/arrives/happens', 'notify me when a file shows up', " +
  "'when GitHub pings me...'. Sources: folder (files landing in a directory — {file} " +
  'and {path} usable in prompt), webhook (external service POSTs to a URL we host: ' +
  'GitHub, Stripe, monitoring), emit (named event fired by scripts or other agents via ' +
  "`galvanize emit`), imap (mail arriving; needs password — stored in your OS keyring). " +
  'Always follow up with trigger_test so the user sees the trigger fire once before ' +
  'relying on it.'

const LIST_DESC = 'List all galvanize triggers with their source, wake mode, and settings.'

const REMOVE_DESC = 'Remove a galvanize trigger (and its webhook route if it had one).'

const TEST_DESC =
  'Inject a synthetic event through a trigger\'s real dispatch path and report what happened. ' +
  'ALWAYS run this right after trigger_add so the user sees the trigger work before relying on it.'

const STATUS_DESC =
  'Health of the trigger system: daemon alive?, core API reachable?, per-trigger last-fire ' +
  "time, fires today, last error. Use to answer 'is my trigger still watching?' honestly."

// ---------------------------------------------------------------- tools

/**
 * Every tool call starts with the version handshake: an incompatible or
 * absent core returns a clear upgrade string instead of a silent no-op
 * (PLAN §3 — the failure mode this whole project is built to avoid).
 */
async function guard(
  body: Record<string, unknown>,
  fn: (b: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<any> {
  const hs = await handshake()
  if (!hs.info) return { ok: false, error: hs.incompatible }
  return fn(body)
}

/** Build the five tools against one resolved config. */
export function buildTools(cfg: { wakeProfile: string; wakeCommand?: string }) {
  const wakePreset = cfg.wakeCommand || `dsh --profile ${cfg.wakeProfile} "{prompt}"`

  const triggerAdd = defineTool({
    name: 'trigger_add',
    description: ADD_DESC,
    parameters: {
      kind: { type: 'string', enum: ['folder', 'webhook', 'emit', 'imap'], required: true, description: 'Event source type.' },
      name: { type: 'string', required: true, description: 'lowercase-kebab trigger name.' },
      target: { type: 'string', description: 'folder path to watch (kind=folder) or mailbox address (kind=imap).' },
      prompt: {
        type: 'string',
        description:
          'Instruction for the woken session; placeholders {file} {path} or payload fields like {pull_request.title}.',
      },
      patterns: { type: 'array', items: { type: 'string' }, description: "Filename globs, e.g. ['*.step']." },
      events: { type: 'array', items: { type: 'string' }, description: 'kind=webhook: event types to accept.' },
      relay_url: { type: 'string', description: 'kind=webhook with a DSH/shell wake: required Cloudflare relay URL.' },
      relay_token: { type: 'string', description: 'Bearer token for reading the relay queue (RELAY_TOKEN).' },
      wake: {
        type: 'string',
        description: "Wake target: 'dsh' (default: headless one-shot via the configured preset) or 'shell' (explicit command template with {prompt}/{payload}).",
      },
      command: { type: 'string', description: 'wake=shell: command template with {prompt}/{payload} placeholders.' },
      workdir: { type: 'string', description: 'Wake working directory.' },
      cooldown_s: { type: 'number', description: 'Minimum seconds between wakes (default 0).' },
      deliver: { type: 'string', description: 'Delivery target for results (telegram, discord, slack, log).' },
      password: {
        type: 'string',
        description: 'kind=imap: mailbox password, stored in the OS keyring — never in the trigger file.',
      },
    },
    output: jsonOut(),
    timeoutMs: 150_000,
    async execute(args) {
      const body: Record<string, unknown> = {
        kind: args.kind,
        name: args.name,
        target: args.target ?? '',
        prompt: args.prompt ?? '',
      }
      const wake = args.wake ?? 'dsh'
      if (wake === 'dsh') {
        // The core only knows wake kinds hermes|shell today; a DSH wake is a
        // shell spawn of the headless one-shot (PLAN §1). Translated here so
        // the core stays DSH-agnostic until it gains a native preset.
        body.wake = 'shell'
        body.command = args.command || wakePreset
      } else if (wake === 'shell') {
        if (!args.command) return { ok: false, error: "wake='shell' needs a command template." }
        body.wake = 'shell'
        body.command = args.command
      } else {
        body.wake = wake
        if (args.command) body.command = args.command
      }
      if (args.patterns) body.patterns = args.patterns
      if (args.events) body.events = args.events
      if (args.workdir) body.workdir = args.workdir
      if (args.cooldown_s !== undefined) body.cooldown_s = args.cooldown_s
      if (args.deliver) body.deliver = args.deliver
      if (args.password) body.password = args.password
      if (args.kind === 'webhook' && body.wake !== 'hermes' && !args.relay_url) {
        return { ok: false, error: 'DSH/shell webhooks require relay_url; configure the relay and its ingestion token first.' }
      }
      if (args.relay_url) body.relay_url = args.relay_url
      if (args.relay_token) body.relay_token = args.relay_token
      return guard(body, (b) => callOp('add', b))
    },
  })

  const triggerList = defineTool({
    name: 'trigger_list',
    description: LIST_DESC,
    parameters: {},
    output: jsonOut(),
    async execute() {
      return guard({}, () => callOp('list', {}))
    },
  })

  const triggerRemove = defineTool({
    name: 'trigger_remove',
    description: REMOVE_DESC,
    parameters: { name: { type: 'string', required: true, description: 'Trigger name to remove.' } },
    output: jsonOut(),
    async execute(args) {
      return guard({ name: args.name }, (b) => callOp('remove', b))
    },
  })

  const triggerTest = defineTool({
    name: 'trigger_test',
    description: TEST_DESC,
    parameters: {
      name: { type: 'string', required: true, description: 'Trigger to fire a synthetic event through.' },
      payload: { type: 'json', description: 'Optional synthetic payload.' },
    },
    output: jsonOut(),
    // synchronous dispatch = full wake (headless spawn + model turn)
    timeoutMs: 300_000,
    async execute(args) {
      return guard({ name: args.name, ...(args.payload ? { payload: args.payload } : {}) }, (b) =>
        callOp('test', b),
      )
    },
  })

  const triggerStatus = defineTool({
    name: 'trigger_status',
    description: STATUS_DESC,
    parameters: {},
    output: jsonOut(),
    async execute() {
      return guard({}, () => callOp('status', {}))
    },
  })

  return [triggerAdd, triggerList, triggerRemove, triggerTest, triggerStatus]
}

// ---------------------------------------------------------------- apply

export function apply(ctx: Context, config: Config = {}) {
  const cfg = { ...DEFAULTS, ...config }

  for (const tool of buildTools(cfg)) {
    ;(ctx as any).tools.register(tool)
  }

  // LOADED proof: writes only when ACTIVE (a PENDING fiber never reaches
  // here, which is exactly what `galvanize-dsh verify` tests for).
  ctx.effect(async () => {
    const hs = await handshake()
    writeHeartbeat(!!hs.info, hs.info?.core_version)
    const timer = setInterval(() => {
      void (async () => {
        const beat = await handshake()
        writeHeartbeat(!!beat.info, beat.info?.core_version)
      })()
    }, Math.max(5_000, cfg.heartbeatMs))
    return () => clearInterval(timer)
  }, 'galvanize heartbeat')

  // Surface registry for the exactly-one-surface rule (PLAN §4): the core's
  // `doctor` and `galvanize mcp` consult this and stand the MCP tools down.
  ctx.effect(() => {
    try {
      writeFileSync(surfacesPath(), JSON.stringify({ ...readSurfaces(), dsh: 'plugin' }, null, 2))
    } catch {
      /* best-effort: doctor also detects the patch row directly */
    }
    return () => {}
  }, 'galvanize surface registry')
}

function readSurfaces(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(surfacesPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export { PLUGIN_VERSION }
