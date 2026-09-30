/**
 * check-prose.mjs, lib/prose.mjs and the figure and readability helpers in
 * lib/content.mjs.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/content.mjs FIGURE_RE: `per ?cent\b|` removed. Caught by
 *     "percentages are found in every spelling, including per cent".
 *   - lib/content.mjs FIGURE_RE: the per cent alternative removed. Caught by
 *     "percentages are found in every spelling" and "the CLI counts per cent
 *     figures as figures".
 *   - lib/prose.mjs withoutQuotedRegions: the "off" marker pattern broken
 *     so no region is ever removed. Caught by "an off/on region is skipped
 *     in every mode".
 *   - lib/prose.mjs: the em dash rule's regex changed to the en dash
 *     (U+2013). Caught by "an em dash is an error, an en dash is not".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { checkProse } from '../skills/content-review/scripts/lib/prose.mjs'
import { FIGURE_RE, fkGrade, parseDocument, unsourcedFigures } from '../skills/content-review/scripts/lib/content.mjs'
import { CONTENT, fixture, readFixture, run, runJson, rules, tempFile } from './helpers.mjs'

const PROSE = join(CONTENT, 'check-prose.mjs')
const md = (text, opts) => checkProse(text, { format: 'markdown', ...opts }).findings

test('a clean draft has no errors or warnings', async () => {
  const r = await runJson(PROSE, [fixture('draft-clean.md')])
  assert.equal(r.code, 0, r.stdout)
  const serious = r.json.files[0].findings.filter((f) => f.level === 'error' || f.level === 'warn')
  assert.deepEqual(serious, [])
})

test('the tell-laden draft reports words, phrases, shapes, myths and figures', async () => {
  const r = await runJson(PROSE, [fixture('draft-tells.md')])
  assert.equal(r.code, 1)
  const f = r.json.files[0].findings
  assert.ok(rules(f, 'error').includes('tell-phrases'))
  assert.ok(rules(f, 'error').includes('tell-shapes'))
  assert.ok(rules(f, 'warn').includes('tell-words'))
  assert.ok(f.some((x) => x.rule === 'tell-words' && /cluster/.test(x.message)))
  assert.ok(rules(f, 'warn').includes('myth:llms-txt-helps-google'))
  assert.ok(rules(f, 'warn').includes('myth:geo-paper-cite-sources-top-40'))
  assert.ok(rules(f, 'warn').includes('unsourced-figure'))
})

test('percentages are found in every spelling, including per cent', () => {
  const found = (s) => [...s.matchAll(FIGURE_RE)].map((m) => m[0])
  assert.deepEqual(found('a 47 per cent lift'), ['47 per cent'])
  assert.deepEqual(found('a 47 percent lift'), ['47 percent'])
  assert.deepEqual(found('a 47percent lift'), ['47percent'])
  assert.deepEqual(found('47% of pages'), ['47%'])
  assert.deepEqual(found('2.5x more and 3 times as many and 4 million users'), ['2.5x', '3 times', '4 million'])
  assert.deepEqual(found('In 2026 we saw 120 pages'), [], 'a bare number is not a figure')
})

test('a figure is sourced by a link in its sentence, a link, or a Sources section', () => {
  const doc = (s) => parseDocument(s)
  assert.equal(unsourcedFigures(doc('Visits rose 12% last year.')).length, 1)
  assert.equal(unsourcedFigures(doc('Visits rose 12% last year ([report](https://example.com/r)).')).length, 0)
  assert.equal(unsourcedFigures(doc('Visits rose 12% last year.\n\n[The 12% report](https://example.com/r)')).length, 0)
  assert.equal(unsourcedFigures(doc('Visits rose 12 per cent.\n\n## Sources\n\n- Annual report: 12 per cent rise, https://example.com/r')).length, 0)
  assert.equal(unsourcedFigures(doc('Visits rose 12 per cent.\n\n## Notes\n\n- 12 per cent is our estimate')).length, 1, 'a Notes section is not a Sources section')
})

test('--strict turns unsourced figures into errors', async () => {
  const file = tempFile('d.md', '# T\n\nVisits rose 12% last year.\n')
  assert.equal((await run(PROSE, [file])).code, 0)
  const strict = await runJson(PROSE, [file, '--strict'])
  assert.equal(strict.code, 1)
  assert.ok(rules(strict.json.files[0].findings, 'error').includes('unsourced-figure'))
})

test('the CLI counts "per cent" figures as figures, not only "%" (British spelling included)', async () => {
  // A quantified-claims check that knew only "%" or "percent" reports zero
  // figures in a draft written in British English, however many it has.
  const file = tempFile('uk.md', '# T\n\nVisits rose 12 per cent last year. Sign-ups fell 8 per\u00A0cent. Revenue grew 30%.\n')
  const r = await runJson(PROSE, [file])
  const figures = r.json.files[0].findings.filter((f) => f.rule === 'unsourced-figure').map((f) => f.message)
  assert.equal(figures.length, 3, figures.join('\n'))
  assert.ok(figures.some((m) => m.startsWith('"12 per cent"')))
  assert.ok(figures.some((m) => /^"8 per\scent"/.test(m)), 'a no-break space inside per cent')
  const sourced = tempFile('uk-sourced.md', '# T\n\nVisits rose 12 per cent last year.\n\n## Sources\n\n- Annual report, 12 per cent: https://example.com/r\n')
  assert.ok(!(await runJson(PROSE, [sourced])).json.files[0].findings.some((f) => f.rule === 'unsourced-figure'))
})

test('an em dash is an error, an en dash is not', () => {
  assert.ok(rules(md('# T\n\nOne thing \u2014 then another.\n'), 'error').includes('em-dash'))
  assert.ok(!rules(md('# T\n\nPages 10\u201320 cover it.\n')).includes('em-dash'))
})

test('em dashes in HTML attributes count as copy', () => {
  const html = '<main><h1>T</h1><p>Plain text.</p><img src="a.png" alt="A chart \u2014 with a dash"></main>'
  assert.ok(checkProse(html, { format: 'html' }).findings.some((f) => f.rule === 'em-dash' && /attributes/.test(f.message)))
})

test('invisible characters are an error; a no-break space is not', () => {
  assert.ok(rules(md('# T\n\nzero\u200Bwidth\n'), 'error').includes('invisible-chars'))
  assert.ok(rules(md('# T\n\nbidi\u202Econtrol\n'), 'error').includes('invisible-chars'))
  assert.ok(!rules(md('# T\n\n10\u00A0km\n')).includes('invisible-chars'))
})

test('the parallel-negation exception holds in a draft', () => {
  assert.ok(!rules(md('# T\n\nThe result is not a pass, it is not a failure, and it moves nothing.\n')).includes('tell-shapes'))
  assert.ok(rules(md("# T\n\nIt's not a tool, it's a platform.\n")).includes('tell-shapes'))
})

test('proper-noun masking: Core Web Vitals is not the word vital', () => {
  assert.ok(!rules(md('# T\n\nCore Web Vitals measure loading, interactivity and layout shift.\n')).includes('tell-words'))
  assert.ok(rules(md('# T\n\nFast pages are vital.\n')).includes('tell-words'))
})

test('long paragraphs warn and short ones do not', () => {
  const long = `# T\n\n${'word '.repeat(95)}\n`
  assert.ok(rules(md(long), 'warn').includes('paragraph-length'))
  assert.ok(!rules(md(`# T\n\n${'word '.repeat(50)}\n`)).includes('paragraph-length'))
})

test('readability is reported as information with a grade', () => {
  const f = md(readFixture('draft-clean.md'))
  assert.ok(f.some((x) => x.rule === 'readability' && x.level === 'info' && /Flesch-Kincaid grade/.test(x.message)))
  assert.ok(fkGrade('The cat sat on the mat. The dog ran.') < fkGrade('Comprehensive institutional considerations necessitate multidimensional organisational evaluation.'))
})

test('fenced code and inline code are never scored', () => {
  const text = "# T\n\nPlain words.\n\n```\nIt's worth noting \u2014 delve\n```\n\nUse `leverage` as a flag name.\n"
  const f = md(text)
  assert.ok(!rules(f).includes('tell-phrases'))
  assert.ok(!rules(f).includes('tell-words'))
  assert.ok(!rules(f).includes('em-dash'))
})

test('an off/on region is skipped in every mode', () => {
  const quoted = readFixture('docs-quoting.md')
  for (const opts of [{}, { docs: true }]) {
    const f = md(quoted, opts)
    assert.deepEqual(f.filter((x) => x.level === 'error' || x.level === 'warn'), [], JSON.stringify(opts))
  }
  // The same lines outside the markers do fire.
  const bare = quoted.replace('<!-- prose-check: off -->', '').replace('<!-- prose-check: on -->', '')
  assert.ok(rules(md(bare, { docs: true }), 'error').includes('tell-phrases'))
  assert.ok(rules(md(bare, { docs: true }), 'error').includes('myth:no-ai-crawler-renders-javascript'))
})

test('docs mode: myths are errors, reframes warn, figures and readability are skipped', () => {
  const text = '# T\n\nNo AI crawler renders JavaScript. This is not a list, it is a guide. Traffic rose 40%.\n'
  const docs = md(text, { docs: true })
  assert.ok(rules(docs, 'error').includes('myth:no-ai-crawler-renders-javascript'))
  assert.ok(rules(docs, 'warn').includes('tell-shapes'))
  assert.ok(!rules(docs).includes('unsourced-figure'))
  assert.ok(!rules(docs).includes('readability'))
  const draft = md(text)
  assert.ok(rules(draft, 'warn').includes('myth:no-ai-crawler-renders-javascript'))
  assert.ok(rules(draft, 'error').includes('tell-shapes'))
  assert.ok(rules(draft).includes('unsourced-figure'))
})

test('docs mode checks the front matter too', () => {
  const text = "---\nname: x\ndescription: It's worth noting this skill \u2014 does things.\n---\n\n# T\n\nPlain.\n"
  const f = md(text, { docs: true })
  assert.ok(rules(f, 'error').includes('em-dash'))
  assert.ok(rules(f, 'error').includes('tell-phrases'))
})

test('several files in one run, and exit codes follow the contract', async () => {
  const both = await runJson(PROSE, [fixture('draft-clean.md'), fixture('draft-tells.md')])
  assert.equal(both.json.files.length, 2)
  assert.equal(both.code, 1)
  assert.equal((await run(PROSE, ['-'], { stdin: '# T\n\nPlain words here.\n' })).code, 0)
  assert.equal((await run(PROSE, [])).code, 2)
  assert.equal((await run(PROSE, ['https://example.com/'])).code, 2)
  const missing = await run(PROSE, [fixture('nope.md')])
  assert.equal(missing.code, 3)
  assert.match(missing.stdout, /NOT CHECKED/)
})
