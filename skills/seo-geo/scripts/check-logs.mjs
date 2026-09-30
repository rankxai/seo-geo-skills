#!/usr/bin/env node
/**
 * check-logs.mjs: which crawlers really fetched the site, what they got, and
 * (with --verify) whether they are who their user agent says.
 *
 *   node skills/seo-geo/scripts/check-logs.mjs access.log
 *   node skills/seo-geo/scripts/check-logs.mjs access.log.1 access.log.2.gz --verify
 *   node skills/seo-geo/scripts/check-logs.mjs cloudflare.jsonl --verify --json
 *   zcat access.log.*.gz | node skills/seo-geo/scripts/check-logs.mjs -
 *
 * Reads nginx and Apache combined and common logs and JSON-lines logs
 * (Cloudflare Logpush, Vercel log drains, or any with obvious field names),
 * gzipped or not, one line at a time, so a large log does not have to fit in
 * memory. Every user agent is matched against the product tokens in
 * data/crawlers.json. Per crawler, grouped by purpose (search, training,
 * user-fetch), it reports requests, unique URLs, the status mix, the top URLs,
 * the share of requests that re-fetch a URL already fetched in this window,
 * robots.txt fetches and their statuses, and first and last seen.
 *
 * Findings:
 *   refused              a search crawler getting mostly 403, 429 or 5xx: a CDN
 *                        or firewall rule is turning it away. An error when the
 *                        hits are verified, a warning when they are not.
 *   robots-errors        robots.txt answered 5xx or 429, which crawlers read as
 *                        "crawl nothing" (RFC 9309 section 2.3.1.4; Google for 429)
 *   not-seen             a search crawler absent from this log window. Only a
 *                        finding for search crawlers; training and user-fetch
 *                        crawlers that never came are not a fault.
 *   spoofed              with --verify: requests claiming a crawler's user agent
 *                        from an IP outside that vendor's published ranges
 *   verification         without --verify every count is of user agents, which
 *                        anyone can send; reported as not checked
 *
 * --verify fetches each seen crawler's published IP list (the verify URL in
 * data/crawlers.json) and labels every hit verified, unverified (the IP is
 * outside the list: a spoofed user agent) or not verifiable (the vendor
 * publishes no machine-readable list, or it could not be fetched). --ranges
 * TOKEN=FILE-OR-URL supplies a list yourself, for an offline run or a vendor
 * whose list moved.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { EXIT, UsageError, exitFor, fetchPage, formatFinding, parseCli, runMain, summaryLine, VERSION } from './lib/cli.mjs'
import { PURPOSE_TITLES, loadRoster } from './lib/crawlers.mjs'
import { LogStats, botMatchers, ipInRanges, isRefusal, mergeStatus, parseIp, rangesFromJson, statusMix } from './lib/logs.mjs'

const HELP = `usage: node check-logs.mjs <access log ...> [options]

Reads combined, common and JSON-lines access logs (.gz is fine, - is stdin)
and reports, per AI and search crawler in data/crawlers.json: requests,
unique URLs, status mix, top URLs, re-fetch share, robots.txt fetches, first
and last seen. Flags search crawlers that are mostly refused (403, 429, 5xx),
robots.txt errors, and search crawlers not seen in this log window.

options:
  --verify                 check each hit's IP against the ranges the vendor
                           publishes, and label it verified, unverified
                           (spoofed user agent) or not verifiable
  --ranges <TOKEN=source>  use this IP list (a JSON file or URL) for a crawler
                           instead of the published one; repeatable
  --timeout <ms>           timeout for fetching an IP list (default 15000)
  --top <n>                top URLs listed per crawler (default 5)
  --json                   machine-readable output
  -h, --help               this text

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }
const PURPOSES = ['search', 'training', 'user-fetch']
/** A crawler needs this many requests before its status mix says anything. */
const MIN_REQUESTS = 5
/** The search crawlers whose absence from a multi-day log is a warning rather than a note. */
const MAJOR_SEARCH = new Set(['googlebot', 'bingbot'])

const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString())
const day = (t) => (t === null || t === undefined ? '-' : new Date(t).toISOString().slice(0, 10))
const pct = (x) => `${Math.round(x * 100)}%`
const n0 = (n) => n.toLocaleString('en-GB')

async function readLog(source, stats) {
  const raw = source === '-' ? process.stdin : createReadStream(source)
  const input = /\.gz$/i.test(source) ? raw.pipe(createGunzip()) : raw
  await new Promise((resolve, reject) => {
    raw.once('error', reject)
    input.once('error', reject)
    const rl = createInterface({ input, crlfDelay: Infinity })
    // Newer Node versions re-emit a stream error on the interface as well.
    rl.once('error', reject)
    rl.on('line', (line) => stats.addLine(line))
    rl.once('close', resolve)
  })
}

/** Load one IP list: { ranges } or { problem, kind } where kind is 'failed' or 'not-json'. */
async function loadRanges(source, timeoutMs) {
  let text
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchPage(source, { timeoutMs, accept: 'application/json,*/*;q=0.5', maxBytes: 5 * 1024 * 1024 })
    if (res.error) return { kind: 'failed', problem: `${source} did not answer: ${res.error}` }
    if (res.status !== 200) return { kind: 'failed', problem: `${source} answered HTTP ${res.status}` }
    text = res.text
  } else {
    try {
      text = await readFile(source, 'utf8')
    } catch (error) {
      return { kind: 'failed', problem: error.code === 'ENOENT' ? `no such file: ${source}` : error.message }
    }
  }
  let json
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { kind: 'not-json', problem: `${source} is not a JSON list of IP ranges (it is probably a web page); verify these hits by reverse DNS instead` }
  }
  const ranges = rangesFromJson(json)
  if (!ranges.length) return { kind: 'failed', problem: `${source} holds no IP ranges this reader recognises` }
  return { ranges }
}

function parseRangeOverrides(list) {
  const out = new Map()
  for (const item of list ?? []) {
    const eq = item.indexOf('=')
    if (eq < 1 || eq === item.length - 1) throw new UsageError(`--ranges needs TOKEN=FILE-OR-URL, got "${item}"`)
    out.set(item.slice(0, eq).trim().toLowerCase(), item.slice(eq + 1).trim())
  }
  return out
}

function notChecked(json, input, reason) {
  if (json) console.log(JSON.stringify({ tool: 'check-logs', version: VERSION, input, checked: false, reason }, null, 2))
  else console.log(`check-logs  ${input}\n\n  NOT CHECKED  ${reason}\n`)
  return EXIT.UNCHECKED
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    verify: { type: 'boolean' },
    ranges: { type: 'string', multiple: true },
    timeout: { type: 'string' },
    top: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (!positionals.length) throw new UsageError('give one or more log files, or - for stdin')
  const overrides = parseRangeOverrides(values.ranges)
  if (overrides.size && !values.verify) throw new UsageError('--ranges only has an effect with --verify')
  const timeoutMs = Number(values.timeout ?? 15_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new UsageError('--timeout must be a whole number of milliseconds')
  const top = Number(values.top ?? 5)
  if (!Number.isInteger(top) || top < 0) throw new UsageError('--top must be a whole number')
  const input = positionals.join(' ')

  const roster = loadRoster()
  const stats = new LogStats(botMatchers(roster))
  const findings = []
  const add = (level, rule, message, affects = 0) => findings.push({ level, rule, message, affects })
  let readable = 0
  for (const source of positionals) {
    try {
      await readLog(source, stats)
      readable++
    } catch (error) {
      add('not-checked', 'file', `${source} could not be read: ${error.code === 'ENOENT' ? 'no such file' : error.message}`)
    }
  }
  if (!readable) return notChecked(values.json, input, findings.map((f) => f.message).join('; '))
  if (!stats.parsed) return notChecked(values.json, input, `no line is in a format this reader knows (combined, common or JSON lines)${stats.unparsedSample ? `; the first line reads: ${stats.unparsedSample}` : ''}`)

  if (stats.unparsed) add('not-checked', 'unparsed', `${n0(stats.unparsed)} of ${n0(stats.lines)} line(s) are in no format this reader knows and were skipped, e.g. ${stats.unparsedSample}`, stats.unparsed)
  if (stats.noUa) add('not-checked', 'no-user-agent', `${n0(stats.noUa)} line(s) carry no user agent (the common log format leaves it out), so they could not be attributed to any crawler. Log in the combined format.`, stats.noUa)
  const windowDays = stats.first !== null && stats.last !== null ? (stats.last - stats.first) / 86_400_000 : null

  // ---- verification -------------------------------------------------------------------------
  const lists = new Map()
  const bots = []
  for (const [token, b] of stats.bots) {
    const source = overrides.get(token.toLowerCase()) ?? b.bot.verify?.url ?? null
    let verification = null
    if (values.verify) {
      if (!source) {
        verification = { state: 'no-list', note: `${b.bot.vendor} publishes no IP list for ${token}${b.bot.verify?.note ? ` (${b.bot.verify.note})` : ''}` }
      } else {
        if (!lists.has(source)) lists.set(source, await loadRanges(source, timeoutMs))
        const loaded = lists.get(source)
        if (!loaded.ranges) verification = { state: loaded.kind, source, note: loaded.problem }
        else {
          const verified = []
          const spoofed = []
          const unverifiable = []
          for (const [ip, rec] of b.ips) {
            const parsed = parseIp(ip)
            if (!parsed) unverifiable.push([ip, rec])
            else if (ipInRanges(parsed, loaded.ranges)) verified.push([ip, rec])
            else spoofed.push([ip, rec])
          }
          const sum = (list) => ({ requests: list.reduce((s, [, r]) => s + r.count, 0), status: mergeStatus(list.map(([, r]) => r.status)), ips: list.length })
          verification = {
            state: 'checked', source, ranges: loaded.ranges.length, note: b.bot.verify?.note ?? null,
            verified: sum(verified), spoofed: { ...sum(spoofed), topIps: spoofed.sort((x, y) => y[1].count - x[1].count).slice(0, 5).map(([ip, r]) => ({ ip, requests: r.count })) },
            unverifiable: sum(unverifiable),
          }
        }
      }
    }
    const nonRobots = b.requests - b.robots.count
    bots.push({
      token, vendor: b.bot.vendor, purpose: b.bot.purpose, requests: b.requests, uniqueUrls: b.urls.size,
      refetchShare: nonRobots ? (nonRobots - b.urls.size) / nonRobots : 0,
      status: statusMix(b.status), statusCodes: b.status,
      topUrls: [...b.urls].sort((x, y) => y[1] - x[1]).slice(0, top).map(([url, n]) => ({ url, requests: n })),
      robots: { fetches: b.robots.count, status: b.robots.status },
      firstSeen: iso(b.first), lastSeen: iso(b.last), ips: b.ips.size, verification,
    })
  }
  bots.sort((a, b) => PURPOSES.indexOf(a.purpose) - PURPOSES.indexOf(b.purpose) || b.requests - a.requests)

  // ---- findings ---------------------------------------------------------------------------------
  if (!values.verify) {
    add('not-checked', 'verification', 'user agents were not verified. Anyone can send a crawler\'s user agent, so every count above is of claims; run with --verify to check each IP against the vendor\'s published ranges.')
  }
  for (const b of bots) {
    const v = b.verification
    const search = b.purpose === 'search'
    if (v?.state === 'checked' && v.spoofed.requests) {
      add('info', 'spoofed', `${v.spoofed.requests} ${b.token} request(s) from ${v.spoofed.ips} IP(s) outside ${b.vendor}'s published ranges: a spoofed user agent, not ${b.vendor}. Top: ${v.spoofed.topIps.map((x) => `${x.ip} (${x.requests})`).join(', ')}.${v.note ? ` ${v.note}` : ''}`, v.spoofed.requests)
    }
    if (values.verify && v && v.state !== 'checked') add('not-checked', 'verification', `${b.token}: not verifiable. ${v.note}`, b.requests)

    // Judge the refusals on the hits that really are the crawler, when that is known.
    let basis = { requests: b.requests, status: b.statusCodes, label: 'unverified' }
    if (v?.state === 'checked') {
      if (v.verified.requests) basis = { requests: v.verified.requests, status: v.verified.status, label: 'verified' }
      else basis = null
      const spoofMix = statusMix(v.spoofed.status)
      if (v.spoofed.requests >= MIN_REQUESTS && spoofMix.refusedShare > 0.5) {
        add('info', 'spoofed-refused', `${pct(spoofMix.refusedShare)} of the ${v.spoofed.requests} spoofed ${b.token} request(s) were refused. Turning away impostors is the CDN working as intended.`)
      }
    }
    if (basis && basis.requests >= MIN_REQUESTS) {
      const mix = statusMix(basis.status)
      if (mix.refusedShare > 0.5) {
        const level = search ? (basis.label === 'verified' ? 'error' : 'warn') : 'info'
        const codes = Object.entries(basis.status).filter(([c]) => isRefusal(Number(c))).sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} x${n}`).join(', ')
        add(level, 'refused', `${b.token} (${b.purpose}) got 403, 429 or 5xx on ${pct(mix.refusedShare)} of its ${basis.requests} ${basis.label} request(s) (${codes}). A CDN, firewall or rate limit is turning it away${search ? `, which keeps the site out of ${b.vendor}'s results` : '; blocking a non-search crawler may be a choice'}.${basis.label === 'unverified' ? ` The hits are unverified: if they are impostors, blocking them is correct.${values.verify ? '' : ' Run --verify.'}` : ''}`, basis.requests)
      }
    }
    const robotsBad = Object.entries(b.robots.status).filter(([c]) => Number(c) >= 500 || Number(c) === 429)
    if (robotsBad.length) {
      const n = robotsBad.reduce((s, [, k]) => s + k, 0)
      add(search ? 'error' : 'warn', 'robots-errors', `robots.txt answered ${robotsBad.map(([c, k]) => `${c} x${k}`).join(', ')} to ${b.token}. A crawler that gets 5xx or 429 for robots.txt must assume the whole site is disallowed (RFC 9309 section 2.3.1.4; Google treats 429 the same).`, n)
    }
  }
  const seen = new Set(bots.map((b) => b.token))
  const notSeen = roster.filter((b) => b.purpose === 'search' && b.token && b.ua && !seen.has(b.token))
  const span = windowDays !== null ? ` (${windowDays.toFixed(1)} days)` : ''
  const minor = []
  for (const b of notSeen) {
    if (MAJOR_SEARCH.has(b.token.toLowerCase()) && windowDays !== null && windowDays >= 3) {
      add('warn', 'not-seen', `${b.token} (${b.vendor}) was not seen in this log window${span}. Over several days that usually means a block in front of the server (a CDN or firewall rule), or a log that holds only part of the traffic.`)
    } else minor.push(b.token)
  }
  if (minor.length) add('info', 'not-seen', `search crawlers not seen in this log window${span}: ${minor.join(', ')}. Absence from one window is common and not a fault by itself.`, minor.length)
  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.affects ?? 0) - (a.affects ?? 0))

  if (values.json) {
    console.log(JSON.stringify({
      tool: 'check-logs', version: VERSION, input, checked: true, verified: Boolean(values.verify),
      lines: stats.lines, parsed: stats.parsed, unparsed: stats.unparsed, formats: stats.formats, noUserAgent: stats.noUa,
      window: { first: iso(stats.first), last: iso(stats.last), days: windowDays },
      crawlerRequests: bots.reduce((s, b) => s + b.requests, 0), otherRequests: stats.other,
      bots, notSeen: notSeen.map((b) => b.token), findings, summary: summaryLine(findings),
    }, null, 2))
    return exitFor(findings)
  }

  const lines = [`check-logs  ${input}`, '']
  lines.push(`  lines        ${n0(stats.lines)} read, ${n0(stats.parsed)} parsed (${Object.entries(stats.formats).map(([f, n]) => `${f} ${n0(n)}`).join(', ')})`)
  lines.push(`  window       ${stats.first !== null ? `${iso(stats.first)} to ${iso(stats.last)} (${windowDays.toFixed(1)} days)` : 'no timestamps'}`)
  lines.push(`  crawlers     ${n0(bots.reduce((s, b) => s + b.requests, 0))} request(s) from ${bots.length} known crawler(s); ${n0(stats.other)} from everything else${values.verify ? '' : '  (user agents NOT verified)'}`)
  for (const purpose of PURPOSES) {
    const group = bots.filter((b) => b.purpose === purpose)
    if (!group.length) continue
    lines.push('', `  ${PURPOSE_TITLES[purpose]}`)
    for (const b of group) {
      const c = b.status.counts
      const mix = ['2xx', '3xx', '4xx', '5xx'].map((k) => `${k} ${pct(b.status.total ? c[k] / b.status.total : 0)}`).join('  ')
      const robots = b.robots.fetches ? `robots.txt x${b.robots.fetches} (${Object.entries(b.robots.status).map(([s, n]) => `${s}${n > 1 ? ` x${n}` : ''}`).join(', ')})` : 'no robots.txt fetch'
      lines.push(`    ${b.token.padEnd(22)} ${n0(b.requests).padStart(7)} req  ${n0(b.uniqueUrls).padStart(6)} URLs  ${mix}  re-fetch ${pct(b.refetchShare)}  ${robots}  ${day(b.firstSeen && Date.parse(b.firstSeen))} to ${day(b.lastSeen && Date.parse(b.lastSeen))}`)
      const v = b.verification
      if (v?.state === 'checked') lines.push(`    ${''.padEnd(22)} verified ${n0(v.verified.requests)}${v.verified.requests ? ` (${pct(statusMix(v.verified.status).refusedShare)} refused)` : ''}, unverified (spoofed) ${n0(v.spoofed.requests)}${v.unverifiable.requests ? `, not verifiable ${n0(v.unverifiable.requests)}` : ''}  (${v.ranges} published range(s))`)
      else if (v) lines.push(`    ${''.padEnd(22)} not verifiable: ${v.note}`)
      if (b.topUrls.length) lines.push(`    ${''.padEnd(22)} top: ${b.topUrls.map((u) => `${u.url} (${u.requests})`).join(', ')}`)
    }
  }
  lines.push('')
  for (const f of findings) lines.push(formatFinding(f))
  lines.push('', `  ${summaryLine(findings)}`, '')
  console.log(lines.join('\n'))
  return exitFor(findings)
}

await runMain(main, HELP)
