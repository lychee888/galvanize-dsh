import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve npm shims to the Node entry, so probes own the actual runtime PID. */
export function resolveNpmDshEntry(directories: string[]): string | null {
  for (const dir of directories) {
    if (!dir) continue
    for (const entry of [
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]) {
      if (existsSync(entry)) return entry
    }
  }
  return null
}
