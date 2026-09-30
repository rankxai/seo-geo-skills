/**
 * analyze-gsc.mjs and lib/gsc.mjs, against two fixture exports:
 *   fixtures/gsc-ui/   the Performance report's Export (Queries.csv with
 *                      percentage CTR and a quoted comma, Pages.csv with CRLF
 *                      rows, Dates.csv covering 70 days, Filters.csv,
 *                      breakdowns, and one unrelated CSV that must be skipped)
 *   A byte-order mark is added at test time, because the repository's own
 *   hygiene test rejects a literal U+FEFF in any file under tests/.
 *   fixtures/gsc-api/  an API-style file with query and page in one row, CTR
 *                      as a fraction and two days of rows to aggregate
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/gsc.mjs lowCtrRows(): `ctr < c.ctr / 2` changed to `ctr < c.ctr * 2`.
 *     Caught by "the CTR yardstick is the file's own curve".
 *   - lib/gsc.mjs trend(): the 56-day minimum lowered to 28. Caught by
 *     "position buckets, the curve and the low-CTR rule on plain rows".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { cannibalisation, ctrCurve, lowCtrRows, parseCsv, positionBucket, readExport, readNumber, trend } from '../skills/seo-geo/scripts/lib/gsc.mjs'
import { SEO, fixture, run, runJson, rules, tempFile } from './helpers.mjs'

const GSC = join(SEO, 'analyze-gsc.mjs')
const UI = fixture('gsc-ui')
const API = fixture(join('gsc-api', 'search-analytics.csv'))

test('the UI export folder is recognised file by file, by header rather than name', async () => {
  const r = await runJson(GSC, [UI])
  assert.equal(r.code, 0, r.stdout)
  const kinds = Object.fromEntries(r.json.files.map((f) => [f.file, f.kind]))
  assert.equal(kinds['Queries.csv'], 'queries')
  assert.equal(kinds['Pages.csv'], 'pages')
  assert.equal(kinds['Dates.csv'], 'dates')
  assert.equal(kinds['Filters.csv'], 'filters')
  assert.equal(kinds['Search appearance.csv'], 'appearance')
  assert.equal(kinds['notes.csv'], 'unknown')
  assert.equal(r.json.searchType, 'Web')
  assert.deepEqual([r.json.dateRange.from, r.json.dateRange.to, r.json.dateRange.days], ['2026-06-20', '2026-08-28', 70])
  assert.equal(r.json.totals.clicks, 5600, 'totals come from Dates.csv, the property totals')
  assert.match(r.json.totals.source, /property totals/)
})

test('the report: top rows, striking distance, zero-click pages, the anonymised gap and the trend', async () => {
  const r = await runJson(GSC, [UI])
  assert.equal(r.json.top.queriesByClicks[0].query, 'example widgets')
  assert.equal(r.json.top.queriesByImpressions[0].query, 'widget comparison')
  assert.deepEqual(r.json.strikingDistance.map((x) => x.query), ['widget sizes', 'how to fit a widget', 'widget, blue'], 'position 8 to 20 with 50+ impressions; the quoted comma survives')
  assert.deepEqual(r.json.zeroClickPages.map((x) => x.page), ['https://example.com/old-page'], 'the 10-impression page is under the threshold')
  assert.ok(rules(r.json.findings, 'info').includes('anonymised'))
  const t = r.json.findings.find((f) => f.rule === 'trend')
  assert.equal(t.level, 'warn')
  assert.match(t.message, /clicks 2,800 to 1,680 \(-40%\)/)
  assert.equal(r.json.findings.find((f) => f.rule === 'cannibalisation').level, 'not-checked', 'the UI export has no query and page pairs')
})

test('the CTR yardstick is the file\'s own curve', async () => {
  const r = await runJson(GSC, [UI])
  assert.deepEqual(r.json.lowCtrQueries.map((x) => x.query), ['widget comparison'])
  assert.equal(r.json.lowCtrQueries[0].bucket, '3')
  assert.ok(Math.abs(r.json.lowCtrQueries[0].bucketCtr - 501 / 6950) < 1e-9, 'the bucket CTR is clicks over impressions of the rows at that position')
  // A thin bucket is never used as a yardstick: one row at position 24 is not a curve.
  assert.equal(r.json.ctrCurve.queries['21+'].usable, false)
})

test('an API file with query and page is checked for cannibalisation, and rows are aggregated', async () => {
  const r = await runJson(GSC, [API])
  assert.equal(r.code, 0)
  assert.equal(r.json.files[0].kind, 'pairs')
  const c = r.json.cannibalisation
  assert.equal(c.length, 1)
  assert.equal(c[0].query, 'widget pricing')
  assert.deepEqual(c[0].pages.map((p) => p.page), ['https://example.com/pricing', 'https://example.com/blog/widget-cost'], 'the 10-impression home page does not count')
  assert.equal(c[0].impressions, 710, 'two days summed')
  assert.equal(r.json.findings.find((f) => f.rule === 'trend').level, 'not-checked', 'two days cannot make two 28-day windows')
  assert.match(r.json.totals.source, /lower bound/)
})

test('text report, individual files, and usage and unreadable cases', async () => {
  const r = await run(GSC, [join(UI, 'Queries.csv'), join(UI, 'Pages.csv')])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /STRIKING DISTANCE/)
  assert.match(r.stdout, /not how often a query was searched/)
  assert.match(r.stdout, /date range {3}not stated/)
  assert.doesNotMatch(r.stdout, /\u2014/)
  assert.equal((await run(GSC, ['--help'])).code, 0)
  assert.equal((await run(GSC, [])).code, 2)
  assert.equal((await run(GSC, [UI, '--min-impressions', 'x'])).code, 2)
  assert.equal((await run(GSC, ['export.zip'])).code, 2)
  assert.equal((await run(GSC, [join(UI, 'no-such-file.csv')])).code, 3)
  assert.equal((await run(GSC, [join(UI, 'notes.csv')])).code, 3, 'no Performance export among the files')
})

test('CSV and number reading', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\n\n1,2'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']])
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(readNumber('3.2%'), { value: 3.2, percent: true })
  assert.equal(readNumber('1,234').value, 1234)
  assert.equal(readNumber(''), null)
  const bq = readExport('query,url,clicks,impressions,sum_top_position\nq,https://example.com/,1,10,40\n')
  assert.equal(bq.kind, 'pairs')
  assert.equal(bq.rows[0].position, 5, 'BigQuery position = sum_top_position / impressions + 1')
})

test('position buckets, the curve and the low-CTR rule on plain rows', () => {
  assert.equal(positionBucket(1.4), '1')
  assert.equal(positionBucket(10.4), '10')
  assert.equal(positionBucket(13), '11-15')
  assert.equal(positionBucket(55), '21+')
  const rows = Array.from({ length: 5 }, (_, i) => ({ clicks: 10, impressions: 100, position: 2 + i / 10 })).concat([{ clicks: 1, impressions: 100, position: 2 }])
  const curve = ctrCurve(rows)
  assert.ok(curve['2'].usable)
  assert.equal(lowCtrRows(rows, curve, 50).length, 1)
  assert.equal(lowCtrRows(rows, curve, 500).length, 0, 'the impressions threshold applies')
  assert.equal(cannibalisation([{ query: 'q', page: '/a', clicks: 0, impressions: 100, position: 5 }], 10).length, 0)
  const days = Array.from({ length: 56 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), clicks: i < 28 ? 10 : 5, impressions: 100, position: 5 }))
  const t = trend(days)
  assert.equal(t.comparable, true)
  assert.equal(t.change.clicks, -0.5)
  assert.equal(trend(days.slice(0, 55)).comparable, false)
})

test('a semicolon-delimited export with a BOM still reads', async () => {
  const f = tempFile('Queries.csv', '\uFEFFTop queries;Clicks;Impressions;CTR;Position\nwidget;1;100;1%;9\n')
  const r = await runJson(GSC, [f])
  assert.equal(r.json.files[0].kind, 'queries')
  assert.equal(r.json.strikingDistance[0].query, 'widget')
  // The real export's Queries.csv, with the BOM the UI writes, reads the same as without it.
  const withBom = tempFile('Queries.csv', `\uFEFF${readFileSync(join(UI, 'Queries.csv'), 'utf8')}`)
  const b = await runJson(GSC, [withBom])
  assert.equal(b.json.files[0].kind, 'queries')
  assert.equal(b.json.top.queriesByClicks[0].query, 'example widgets')
})
