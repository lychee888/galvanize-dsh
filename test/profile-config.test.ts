import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { persistWakeProfile, removeManagedWakeProfile, validateProfileName } from '../src/profile-config.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'galvanize-profile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('persists the selected wake profile as a runtime override, idempotently', () => {
  persistWakeProfile(dir, 'custom-wake')
  persistWakeProfile(dir, 'custom-wake')
  const rows = parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))
  expect(rows).toEqual([{ id: 'galvanize/tools', config: { wakeProfile: 'custom-wake' } }])
  removeManagedWakeProfile(dir)
  expect(parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))).toEqual([])
})

it('updates an existing row without deleting settings, comments, or custom tags', () => {
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, '# existing settings\n- id: other\n  config:\n    expression: !!js process.env.KEY\n- id: galvanize/tools\n  config:\n    heartbeatMs: 15000\n    wakeProfile: old\n')
  persistWakeProfile(dir, 'custom-wake')
  const output = readFileSync(path, 'utf8')
  expect(output).toContain('# existing settings')
  expect(output).toContain('!!js process.env.KEY')
  expect(output).toContain('heartbeatMs: 15000')
  expect(output).toContain('wakeProfile: custom-wake')
  removeManagedWakeProfile(dir)
  expect(readFileSync(path, 'utf8')).toBe(output)
})

it('leaves malformed or incompatible YAML untouched', () => {
  const path = join(dir, 'cordis.patch.yml')
  for (const input of ['[broken', 'config: wrong-shape', '- id: galvanize/tools\n  config: !!js dynamicConfig\n']) {
    writeFileSync(path, input)
    expect(() => persistWakeProfile(dir, 'custom-wake')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(input)
  }
})

it('rejects profile names that can escape a profile directory', () => {
  for (const name of ['', '..', '../other', 'a/b', 'a\\b', 'x & echo y']) {
    expect(() => validateProfileName(name)).toThrow()
  }
  expect(() => validateProfileName('my-wake_2')).not.toThrow()
})

it('persists distinct target identity alongside the shared wake profile', () => {
  persistWakeProfile(dir, 'custom-wake', 'web')
  expect(parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))[0].config).toEqual({ wakeProfile: 'custom-wake', profileIdentity: 'web' })
})
