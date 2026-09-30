/**
 * The helpers inside tests/validate-skills.mjs. The script itself runs in CI
 * as `node tests/validate-skills.mjs`; this file pins its parsing rules.
 *
 * Mutation record: NAME_RE loosened to /^[a-z0-9-]+$/ (allowing a leading,
 * trailing or double hyphen). Caught by "skill names follow the Agent Skills
 * rules". The marketplace lookup changed back to `?? json.plugins[0]` (take
 * the first entry whatever it is called). Caught by "a marketplace must list
 * the plugin by name". The Cursor and Codex marketplace files were missing from
 * the check until 29 Sep 2026; "marketplace files are checked by their plugin
 * entry" pins both.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MANIFESTS, MARKETPLACES, NAME_RE, PLUGIN_NAME, brokenLinks, parseFrontMatter, splitFrontMatter, validate } from './validate-skills.mjs'
import { ROOT, tempFile } from './helpers.mjs'

test('front matter: plain, quoted, folded and nested values', () => {
  const yaml = [
    'name: seo-geo',
    'description: >-',
    '  Folded text that',
    '  continues here.',
    'license: "MIT"',
    'metadata:',
    '  version: "1.0.0"',
    "compatibility: 'Node 18.17 or later'",
  ].join('\n')
  const fm = parseFrontMatter(yaml)
  assert.equal(fm.get('name'), 'seo-geo')
  assert.equal(fm.get('description'), 'Folded text that continues here.')
  assert.equal(fm.get('license'), 'MIT')
  assert.equal(fm.get('compatibility'), 'Node 18.17 or later')
  assert.deepEqual(fm.get('metadata'), { children: ['version: "1.0.0"'] })
})

test('front matter is found only at the top of the file', () => {
  assert.ok(splitFrontMatter('---\nname: x\n---\n# Body\n'))
  assert.equal(splitFrontMatter('# Body\n---\nname: x\n---\n'), null)
})

test('skill names follow the Agent Skills rules', () => {
  for (const ok of ['seo-geo', 'content-review', 'a', 'x1-y2']) assert.ok(NAME_RE.test(ok), ok)
  for (const bad of ['-lead', 'trail-', 'double--hyphen', 'Upper', 'under_score', '']) assert.ok(!NAME_RE.test(bad), bad)
})

test('relative links to missing files are found; URLs, anchors and code are ignored', () => {
  const file = tempFile('doc.md', '')
  const text = '[ok](doc.md) [gone](missing.md) [web](https://example.com) [anchor](#top) `[code](nope.md)`\n\n```\n[fenced](nope2.md)\n```\n'
  assert.deepEqual(brokenLinks(file, text), ['missing.md'])
})

test('the repository validates, or reports each problem in words', () => {
  const { errors, notes } = validate(ROOT)
  assert.ok(Array.isArray(errors))
  assert.ok(notes.some((n) => /manifests: 4 parsed and 3 marketplace\(s\)/.test(n)), notes.join('\n'))
  for (const e of errors) assert.equal(typeof e, 'string')
})

/** A minimal repository: one valid skill, every manifest and marketplace. `edit` changes the file map before writing. */
function fakeRepo(edit = (files) => files) {
  const root = mkdtempSync(join(tmpdir(), 'ebs-validate-'))
  const files = {
    'skills/seo-geo/SKILL.md': '---\nname: seo-geo\ndescription: A demo skill.\n---\n# Demo\n',
    'skills/seo-geo/scripts/lib/cli.mjs': "export const VERSION = '1.0.0'\n",
  }
  for (const m of MANIFESTS) files[m] = { name: PLUGIN_NAME, version: '1.0.0' }
  for (const m of MARKETPLACES) files[m] = { name: 'rankx', plugins: [{ name: PLUGIN_NAME, source: './' }] }
  for (const [path, body] of Object.entries(edit(files))) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

test('marketplace files are checked by their plugin entry, and a version there is optional', () => {
  const { errors, notes } = validate(fakeRepo())
  assert.deepEqual(errors, [])
  assert.ok(notes.some((n) => /4 parsed and 3 marketplace/.test(n)), notes.join('\n'))
  assert.ok(MARKETPLACES.includes('.cursor-plugin/marketplace.json') && MARKETPLACES.includes('.agents/plugins/marketplace.json'))
})

test('a marketplace must list the plugin by name', () => {
  const renamed = validate(fakeRepo((f) => ({ ...f, '.cursor-plugin/marketplace.json': { name: 'rankx', plugins: [{ name: 'something-else', source: './' }] } })))
  assert.ok(renamed.errors.some((e) => /\.cursor-plugin\/marketplace\.json: no plugins\[\] entry named "rankx-seo"/.test(e)), renamed.errors.join('\n'))
  const topLevelOnly = validate(fakeRepo((f) => ({ ...f, '.agents/plugins/marketplace.json': { name: PLUGIN_NAME } })))
  assert.ok(topLevelOnly.errors.some((e) => /\.agents\/plugins\/marketplace\.json: no "plugins" array/.test(e)), topLevelOnly.errors.join('\n'))
  const noSource = validate(fakeRepo((f) => ({ ...f, '.agents/plugins/marketplace.json': { name: 'rankx', plugins: [{ name: PLUGIN_NAME }] } })))
  assert.ok(noSource.errors.some((e) => /has no source/.test(e)), noSource.errors.join('\n'))
  const missing = validate(fakeRepo((f) => {
    delete f['.cursor-plugin/marketplace.json']
    return f
  }))
  assert.ok(missing.errors.includes('.cursor-plugin/marketplace.json: missing'), missing.errors.join('\n'))
})

test('a version on a marketplace entry must agree; a plugin manifest must carry one', () => {
  const disagree = validate(fakeRepo((f) => ({ ...f, '.claude-plugin/marketplace.json': { name: 'rankx', plugins: [{ name: PLUGIN_NAME, source: './', version: '0.9.0' }] } })))
  assert.ok(disagree.errors.some((e) => /versions disagree/.test(e)), disagree.errors.join('\n'))
  const unversioned = validate(fakeRepo((f) => ({ ...f, '.codex-plugin/plugin.json': { name: PLUGIN_NAME } })))
  assert.ok(unversioned.errors.includes('.codex-plugin/plugin.json: no version'), unversioned.errors.join('\n'))
})
