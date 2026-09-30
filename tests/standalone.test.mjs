// Each skill must work when installed on its own: claude.ai uploads one folder at a time, and
// `gh skill install` can take one skill. content-review carries copies of three seo-geo helpers
// and the myths catalogue (scripts/sync-shared.mjs); these tests keep that honest.
//
// Mutations applied on 29 Sep 2026 and caught:
//   1. one line edited in skills/content-review/scripts/shared/html.mjs    -> "copies match" fails
//   2. an import in check-prose.mjs pointed back at ../../seo-geo/...        -> "runs alone" fails
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { SHARED, expected } from '../scripts/sync-shared.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the shared copies inside content-review match their seo-geo originals', () => {
  for (const [src, dest, banner] of SHARED) {
    assert.equal(readFileSync(join(ROOT, dest), 'utf8'), expected(src, banner), `${dest} is stale: run node scripts/sync-shared.mjs`)
  }
})

test('content-review runs with no seo-geo folder beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-alone-'))
  try {
    cpSync(join(ROOT, 'skills/content-review'), join(dir, 'content-review'), { recursive: true })
    const draft = join(dir, 'draft.md')
    writeFileSync(draft, '# A page\n\nThis sentence is plain and says one thing.\n')
    const out = execFileSync(process.execPath, [join(dir, 'content-review/scripts/check-prose.mjs'), '--json', draft], { encoding: 'utf8' })
    assert.ok(JSON.parse(out), 'check-prose produced JSON when installed alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seo-geo runs with no content-review folder beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-alone-'))
  try {
    cpSync(join(ROOT, 'skills/seo-geo'), join(dir, 'seo-geo'), { recursive: true })
    const page = join(dir, 'page.html')
    writeFileSync(page, '<!doctype html><html lang="en"><head><title>A page</title></head><body><main><h1>A page</h1><p>Some text.</p></main></body></html>')
    let out
    try {
      out = execFileSync(process.execPath, [join(dir, 'seo-geo/scripts/audit-page.mjs'), '--json', page], { encoding: 'utf8' })
    } catch (err) {
      out = err.stdout // findings exit 1; the JSON is still on stdout
    }
    assert.ok(JSON.parse(out), 'audit-page produced JSON when installed alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
