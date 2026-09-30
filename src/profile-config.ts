import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument, type Document } from 'yaml'

const ROW_ID = 'galvanize/tools'
const MARKER = 'galvanize-dsh managed wake profile'

export function validateProfileName(name: string): void {
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid DSH profile name: ${name}`)
  }
}

/** Write the runtime override after bundle installation, preserving other YAML. */
export function persistWakeProfile(profileDir: string, wakeProfile: string): void {
  validateProfileName(wakeProfile)
  const path = join(profileDir, 'cordis.patch.yml')
  const doc: Document = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '[]\n')
  if (doc.errors.length) throw new Error(`Cannot edit ${path}: ${doc.errors[0].message}`)
  if (!doc.contents) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) throw new Error(`${path} must contain a YAML sequence`)
  const row = doc.contents.items.find((item) => isMap(item) && item.get('id') === ROW_ID)
  if (!row) {
    const newRow = doc.createNode({ id: ROW_ID, config: { wakeProfile } })
    newRow.commentBefore = MARKER
    doc.contents.items.push(newRow)
  } else if (isMap(row)) {
    const config = row.get('config', true)
    if (config && !isMap(config)) throw new Error(`${ROW_ID} config must be a YAML mapping`)
    if (!config) row.set('config', doc.createNode({ wakeProfile }))
    else config.set('wakeProfile', wakeProfile)
  }
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, String(doc), 'utf8')
  renameSync(temporary, path)
}

/** Only remove rows created by this installer; leave user-authored overrides. */
export function removeManagedWakeProfile(profileDir: string): void {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return
  const doc: Document = parseDocument(readFileSync(path, 'utf8'))
  if (doc.errors.length || !isSeq(doc.contents)) return
  const items = doc.contents.items
  doc.contents.items = items.filter((item) =>
    !(isMap(item) && item.get('id') === ROW_ID && item.commentBefore?.trim() === MARKER))
  if (doc.contents.items.length !== items.length) writeFileSync(path, String(doc), 'utf8')
}
