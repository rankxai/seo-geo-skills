#!/usr/bin/env node
/**
 * analyze-gsc.mjs: read Google Search Console Performance exports offline and
 * report what they say, without inventing anything they do not.
 *
 *   node skills/seo-geo/scripts/analyze-gsc.mjs ./gsc-export/
 *   node skills/seo-geo/scripts/analyze-gsc.mjs Queries.csv Pages.csv Dates.csv
 *   node skills/seo-geo/scripts/analyze-gsc.mjs api-rows.csv --min-impressions 20
 *
 * Reads the CSV files from the Performance report's Export button (the folder
 * the zip extracts to, or the files one by one), and API or BigQuery CSVs with
 * query and page columns. Files are recognised by their header row. It reports:
 *
 *   totals             from Dates.csv or Chart.csv (the property's own totals);
 *                      summed from a table otherwise, and labelled a lower bound
 *   top queries and pages, by clicks and by impressions
 *   striking-distance  queries at average position 8 to 20 with at least
 *                      --min-impressions impressions
 *   low-ctr-*          rows whose CTR is under half of what this same file's
 *                      rows at the same position get. The yardstick is the
 *                      file's own CTR-by-position curve, never a published one
 *   zero-click-pages   pages with impressions and no clicks
 *   cannibalisation    queries where two or more pages each take at least 10%
 *                      of the impressions. Only when a file has query and page
 *                      in the same row; the UI export does not, and says so
 *   trend              first 28 days against last 28 days, from the daily rows
 *
 * It never states search volume: impressions count how often a result was
 * shown, which is not how often a query was searched. Search Console
 * withholds rare (anonymised) queries, so query rows do not sum to page rows,
 * and the UI export stops at 1,000 rows per table.
 *
 * Nothing in an export is a defect by itself, so this reader reports at warn
 * and info level only and exits 0 when it could read the files. Exit codes: 0
 * read, 2 usage error, 3 nothing readable.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { EXIT, UsageError, formatFinding, intOption, parseCli, runMain, summaryLine, VERSION } from './lib/cli.mjs'
import { aggregate, cannibalisation, ctrCurve, exportText, lowCtrRows, readExport, strikingDistance, totalsOf, trend } from './lib/gsc.mjs'

const HELP = `usage: node analyze-gsc.mjs <export folder | file.csv ...> [options]

Reads Search Console Performance exports (Queries.csv, Pages.csv,
Countries.csv, Devices.csv, Search appearance.csv, Dates.csv or Chart.csv,
Filters.csv), or an API or BigQuery CSV with query and page columns, and
reports totals, top queries and pages, striking-distance queries, low CTR for
the position (against the file's own curve), pages with impressions and no
clicks, cannibalisation (query and page exports only) and the 28-day trend.

options:
  --min-impressions <n>  impressions a row needs to be reported (default 50)
  --top <n>              rows per list in the text report (default 10)
  --json                 machine-readable output, every row
  -h, --help             this text

exit codes: 0 read, 2 usage error, 3 nothing readable`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }
/** The Performance report's export holds at most this many rows per table. */
const UI_ROW_LIMIT = 1000

const n0 = (n) => Math.round(n).toLocaleString('en-GB')
const pct = (x) => `${(x * 100).toFixed(1)}%`
const pos = (p) => (p === null || p === undefined ? '-' : p.toFixed(1))
const clip = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

/** Every CSV named by the arguments: files as given, folders read one level deep. */
function collectFiles(args) {
  const files = []
  const missing = []
  for (const arg of args) {
    if (/\.zip$/i.test(arg)) throw new UsageError(`${arg} is a zip file: extract it and pass the folder (this reader has no zip support)`)
    let st
    try {
      st = statSync(arg)
    } catch {
      missing.push(arg)
      continue
    }
    if (st.isDirectory()) {
      const list = (dir) => readdirSync(dir, { withFileTypes: true })
      let found = list(arg).filter((e) => e.isFile() && /\.(?:csv|tsv)$/i.test(e.name)).map((e) => join(arg, e.name))
      if (!found.length) {
        for (const sub of list(arg).filter((e) => e.isDirectory())) {
          found.push(...list(join(arg, sub.name)).filter((e) => e.isFile() && /\.(?:csv|tsv)$/i.test(e.name)).map((e) => join(arg, sub.name, e.name)))
        }
      }
      files.push(...found.sort())
    } else {
      files.push(arg)
    }
  }
  return { files, missing }
}

function notChecked(json, input, reason) {
  if (json) console.log(JSON.stringify({ tool: 'analyze-gsc', version: VERSION, input, checked: false, reason }, null, 2))
  else console.log(`analyze-gsc  ${input}\n\n  NOT CHECKED  ${reason}\n`)
  return EXIT.UNCHECKED
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    'min-impressions': { type: 'string' },
    top: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (!positionals.length) throw new UsageError('give an export folder or one or more CSV files')
  const minImpr = intOption(values['min-impressions'], 'min-impressions', 50, 1)
  const top = intOption(values.top, 'top', 10, 1)
  const input = positionals.join(' ')

  const { files, missing } = collectFiles(positionals)
  const findings = []
  const add = (level, rule, message, affects = 0) => findings.push({ level, rule, message, affects })
  for (const m of missing) add('not-checked', 'file', `no such file or folder: ${m}`)
  if (!files.length) return notChecked(values.json, input, missing.length ? `no such file or folder: ${missing.join(', ')}` : 'no .csv files found')

  // ---- read and recognise --------------------------------------------------------
  const tables = {}
  const read = []
  for (const file of files) {
    let parsed
    try {
      parsed = readExport(exportText(readFileSync(file)))
    } catch (error) {
      add('not-checked', 'file', `${file} could not be read: ${error.message}`)
      continue
    }
    read.push({ file: basename(file), kind: parsed.kind, rows: parsed.rows.length })
    if (parsed.kind === 'unknown' || parsed.kind === 'empty') {
      add('info', 'file', `${basename(file)} is not a Performance export this reader knows (header: ${(parsed.header ?? []).slice(0, 5).join(', ') || 'none'}); skipped`)
      continue
    }
    if (tables[parsed.kind]) {
      add('info', 'file', `${basename(file)} is a second ${parsed.kind} table; only ${tables[parsed.kind].file} was used`)
      continue
    }
    tables[parsed.kind] = { file: basename(file), rows: parsed.rows }
  }
  const metricKinds = Object.keys(tables).filter((k) => k !== 'filters')
  if (!metricKinds.length) return notChecked(values.json, input, `none of the ${files.length} file(s) is a Search Console Performance export (no Impressions column)`)

  // Tables the analysis works from. Query and page rows come from their own
  // files when present, and from query-and-page rows otherwise.
  const pairs = tables.pairs?.rows ?? null
  const queries = tables.queries?.rows ?? (pairs ? aggregate(pairs, (r) => r.query).map((a) => ({ query: a.key, ...a })) : null)
  const pagesRows = tables.pages?.rows ?? (pairs ? aggregate(pairs, (r) => r.page).map((a) => ({ page: a.key, ...a })) : null)
  const dateRows = tables.dates?.rows ?? (pairs?.some((r) => r.date) ? pairs : null)
  const datesFromPairs = !tables.dates && Boolean(dateRows)

  for (const [kind, t] of Object.entries(tables)) {
    if (['queries', 'pages', 'countries', 'appearance'].includes(kind) && t.rows.length === UI_ROW_LIMIT) {
      add('info', 'row-limit', `${t.file} has exactly ${n0(UI_ROW_LIMIT)} rows, the limit of the Performance report's export, so there are more ${kind} than it lists. The Search Console API or the BigQuery bulk export has them all.`)
    }
  }

  // ---- filters, date range, totals -------------------------------------------------
  const filters = tables.filters?.rows ?? []
  const filterValue = (name) => filters.find((f) => f.filter.toLowerCase() === name)?.value ?? null
  const searchType = filterValue('search type')
  const extraFilters = filters.filter((f) => !['search type', 'date'].includes(f.filter.toLowerCase()) && f.value)
  if (extraFilters.length) add('info', 'filters', `the export is filtered (${extraFilters.map((f) => `${f.filter}: ${f.value}`).join('; ')}), so every figure covers that filtered set only`)

  let dateRange = null
  const series = dateRows ? trend(dateRows) : null
  if (series?.first) dateRange = { from: series.first, to: series.last, days: series.days, source: datesFromPairs ? tables.pairs.file : tables.dates.file }
  else if (filterValue('date')) dateRange = { label: filterValue('date'), source: tables.filters.file }

  let totals
  let totalsSource
  if (tables.dates) {
    totals = totalsOf(tables.dates.rows)
    totalsSource = `property totals from ${tables.dates.file}`
  } else {
    const basis = tables.pages ?? tables.queries ?? tables.pairs ?? tables.countries ?? tables.devices
    if (basis) {
      totals = totalsOf(basis.rows)
      totalsSource = basis === tables.pairs
        ? `summed from ${basis.file}, which leaves out anonymised queries, so a lower bound`
        : `summed from ${basis.file}; a lower bound, because a table export holds only its top rows${basis === tables.queries ? ' and leaves out anonymised queries' : ''}`
      add('info', 'totals', `no Dates.csv or Chart.csv, so the totals are ${totalsSource}`)
    }
  }

  if (queries && pagesRows) {
    const q = totalsOf(queries)
    const p = totalsOf(pagesRows)
    if (p.clicks > 0 && q.clicks < p.clicks) {
      add('info', 'anonymised', `the query rows add up to ${n0(q.clicks)} clicks against ${n0(p.clicks)} in the page rows (${pct(1 - q.clicks / p.clicks)} fewer). Search Console withholds rare queries to protect searchers' privacy, so query totals never sum to page totals; the gap is expected, not an error.`)
    }
  }

  // ---- opportunities -------------------------------------------------------------------
  const report = { strikingDistance: [], lowCtrQueries: [], lowCtrPages: [], zeroClickPages: [], cannibalisation: null, curve: {} }
  if (queries) {
    report.strikingDistance = strikingDistance(queries, minImpr)
    if (report.strikingDistance.length) {
      add('info', 'striking-distance', `${report.strikingDistance.length} quer${report.strikingDistance.length === 1 ? 'y sits' : 'ies sit'} at an average position of 8 to 20 with ${minImpr} or more impressions. A page on the edge of page one moves more for the same work than one on page five; check each query's intent against the page that ranks before changing anything.`, report.strikingDistance.length)
    } else if (queries.length) {
      add('info', 'striking-distance', `no query at an average position of 8 to 20 has ${minImpr} or more impressions${queries.some((r) => r.position >= 8 && r.position <= 20) ? '; lower --min-impressions to see smaller ones' : ''}`)
    }
    report.curve.queries = ctrCurve(queries)
    report.lowCtrQueries = lowCtrRows(queries, report.curve.queries, minImpr)
    if (report.lowCtrQueries.length) {
      add('warn', 'low-ctr-queries', `${report.lowCtrQueries.length} quer${report.lowCtrQueries.length === 1 ? 'y gets' : 'ies get'} under half the CTR this file's own queries get at the same position. Look at what the result shows (title, snippet, rich results, an AI Overview above it). Branded queries at position 1 lift the curve, so read non-branded rows with that in mind.`, report.lowCtrQueries.length)
    }
  }
  if (pagesRows) {
    report.curve.pages = ctrCurve(pagesRows)
    report.lowCtrPages = lowCtrRows(pagesRows, report.curve.pages, minImpr)
    if (report.lowCtrPages.length) {
      add('warn', 'low-ctr-pages', `${report.lowCtrPages.length} page(s) get under half the CTR this file's own pages get at the same position. A page's CTR mixes every query it shows for, so check its queries before rewriting its title.`, report.lowCtrPages.length)
    }
    report.zeroClickPages = pagesRows.filter((r) => r.impressions >= minImpr && r.clicks === 0).sort((a, b) => b.impressions - a.impressions)
    if (report.zeroClickPages.length) {
      add('warn', 'zero-click-pages', `${report.zeroClickPages.length} page(s) had ${minImpr} or more impressions and no clicks. Usually a deep average position, a result that does not match the query, or a page shown for queries it does not answer.`, report.zeroClickPages.length)
    }
  }
  if (pairs) {
    report.cannibalisation = cannibalisation(pairs, minImpr)
    if (report.cannibalisation.length) {
      add('info', 'cannibalisation', `${report.cannibalisation.length} quer${report.cannibalisation.length === 1 ? 'y has' : 'ies have'} two or more pages each taking at least 10% of the impressions. Two pages for one query is often fine (different intents, or a sitelink); it costs you when neither ranks well and the impressions split.`, report.cannibalisation.length)
    } else {
      add('info', 'cannibalisation', `no query with ${minImpr} or more impressions splits them between two or more pages`)
    }
  } else if (queries || pagesRows) {
    add('not-checked', 'cannibalisation', 'this export has no file with query and page in the same row (the Performance report exports them as separate tables), so query cannibalisation cannot be checked from it. Export query and page together from the Search Console API or the BigQuery bulk export.')
  }

  // ---- trend ------------------------------------------------------------------------------
  if (series?.comparable) {
    const c = series.change.clicks
    const i = series.change.impressions
    const text = `last 28 days (${series.late.from} to ${series.late.to}) against the first 28 (${series.early.from} to ${series.early.to}): clicks ${n0(series.early.clicks)} to ${n0(series.late.clicks)}${c === null ? '' : ` (${c >= 0 ? '+' : ''}${(c * 100).toFixed(0)}%)`}, impressions ${n0(series.early.impressions)} to ${n0(series.late.impressions)}${i === null ? '' : ` (${i >= 0 ? '+' : ''}${(i * 100).toFixed(0)}%)`}, average position ${pos(series.early.position)} to ${pos(series.late.position)}${datesFromPairs ? '. Summed from query rows, which leave out anonymised queries' : ''}. Seasonality moves these too: compare with the same weeks a year earlier before reading a change as a cause.`
    add(c !== null && c <= -0.2 ? 'warn' : 'info', 'trend', text)
  } else if (series) {
    add('not-checked', 'trend', `the daily rows cover ${series.days} day(s); comparing two 28-day windows needs at least 56`)
  } else {
    add('not-checked', 'trend', 'no Dates.csv or Chart.csv, so the trend over the period was not checked')
  }

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.affects ?? 0) - (a.affects ?? 0))

  const byClicks = (rows) => [...rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
  const byImpr = (rows) => [...rows].sort((a, b) => b.impressions - a.impressions)
  const breakdown = (kind, field) => (tables[kind] ? byClicks(tables[kind].rows).map((r) => ({ [field]: r[field], clicks: r.clicks, impressions: r.impressions, position: r.position })) : null)

  if (values.json) {
    const rowOut = (r) => ({ query: r.query, page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: r.position })
    console.log(JSON.stringify({
      tool: 'analyze-gsc', version: VERSION, input, checked: true, files: read, searchType, dateRange, minImpressions: minImpr,
      totals: totals ? { ...totals, key: undefined, source: totalsSource } : null,
      top: {
        queriesByClicks: queries ? byClicks(queries).slice(0, top).map(rowOut) : null,
        queriesByImpressions: queries ? byImpr(queries).slice(0, top).map(rowOut) : null,
        pagesByClicks: pagesRows ? byClicks(pagesRows).slice(0, top).map(rowOut) : null,
        pagesByImpressions: pagesRows ? byImpr(pagesRows).slice(0, top).map(rowOut) : null,
      },
      strikingDistance: report.strikingDistance.map(rowOut),
      ctrCurve: report.curve,
      lowCtrQueries: report.lowCtrQueries.map((r) => ({ ...rowOut(r), bucket: r.bucket, bucketCtr: r.bucketCtr })),
      lowCtrPages: report.lowCtrPages.map((r) => ({ ...rowOut(r), bucket: r.bucket, bucketCtr: r.bucketCtr })),
      zeroClickPages: report.zeroClickPages.map(rowOut),
      cannibalisation: report.cannibalisation,
      trend: series,
      breakdowns: { countries: breakdown('countries', 'country'), devices: breakdown('devices', 'device'), searchAppearance: breakdown('appearance', 'appearance') },
      findings, summary: summaryLine(findings),
    }, null, 2))
    return EXIT.CLEAN
  }

  const lines = [`analyze-gsc  ${input}  (${read.filter((r) => tables[r.kind]?.file === r.file).map((r) => `${r.file}: ${r.kind}`).join(', ')})`, '']
  if (dateRange) lines.push(`  date range   ${dateRange.from ? `${dateRange.from} to ${dateRange.to} (${dateRange.days} days with data)` : dateRange.label}, from ${dateRange.source}`)
  else lines.push('  date range   not stated in these files (Filters.csv or Dates.csv would give it)')
  if (searchType) lines.push(`  search type  ${searchType}`)
  if (totals) lines.push(`  totals       ${n0(totals.clicks)} clicks, ${n0(totals.impressions)} impressions, CTR ${pct(totals.ctr)}, average position ${pos(totals.position)} (${totalsSource})`)
  const table = (title, rows, label) => {
    if (!rows?.length) return
    lines.push('', `  ${title}`)
    for (const r of rows.slice(0, top)) lines.push(`    ${n0(r.clicks).padStart(8)} clicks ${n0(r.impressions).padStart(10)} impr  CTR ${pct(r.impressions ? r.clicks / r.impressions : 0).padStart(6)}  pos ${pos(r.position).padStart(5)}  ${clip(label(r))}`)
    if (rows.length > top) lines.push(`    ... ${rows.length - top} more (--json for all)`)
  }
  table('TOP QUERIES BY CLICKS', queries && byClicks(queries), (r) => r.query)
  table('TOP QUERIES BY IMPRESSIONS', queries && byImpr(queries), (r) => r.query)
  table('TOP PAGES BY CLICKS', pagesRows && byClicks(pagesRows), (r) => r.page)
  table('TOP PAGES BY IMPRESSIONS', pagesRows && byImpr(pagesRows), (r) => r.page)
  table(`STRIKING DISTANCE (average position 8 to 20, ${minImpr}+ impressions)`, report.strikingDistance, (r) => r.query)
  table("LOW CTR FOR THE POSITION, QUERIES (under half this file's CTR at that position)", report.lowCtrQueries, (r) => `${r.query}  (file CTR at ${r.bucket}: ${pct(r.bucketCtr)})`)
  table("LOW CTR FOR THE POSITION, PAGES (under half this file's CTR at that position)", report.lowCtrPages, (r) => `${r.page}  (file CTR at ${r.bucket}: ${pct(r.bucketCtr)})`)
  table(`PAGES WITH ${minImpr}+ IMPRESSIONS AND NO CLICKS`, report.zeroClickPages, (r) => r.page)
  if (report.cannibalisation?.length) {
    lines.push('', '  QUERIES SPLIT ACROSS PAGES')
    for (const c of report.cannibalisation.slice(0, top)) lines.push(`    ${n0(c.impressions).padStart(10)} impr  ${clip(c.query, 50)}: ${c.pages.map((p) => `${p.page} (pos ${pos(p.position)}, ${pct(p.share)})`).join('; ')}`)
    if (report.cannibalisation.length > top) lines.push(`    ... ${report.cannibalisation.length - top} more (--json for all)`)
  }
  for (const [kind, field, title] of [['countries', 'country', 'COUNTRIES'], ['devices', 'device', 'DEVICES'], ['appearance', 'appearance', 'SEARCH APPEARANCE']]) {
    const rows = breakdown(kind, field)
    if (rows?.length) lines.push('', `  ${title}  ${rows.slice(0, 5).map((r) => `${r[field]} ${n0(r.clicks)} clicks / ${n0(r.impressions)} impr`).join(', ')}`)
  }
  lines.push('')
  for (const f of findings) lines.push(formatFinding(f))
  lines.push('', `  ${summaryLine(findings)}`)
  lines.push('  Impressions count how often a result was shown, not how often a query was searched: none of this is search volume.', '')
  console.log(lines.join('\n'))
  return EXIT.CLEAN
}

await runMain(main, HELP)
