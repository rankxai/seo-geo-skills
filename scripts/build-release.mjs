#!/usr/bin/env node
/**
 * Builds the release assets: one zip per skill (the skill folder at the zip's
 * root, which is the layout claude.ai's "Upload a skill" expects) and a
 * SHA256SUMS file, all in dist/.
 *
 * The zips come from `git archive` of HEAD, so they hold exactly what is
 * committed. core.autocrlf is switched off for the call: on Windows it would
 * otherwise write CRLF line endings into every text file in the zip, whatever
 * .gitattributes says.
 *
 *   node scripts/build-release.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS = ['seo-geo', 'content-review']
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const dist = join(root, 'dist')

if (process.argv.includes('--help')) {
  console.log('usage: node scripts/build-release.mjs\nWrites dist/<skill>.zip for each skill and dist/SHA256SUMS, from HEAD.')
} else {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'skills'], { cwd: root, encoding: 'utf8' }).trim()
  if (dirty) console.warn('warning: skills/ has uncommitted changes; the zips are built from HEAD and will not include them')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist)
  const sums = []
  for (const skill of SKILLS) {
    const out = join(dist, `${skill}.zip`)
    execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=zip', `--prefix=${skill}/`, '-o', out, `HEAD:skills/${skill}`], { cwd: root })
    sums.push(`${createHash('sha256').update(readFileSync(out)).digest('hex')}  ${skill}.zip`)
  }
  writeFileSync(join(dist, 'SHA256SUMS'), sums.join('\n') + '\n')
  console.log(sums.join('\n'))
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(`built from ${head} into dist/`)
}
