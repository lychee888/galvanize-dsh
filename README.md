![galvanize-dsh: triggers inside your DSH agent](./hero.png)

**Give your DeepSeek Harness agent a way to wake itself up.** Once this
bundle is installed, your DSH agent registers event triggers by itself: a
file landing in a folder, an email arriving, a webhook firing, a git push.
When one happens, the galvanize core spawns a **fresh headless DSH session**
with your prompt and the event's data — so "wake me when a resume shows up
in my downloads" is a real push trigger, not a poll job. The plugin itself is
a thin, verified client: five `trigger_*` tools in the agent schema, every
answer proxied from the core's local API. Installation ends by *proving the
plugin loaded* — a headless boot-probe plus three green checks — because a
broken DSH plugin fails as a silent no-op, and "should be fine" is the one
answer this installer refuses to give.

## Install

Works on Windows, macOS, and Linux (Node ^22.19 || >=24 — DSH's own range).
No cloning needed; one command runs straight from GitHub:

```bash
npx github:lychee888/galvanize-dsh install
# or global: npm install -g github:lychee888/galvanize-dsh
# from a clone: npm ci && node lib/cli.js install
```

`install` needs two things on the machine first:

```bash
# 1. the galvanize core (same family; daemon + autostart included):
pipx install "git+https://github.com/lychee888/galvanize.git"
galvanize init

# 2. DeepSeek Harness with its CLI on PATH:
npm install -g @deepseek-ai/dsh
```

Then that one `npx github:…` command mounts the bundle into your DSH `web`
profile (`--profile <p>` to change), bootstraps the headless wake profile,
boots DSH once as a probe, and prints three green checks only if the plugin
is verifiably running:

```
  ✔ core /version handshake        core 0.1.2, api 1
  ✔ patch row 'galvanize/tools'    row present, package resolvable
  ✔ plugin heartbeat               plugin 0.1.2, core_api_ok=true, 3s ago
LOADED: all three checks green.
```

`galvanize-dsh verify` re-runs those checks any time;
`galvanize-dsh uninstall` reverses everything.

## First trigger

```bash
galvanize add folder ~/inbox --name triage --wake dsh \
  --prompt 'Read {file} and write a triage summary to ~/inbox-out/{file}.md'

echo hello > ~/inbox/demo.txt   # a minute later: ~/inbox-out/demo.txt.md
```

Or skip the CLI and just tell your agent in a DSH chat:
*"wake me when a lab report lands in my inbox"* — it calls `trigger_add`
itself, test-fires once so you watch it work, and stays quiet until the
event actually happens.

## What the agent gets

| Tool | What it does |
|---|---|
| `trigger_add` | register a trigger (folder / webhook / emit / imap) — *the event-shaped alternative to a poll job* |
| `trigger_list` | what's watching, with settings |
| `trigger_test` | fire a synthetic event through the real dispatch path |
| `trigger_status` | honest health: daemon, last fire, fires today, last error |
| `trigger_remove` | take one out (route cleanup included) |

```
event ── galvanize core ── wake ──▶ dsh --profile headless "<your prompt>"
 (folder/        (dedupe, cooldown,          │
  mail/webhook/   routes, delivery)          ▼
  git/emit)                          fresh DSH session
```

- **Thin client:** no wake or trigger logic in JS — everything proxies to the
  core's loopback API (`GET /version`, `POST /manage/<op>`, bearer token), so
  behavior matches the core's plugins for Hermes / Claude Code / Codex.
- **Exactly-one-surface:** plugin and `galvanize mcp` never coexist; the
  active one claims `~/.galvanize/surfaces.json` and the core's `doctor`
  flags double-mounts.
- **Wake preset:** the core spawns `dsh --profile <wakeProfile> "<prompt>"`
  per event; the profile, command, and heartbeat cadence are config on the
  bundle row.

## Development

```bash
npm ci && npm run build && npx vitest run && npx publint
```

`src/index.ts` (tools) · `src/core-client.ts` (serve client) ·
`src/cli.ts` (installer / verify / uninstall) · `test/` (18 tests against a
stub core — no DSH needed). CI runs the matrix on Windows, Linux, and macOS.

## License

MIT
