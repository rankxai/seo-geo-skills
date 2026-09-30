/**
 * The logic behind analyze-gsc.mjs: read Google Search Console Performance
 * exports and turn them into the handful of questions worth asking of them.
 *
 * Inputs, recognised by their header row rather than their file name, so a
 * renamed or translated-then-renamed file still reads:
 *   Queries.csv            Top queries, Clicks, Impressions, CTR, Position
 *   Pages.csv              Top pages, ...
 *   Countries.csv, Devices.csv, Search appearance.csv
 *   Dates.csv, Chart.csv   Date, ... (the property's daily totals)
 *   Filters.csv            Filter, Value (search type, date range, any filter)
 *   an API or BigQuery CSV with query and page columns (and optionally date,
 *                          country, device), ctr as a fraction or a percentage,
 *                          and position either as "position" or as BigQuery's
 *                          sum_top_position / sum_position (position = sum /
 *                          impressions + 1).
 *
 * Rules this module keeps:
 *   - No search volume, ever. Impressions are how often a page was shown,
 *     which is not how often a query was searched.
 *   - The CTR a row "should" have is read from the same file's own CTR by
 *     position, never from a published benchmark curve: CTR by position varies
 *     by site, query mix and SERP layout, and a borrowed curve invents numbers.
 *   - Search Console withholds rare ("anonymised") queries from query reports,
 *     so query rows never sum to page rows. That gap is reported, not fixed.
 *   - The UI export holds at most 1,000 rows per table, so totals summed from a
 *     table are a lower bound; only Dates.csv or Chart.csv carries the
 *     property's real totals.
 */

import { decodeText } from './cli.mjs'

/* ---- CSV ------------------------------------------------------------------ */

/** Parse CSV (RFC 4180 quoting). The delimiter is whichever of , ; or tab the header row uses most. */
export function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch) => firstLine.split(ch).length - 1
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

/**
 * A number from an export cell: "1234", "1,234", "3.2%", "8.5", " 12 ".
 * Returns { value, percent } or null for an empty or unreadable cell.
 */
export function readNumber(cell) {
  let s = String(cell ?? '').trim().replace(/[   ]/g, '')
  if (!s || s === '-' || s === '--') return null
  const percent = s.endsWith('%')
  if (percent) s = s.slice(0, -1)
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  const value = Number(s)
  return Number.isFinite(value) ? { value, percent } : null
}

/* ---- tables ---------------------------------------------------------------- */

const HEADER_ALIASES = {
  query: ['top queries', 'query', 'queries', 'search query', 'top query'],
  page: ['top pages', 'page', 'pages', 'url', 'landing page', 'top page'],
  country: ['country', 'countries'],
  device: ['device', 'devices'],
  appearance: ['search appearance', 'search appearances', 'searchappearance'],
  date: ['date', 'day', 'data_date'],
  clicks: ['clicks', 'url clicks'],
  impressions: ['impressions'],
  ctr: ['ctr', 'url ctr', 'click through rate', 'click-through rate'],
  position: ['position', 'average position', 'avg. position', 'avg position'],
  sumPosition: ['sum_top_position', 'sum_position'],
  filter: ['filter'],
  value: ['value'],
}

function columnMap(header) {
  const map = {}
  header.forEach((h, i) => {
    const name = h.replace(/^\uFEFF/, '').trim().toLowerCase()
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[key] === undefined && aliases.includes(name)) map[key] = i
    }
  })
  return map
}

/** What kind of export a parsed CSV is, from its header. */
export function kindOf(map) {
  if (map.filter !== undefined && map.value !== undefined) return 'filters'
  if (map.impressions === undefined) return 'unknown'
  if (map.query !== undefined && map.page !== undefined) return 'pairs'
  if (map.query !== undefined) return 'queries'
  if (map.page !== undefined) return 'pages'
  if (map.appearance !== undefined) return 'appearance'
  if (map.country !== undefined) return 'countries'
  if (map.device !== undefined) return 'devices'
  if (map.date !== undefined) return 'dates'
  return 'unknown'
}

/**
 * Read one export file's text into { kind, rows }. Each metric row is
 * { query?, page?, country?, device?, appearance?, date?, clicks, impressions, position }.
 * CTR is recomputed from clicks and impressions when both exist, because the
 * exported CTR is rounded.
 */
export function readExport(text) {
  const table = parseCsv(text)
  if (!table.length) return { kind: 'empty', rows: [] }
  const map = columnMap(table[0])
  const kind = kindOf(map)
  if (kind === 'filters') {
    return { kind, rows: table.slice(1).map((r) => ({ filter: (r[map.filter] ?? '').trim(), value: (r[map.value] ?? '').trim() })) }
  }
  if (kind === 'unknown') return { kind, rows: [], header: table[0] }
  const rows = []
  for (const r of table.slice(1)) {
    const clicks = readNumber(r[map.clicks])?.value ?? 0
    const impressions = readNumber(r[map.impressions])?.value ?? 0
    let position = map.position !== undefined ? (readNumber(r[map.position])?.value ?? null) : null
    if (position === null && map.sumPosition !== undefined && impressions > 0) {
      const sum = readNumber(r[map.sumPosition])?.value
      if (sum !== undefined) position = sum / impressions + 1
    }
    const row = { clicks, impressions, position }
    for (const dim of ['query', 'page', 'country', 'device', 'appearance', 'date']) if (map[dim] !== undefined) row[dim] = (r[map[dim]] ?? '').trim()
    rows.push(row)
  }
  return { kind, rows }
}

/** Decode a file's bytes (UTF-8 with or without a BOM, or UTF-16 with one). */
export const exportText = (buffer) => decodeText(buffer, null).text

/* ---- aggregation --------------------------------------------------------------- */

/** Sum rows by a key function, with impression-weighted position. */
export function aggregate(rows, keyFn) {
  const out = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (!out.has(k)) out.set(k, { key: k, clicks: 0, impressions: 0, posWeight: 0, posImpr: 0 })
    const a = out.get(k)
    a.clicks += r.clicks
    a.impressions += r.impressions
    if (r.position !== null && r.position !== undefined && r.impressions > 0) {
      a.posWeight += r.position * r.impressions
      a.posImpr += r.impressions
    }
  }
  return [...out.values()].map((a) => finish(a))
}

function finish(a) {
  return { key: a.key, clicks: a.clicks, impressions: a.impressions, ctr: a.impressions ? a.clicks / a.impressions : 0, position: a.posImpr ? a.posWeight / a.posImpr : null }
}

export function totalsOf(rows) {
  return aggregate(rows, () => 'all')[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: null }
}

/** Position bucket for the CTR curve: 1 to 10 one by one, then 11-15, 16-20, 21+. */
export function positionBucket(pos) {
  if (pos === null || pos === undefined || !Number.isFinite(pos)) return null
  const r = Math.max(1, Math.round(pos))
  if (r <= 10) return String(r)
  if (r <= 15) return '11-15'
  if (r <= 20) return '16-20'
  return '21+'
}

/**
 * The file's own CTR by position: for each bucket, total clicks over total
 * impressions of the rows in it. A bucket needs at least `minRows` rows before
 * it is used as a yardstick.
 */
export function ctrCurve(rows, minRows = 5) {
  const buckets = new Map()
  for (const r of rows) {
    const b = positionBucket(r.position)
    if (!b || !r.impressions) continue
    if (!buckets.has(b)) buckets.set(b, { clicks: 0, impressions: 0, rows: 0 })
    const x = buckets.get(b)
    x.clicks += r.clicks
    x.impressions += r.impressions
    x.rows += 1
  }
  const curve = {}
  for (const [b, x] of buckets) curve[b] = { ctr: x.impressions ? x.clicks / x.impressions : 0, rows: x.rows, impressions: x.impressions, usable: x.rows >= minRows && x.clicks > 0 }
  return curve
}

/** Rows whose CTR is under half of what the file's own rows at the same position get. */
export function lowCtrRows(rows, curve, minImpressions) {
  const out = []
  for (const r of rows) {
    if (r.impressions < minImpressions) continue
    const b = positionBucket(r.position)
    const c = b && curve[b]
    if (!c?.usable) continue
    const ctr = r.clicks / r.impressions
    if (ctr < c.ctr / 2) out.push({ ...r, ctr, bucket: b, bucketCtr: c.ctr, gap: r.impressions * (c.ctr - ctr) })
  }
  return out.sort((a, b) => b.gap - a.gap)
}

export function strikingDistance(rows, minImpressions, from = 8, to = 20) {
  return rows.filter((r) => r.position !== null && r.position >= from && r.position <= to && r.impressions >= minImpressions).sort((a, b) => b.impressions - a.impressions)
}

/**
 * Queries where two or more pages each take a real share of the impressions.
 * Needs query and page in the same row. `share` is the minimum share of the
 * query's impressions a page needs to count.
 */
export function cannibalisation(pairRows, minImpressions, share = 0.1) {
  const byQuery = new Map()
  for (const r of aggregate(pairRows, (x) => `${x.query}\u0000${x.page}`)) {
    const [query, page] = r.key.split('\u0000')
    if (!byQuery.has(query)) byQuery.set(query, [])
    byQuery.get(query).push({ page, clicks: r.clicks, impressions: r.impressions, position: r.position })
  }
  const out = []
  for (const [query, pages] of byQuery) {
    const total = pages.reduce((s, p) => s + p.impressions, 0)
    if (total < minImpressions) continue
    const real = pages.filter((p) => p.impressions / total >= share && p.impressions >= 10).sort((a, b) => b.impressions - a.impressions)
    if (real.length >= 2) out.push({ query, impressions: total, pages: real.map((p) => ({ ...p, share: p.impressions / total })) })
  }
  return out.sort((a, b) => b.impressions - a.impressions)
}

/** Parse a date cell (YYYY-MM-DD, or anything Date.parse reads) to a YYYY-MM-DD string, or null. */
export function isoDate(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

/**
 * First 28 days against last 28 days of a daily series. Needs at least 56
 * distinct days so the windows do not overlap. Returns null when too short.
 */
export function trend(dateRows, window = 28) {
  const days = aggregate(dateRows.filter((r) => isoDate(r.date)), (r) => isoDate(r.date)).sort((a, b) => (a.key < b.key ? -1 : 1))
  if (days.length < window * 2) return { days: days.length, first: days[0]?.key ?? null, last: days.at(-1)?.key ?? null, comparable: false }
  const sum = (list) => {
    const t = totalsOf(list.map((d) => ({ clicks: d.clicks, impressions: d.impressions, position: d.position })))
    return { from: list[0].key, to: list.at(-1).key, clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position }
  }
  const early = sum(days.slice(0, window))
  const late = sum(days.slice(-window))
  const change = (a, b) => (a ? (b - a) / a : null)
  return {
    days: days.length, first: days[0].key, last: days.at(-1).key, comparable: true, early, late,
    change: { clicks: change(early.clicks, late.clicks), impressions: change(early.impressions, late.impressions) },
  }
}
