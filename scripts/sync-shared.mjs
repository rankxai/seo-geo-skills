#!/usr/bin/env node
/**
 * Keep content-review self-contained.
 *
 * Each skill must work when installed on its own (claude.ai uploads one skill folder at a time,
 * and `gh skill install` can take one skill). content-review's scripts need three helpers and the
 * myths catalogue from seo-geo, so this copies them into content-review. The originals in seo-geo
 * are the only ones to edit.
 *
 *   node scripts/sync-shared.mjs          copy
 *   node scripts/sync-shared.mjs --check  exit 1 if any copy is out of date (CI runs this via tests)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BANNER = '// Generated copy of skills/seo-geo/%s. Edit the original, then run: node scripts/sync-shared.mjs\n'

export const SHARED = [
  ['skills/seo-geo/scripts/lib/cli.mjs', 'skills/content-review/scripts/shared/cli.mjs', true],
  ['skills/seo-geo/scripts/lib/html.mjs', 'skills/content-review/scripts/shared/html.mjs', true],
  ['skills/seo-geo/scripts/lib/myths.mjs', 'skills/content-review/scripts/shared/myths.mjs', true],
  ['skills/seo-geo/data/myths.json', 'skills/content-review/data/myths.json', false],
]

/** The exact bytes a copy should contain. */
export function expected(src, withBanner) {
  const body = readFileSync(join(ROOT, src), 'utf8')
  return withBanner ? BANNER.replace('%s', src.replace('skills/seo-geo/', '')) + body : body
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/sync-shared.mjs [--check]\nCopies the shared seo-geo helpers and myths.json into content-review. --check reports drift without writing.')
    return
  }
  const check = process.argv.includes('--check')
  const stale = []
  for (const [src, dest, banner] of SHARED) {
    const want = expected(src, banner)
    const path = join(ROOT, dest)
    const have = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (have === want) continue
    if (check) {
      stale.push(dest)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, want)
    console.log(`copied ${src} -> ${dest}`)
  }
  if (check && stale.length) {
    console.error(`Out of date (run node scripts/sync-shared.mjs):\n  ${stale.join('\n  ')}`)
    process.exitCode = 1
  } else if (check) {
    console.log('shared copies are up to date')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
