/**
 * check-overlap.mjs and the shingle and Jaccard helpers.
 *
 * Mutation record: jaccard() changed to divide by the larger set only
 * (containment instead of Jaccard). Caught by "identical passages score 1
 * and unrelated passages score 0", which pins the exact value for a partial
 * overlap.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { OVERLAP_FAIL_AT, OVERLAP_WARN_AT, jaccard, shingles } from '../skills/content-review/scripts/lib/content.mjs'
import { CONTENT, fixture, run, runJson } from './helpers.mjs'

const CHECK = join(CONTENT, 'check-overlap.mjs')

test('identical passages score 1 and unrelated passages score 0', () => {
  const a = shingles('the quick brown fox jumps over the lazy dog')
  assert.equal(jaccard(a, a), 1)
  assert.equal(jaccard(a, shingles('an entirely different sentence about something else altogether')), 0)
  // 5 shingles each, 4 shared: 4 / (5 + 5 - 4)
  const b = shingles('the quick brown fox jumps over the lazy cat')
  assert.equal(jaccard(a, b), 4 / 6)
})

test('a passage shorter than one shingle scores 0 rather than dividing by zero', () => {
  assert.equal(jaccard(shingles('too short'), shingles('too short')), 0)
})

test('shingles ignore case, punctuation and Markdown emphasis', () => {
  assert.deepEqual([...shingles('**The** Quick, brown [fox](https://x.y) jumps!')], ['the quick brown fox jumps'])
})

test('a restated section across two files fails; different sections do not', async () => {
  const r = await runJson(CHECK, [join(fixture('overlap'))])
  assert.equal(r.code, 1)
  assert.equal(r.json.pairs.length, 1)
  const [pair] = r.json.pairs
  assert.ok(pair.score >= OVERLAP_FAIL_AT)
  assert.deepEqual([pair.a.heading, pair.b.heading].sort(), ['What do I get on the standard plan?', 'What the plan includes'])
})

test('files with no shared passages pass, and HTML is read by its headings', async () => {
  const r = await runJson(CHECK, [fixture('overlap/guide.html'), fixture('overlap/pricing.md')])
  assert.equal(r.code, 0)
  assert.equal(r.json.pairs.length, 0)
  assert.ok(r.json.distribution.sections >= 4)
})

test('thresholds are adjustable, and --report prints the distribution without failing', async () => {
  const lenient = await runJson(CHECK, [fixture('overlap'), '--fail', '0.99', '--warn', '0.5'])
  assert.equal(lenient.code, 0)
  assert.ok(lenient.json.findings.some((f) => f.level === 'warn'))
  const report = await run(CHECK, [fixture('overlap'), '--report'])
  assert.equal(report.code, 0)
  assert.match(report.stdout, /median .* p90 .* p99 .* max/)
  assert.ok(OVERLAP_WARN_AT < OVERLAP_FAIL_AT)
})

test('fewer than two files is not checked; bad thresholds are usage errors', async () => {
  assert.equal((await run(CHECK, [fixture('overlap/faq.md')])).code, 3)
  assert.equal((await run(CHECK, [fixture('overlap'), '--warn', '2'])).code, 2)
  assert.equal((await run(CHECK, ['no-such-dir'])).code, 2)
  assert.equal((await run(CHECK, [])).code, 2)
})
