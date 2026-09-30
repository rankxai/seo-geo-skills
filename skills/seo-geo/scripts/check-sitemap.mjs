#!/usr/bin/env node
/**
 * check-sitemap.mjs: fetch every URL a sitemap advertises and check it is a
 * page a search engine should index.
 *
 *   node skills/seo-geo/scripts/check-sitemap.mjs https://example.com
 *   node skills/seo-geo/scripts/check-sitemap.mjs https://example.com/sitemap.xml --sample 50
 *   node skills/seo-geo/scripts/check-sitemap.mjs sitemap.xml --no-fetch
 *
 * Given a site, it reads the Sitemap: lines in robots.txt, or falls back to
 * /sitemap.xml and then /sitemap_index.xml. Sitemap indexes are followed to
 * their children. XML sitemaps, gzipped or not, text sitemaps (one URL per
 * line) and RSS or Atom feeds are all read, because Google accepts all of them.
 *
 * Every <loc> must answer:
 *   loc-status     HTTP 200. Anything else is an entry the engine will drop.
 *   loc-redirect   no redirect. A sitemap should list the final URL; a
 *                  redirecting entry is a wasted fetch and a mixed signal. A
 *                  temporary redirect to a locale-prefixed copy (/gb/...) is
 *                  reported as loc-locale-redirect instead, a warning: it is
 *                  usually geo redirection aimed at this machine's IP.
 *   loc-noindex    no noindex, in the robots meta tag OR the X-Robots-Tag
 *                  header. Listing a URL and forbidding its indexing
 *                  contradicts itself, and a meta-only check misses the header.
 *   loc-canonical  a canonical equal to the <loc> itself (Google: list only
 *                  canonical URLs). A missing canonical warns.
 * Across the file (every entry, even with --sample):
 *   lastmod-future, lastmod-format, lastmod-restamp, lastmod-missing
 *                  Google uses lastmod only when it is consistently and
 *                  verifiably accurate, so a date in the future, or one date
 *                  shared by more than 80% of the URLs in one sitemap (a
 *                  build restamping everything), costs the whole file's
 *                  credibility. Google News sitemaps are exempt from the
 *                  shared-date rule, since they list two days of articles.
 *   sitemap-limit  50,000 URLs or 50 MB uncompressed per file (sitemaps.org).
 *   sitemap-nesting  an index listed inside an index; Google does not
 *                  follow nested indexes, and neither does this check.
 *   cross-host     a URL on another host than its sitemap is ignored unless
 *                  that host has verified cross-submission; a sitemap listed
 *                  in a host's robots.txt counts as that host's permission.
 *
 * Fetching runs four at a time. A URL that fails with a network error, 429 or
 * 5xx is retried once after 20 seconds, because a busy origin should not read
 * as a broken sitemap. A URL that still does not answer, or that answers only
 * with a bot-protection wall, is "not checked", never counted as clean.
 *
 * A large site's index can list thousands of child sitemaps (one news site
 * lists one per month since 1851, one marketplace 13.8 million URLs across
 * seven indexes). --max-sitemaps (default 50) caps how many sitemap files are
 * read in all, shared round-robin across the indexes and spread evenly within
 * each; --max-urls (default 500,000) stops reading once that many URLs are in
 * hand. Both say what they skipped, as NOT CHECKED.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { BROWSER_UA, EXIT, USER_AGENT, UsageError, botWall, classifyArg, exitFor, fetchPage, formatFinding, intOption, parseCli, pool, readStdin, runMain, sleep, summaryLine, VERSION } from './lib/cli.mjs'
import { MAX_BYTES, MAX_URLS, SitemapTooLarge, checkLoc, evenSample, lastmodFindings, parseSitemap, sitemapText } from './lib/sitemap.mjs'
import { parseRobots } from './lib/robots.mjs'
import { readFile } from 'node:fs/promises'

const HELP = `usage: node check-sitemap.mjs <site URL | sitemap URL | sitemap file | -> [options]

Fetches every URL in the sitemap (and its child sitemaps) and checks each is a
200, does not redirect, is not noindex, and is its own canonical. Also checks
lastmod dates across the whole file.

options:
  --sample <n>          check only n URLs, spread evenly across the sitemap
  --no-fetch            do not fetch any URL; lastmod and format checks only
  --max-sitemaps <n>    read at most n sitemap files in all, shared evenly
                        across every index (default 50)
  --max-urls <n>        stop reading sitemaps once n URLs are in hand
                        (default 500000)
  --concurrency <n>     parallel requests (default 4)
  --retry-delay <ms>    wait before the single retry of a failed URL (default 20000)
  --timeout <ms>        per-request timeout in milliseconds (default 30000)
  --json                machine-readable output
  -h, --help            this text

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }

/** In the text report, at most this many findings of one rule are listed; --json has them all. */
const PER_RULE = 8

/** Read a sitemap body: 50 MB is the protocol limit, so one byte past it proves the file is over. */
const SITEMAP_READ_BYTES = MAX_BYTES + 1

const hostOf = (s) => {
  try {
    return new URL(s).host
  } catch {
    return null
  }
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    sample: { type: 'string' },
    'no-fetch': { type: 'boolean' },
    'max-sitemaps': { type: 'string' },
    'max-urls': { type: 'string' },
    concurrency: { type: 'string' },
    'retry-delay': { type: 'string' },
    timeout: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length !== 1) throw new UsageError('give exactly one site URL, sitemap URL, sitemap file or - (stdin)')
  const sample = intOption(values.sample, 'sample', 0)
  const maxSitemaps = intOption(values['max-sitemaps'], 'max-sitemaps', 50, 1)
  const maxUrls = intOption(values['max-urls'], 'max-urls', 500_000, 1)
  const concurrency = intOption(values.concurrency, 'concurrency', 4, 1)
  const retryDelay = intOption(values['retry-delay'], 'retry-delay', 20_000)
  const timeoutMs = intOption(values.timeout, 'timeout', 30_000, 1)
  const noFetch = Boolean(values['no-fetch'])

  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  const arg = positionals[0]
  const what = classifyArg(arg)

  // ---- find and read the sitemap(s) -------------------------------------------
  const roots = [] // { source, text?, bytes?, robotsHost? }
  let discovery = null
  let fallbacks = []
  if (what.kind === 'url') {
    const u = new URL(what.url)
    if (/\.(?:xml|txt)(?:\.gz)?$/i.test(u.pathname) || /sitemap|\.rss$|\/feed\/?$/i.test(u.pathname)) {
      roots.push({ source: u.href })
      discovery = 'given'
    } else {
      const robots = await fetchPage(`${u.origin}/robots.txt`, { timeoutMs, accept: 'text/plain,*/*', maxRedirects: 5, maxBytes: 2 * 1024 * 1024 })
      const listed = !robots.error && robots.status >= 200 && robots.status < 300 ? parseRobots(robots.buffer.subarray(0, 500 * 1024).toString('utf8')).sitemaps : []
      if (listed.length) {
        const base = robots.finalUrl ?? `${u.origin}/robots.txt`
        for (const s of listed) {
          let abs = null
          try {
            abs = new URL(s, base).href
          } catch {
            // reported below
          }
          if (!abs || !/^https?:/i.test(abs)) {
            add('error', 'sitemap-discovery', `robots.txt lists "Sitemap: ${s}", which is not a URL`)
            continue
          }
          if (!/^https?:\/\//i.test(s)) add('warn', 'sitemap-discovery', `robots.txt lists "Sitemap: ${s}", a relative URL; the protocol and Google require a fully-qualified one. Checked as ${abs}.`)
          roots.push({ source: abs, robotsHost: u.host })
        }
        discovery = `robots.txt lists ${listed.length} sitemap(s)`
      } else {
        fallbacks = [`${u.origin}/sitemap.xml`, `${u.origin}/sitemap_index.xml`]
        roots.push({ source: fallbacks[0], fallback: true, robotsHost: u.host })
        const robotsRead = !robots.error && robots.status >= 200 && robots.status < 300
        const robotsAbsent = !robots.error && robots.status >= 400 && robots.status < 500 && robots.status !== 429
        if (robotsRead) {
          discovery = 'robots.txt lists no sitemap; tried /sitemap.xml'
          add('info', 'sitemap-discovery', 'robots.txt has no Sitemap: line. Listing the sitemap there lets every crawler find it, not only the engines you submit it to.')
        } else if (robotsAbsent) {
          discovery = `robots.txt answered ${robots.status}; tried /sitemap.xml`
          add('info', 'sitemap-discovery', `robots.txt answered HTTP ${robots.status}, so it lists no sitemap. Listing the sitemap there lets every crawler find it.`)
        } else {
          // Not read is not empty: a 429 or a timeout says nothing about its Sitemap: lines.
          discovery = `robots.txt could not be read (${robots.error ?? `HTTP ${robots.status}`}); tried /sitemap.xml`
          add('not-checked', 'sitemap-discovery', `robots.txt could not be read (${robots.error ?? `HTTP ${robots.status}`}), so any Sitemap: lines in it were not seen; only /sitemap.xml and /sitemap_index.xml were tried`)
        }
      }
    }
  } else {
    try {
      const buf = what.kind === 'stdin' ? await readStdin() : await readFile(what.path)
      const text = sitemapText(buf)
      roots.push({ source: what.kind === 'stdin' ? 'stdin' : what.path, text, bytes: Buffer.byteLength(text) })
    } catch (error) {
      if (error instanceof SitemapTooLarge) return notChecked(values.json, arg, `${what.path ?? 'stdin'} ${error.message}`)
      return notChecked(values.json, arg, error.code === 'ENOENT' ? `no such file: ${what.path}` : error.message)
    }
  }

  // Read one sitemap body. Returns { text, bytes, res } or { finding } or { missing }.
  const readSitemap = async (sm) => {
    const opts = { timeoutMs, accept: 'application/xml,text/xml,*/*;q=0.8', maxBytes: SITEMAP_READ_BYTES }
    let res = await fetchPage(sm.source, opts)
    if (!res.error && botWall(res.status, res.headers)) {
      const again = await fetchPage(sm.source, { ...opts, userAgent: BROWSER_UA })
      if (!again.error && again.status === 200 && !botWall(again.status, again.headers)) {
        add('warn', 'sitemap-fetch', `${sm.source} refused this tool (${botWall(res.status, res.headers)}) but served a browser; read from the browser's copy. Check that the CDN serves it to crawlers.`)
        res = again
      } else {
        return { finding: { level: 'not-checked', rule: 'sitemap-fetch', message: `${sm.source} answered with a bot-protection wall (${botWall(res.status, res.headers)}), to a browser user agent too, so it was not read` } }
      }
    }
    if (res.error) return { finding: { level: 'not-checked', rule: 'sitemap-fetch', message: `${sm.source} did not answer: ${res.error}` } }
    if (res.status !== 200) {
      if (sm.fallback && (res.status === 404 || res.status === 410 || (res.status >= 400 && res.status < 500))) return { missing: res.status }
      return { finding: { level: 'error', rule: 'sitemap-fetch', message: `${sm.source} returned HTTP ${res.status}` } }
    }
    if (res.redirected) add('info', 'sitemap-redirect', `${sm.source} redirected to ${res.finalUrl}; list the final URL in robots.txt and Search Console`)
    if (res.truncated) return { finding: { level: 'error', rule: 'sitemap-limit', message: `${sm.source} is over 50 MB uncompressed; the limit is 50 MB, and engines may ignore the whole file` } }
    try {
      const text = sitemapText(res.buffer)
      return { text, bytes: Buffer.byteLength(text), res }
    } catch (error) {
      if (error instanceof SitemapTooLarge) return { finding: { level: 'error', rule: 'sitemap-limit', message: `${sm.source} ${error.message}` } }
      return { finding: { level: 'error', rule: 'sitemap-format', message: `${sm.source} could not be decompressed: ${error.message}` } }
    }
  }

  const sitemaps = []
  const entries = []
  let unreadable = 0
  // Budgets, so a site with seven indexes and 2,000 children each is sampled
  // rather than downloaded: --max-sitemaps counts every sitemap file read,
  // shared round-robin across the indexes; --max-urls stops reading once that
  // many URLs are in hand (measured: one marketplace's sitemaps list 13.8
  // million URLs, and holding them all exhausted a 4 GB heap).
  let sitemapBudget = maxSitemaps
  const unreadChildren = [] // { parent, listed, read }
  let urlsetsSkippedForUrls = 0
  // A sitemap reached twice (listed in robots.txt AND inside an index) is read once.
  const visited = new Set()
  // The top level takes at most half the budget, so a robots.txt that lists
  // hundreds of indexes (one travel site lists 434) still leaves reads for
  // the URL lists underneath them.
  let level = evenSample(roots.map((r) => ({ ...r, depth: 0 })), roots.length > 1 ? Math.ceil(maxSitemaps / 2) : maxSitemaps)
  let urlsetsRead = 0
  if (level.length < roots.length) unreadChildren.push({ parent: 'robots.txt', listed: roots.length, read: level.length })

  const readOne = async (sm) => {
    if (sm.text !== undefined) return { text: sm.text, bytes: sm.bytes ?? 0 }
    if (noFetch) return { finding: { level: 'not-checked', rule: 'sitemap-fetch', message: `${sm.source} was not fetched (--no-fetch)` } }
    let got = await readSitemap(sm)
    // No Sitemap: line and no /sitemap.xml: try the other common name once.
    if (got.missing && sm.fallback && sm.source === fallbacks[0]) {
      const second = { ...sm, source: fallbacks[1] }
      got = await readSitemap(second)
      if (!got.missing) Object.assign(sm, second)
    }
    return got
  }

  while (level.length) {
    level = level.filter((sm) => (visited.has(sm.source) ? false : (visited.add(sm.source), true)))
    sitemapBudget -= level.length
    const groups = [] // children of each index at this level: { parent, children }
    for (let start = 0; start < level.length; start += concurrency) {
      const chunk = level.slice(start, start + concurrency)
      if (entries.length >= maxUrls && chunk.every((sm) => sm.depth > 0)) {
        urlsetsSkippedForUrls += level.length - start
        break
      }
      const bodies = await pool(chunk, concurrency, readOne)
      for (let i = 0; i < chunk.length; i++) {
        const sm = chunk[i]
        const got = bodies[i]
        if (got.missing !== undefined) {
          return notChecked(values.json, arg, `no sitemap found: robots.txt lists none, and ${fallbacks.map((f) => new URL(f).pathname).join(' and ')} answered HTTP ${got.missing}. A sitemap is optional; engines still find pages through links.`)
        }
        if (got.finding) {
          if (got.finding.level !== 'error' || got.finding.rule === 'sitemap-fetch') unreadable++
          findings.push(got.finding)
          continue
        }
        const parsed = parseSitemap(got.text)
        sitemaps.push({ source: sm.source, type: parsed.type, count: parsed.entries.length })
        if (parsed.type === 'unknown') {
          add('error', 'sitemap-format', `${sm.source} is not a sitemap: not a <urlset> or <sitemapindex>, not an RSS or Atom feed, and not a text file of one URL per line`)
          continue
        }
        if (parsed.entries.length > MAX_URLS) add('error', 'sitemap-limit', `${sm.source} lists ${parsed.entries.length} entries; the limit is ${MAX_URLS} per file and engines may ignore the rest`)
        if (got.bytes > MAX_BYTES) add('error', 'sitemap-limit', `${sm.source} is ${(got.bytes / 1048576).toFixed(1)} MB uncompressed; the limit is 50 MB`)
        const empty = parsed.entries.filter((e) => !e.loc).length
        if (empty) add('error', 'sitemap-format', `${sm.source} has ${empty} entr${empty === 1 ? 'y' : 'ies'} with no <loc>`)
        if (parsed.type === 'index') {
          if (sm.depth >= 1) {
            add('warn', 'sitemap-nesting', `${sm.source} is a sitemap index listed inside another index. Google does not follow nested indexes, so its ${parsed.entries.length} child sitemap(s) were not read here either; list them in the top-level index.`)
            continue
          }
          const children = []
          for (const e of parsed.entries.filter((x) => x.loc)) {
            let abs = null
            try {
              abs = new URL(e.loc).href
            } catch {
              abs = null
            }
            if (!abs || !/^https?:/i.test(abs)) {
              add('error', 'sitemap-format', `${sm.source} lists a child sitemap "${e.loc}" that is not an absolute http(s) URL`)
              continue
            }
            children.push({ source: abs, depth: sm.depth + 1, robotsHost: sm.robotsHost })
          }
          groups.push({ parent: sm.source, children })
        } else if (entries.length >= maxUrls) {
          urlsetsSkippedForUrls++
        } else {
          urlsetsRead++
          if (parsed.entries.length === 0) add('warn', 'sitemap-empty', `${sm.source} lists no URLs`)
          for (const e of parsed.entries) if (e.loc) entries.push({ ...e, sitemap: sm.source, robotsHost: sm.robotsHost })
        }
      }
    }
    level = allocate(groups, Math.max(0, sitemapBudget), unreadChildren)
  }
  if (unreadChildren.length) {
    const listed = unreadChildren.reduce((n, g) => n + g.listed, 0)
    const read = unreadChildren.reduce((n, g) => n + g.read, 0)
    add('not-checked', 'sitemap-count', `${listed} sitemaps are listed in ${unreadChildren.length === 1 ? unreadChildren[0].parent : `${unreadChildren.length} places (${unreadChildren.slice(0, 3).map((g) => g.parent).join(', ')}${unreadChildren.length > 3 ? ', ...' : ''})`}; ${read} ${read === 1 ? 'was' : 'were'} read, spread evenly (--max-sitemaps ${maxSitemaps} files in all). The rest were not read, so the URL and lastmod checks describe a sample of the site.`)
  }
  if (urlsetsSkippedForUrls) {
    add('not-checked', 'sitemap-count', `reading stopped at ${entries.length.toLocaleString('en-US')} URLs (--max-urls ${maxUrls.toLocaleString('en-US')}); ${urlsetsSkippedForUrls} more sitemap file(s) were not read`)
  }

  if (sitemaps.length === 0) {
    const reason = findings.filter((f) => f.level !== 'info').map((f) => f.message).join('; ') || 'no sitemap could be read'
    if (unreadable && findings.every((f) => f.level !== 'error')) return notChecked(values.json, arg, reason)
    return report(values.json, { arg, discovery, sitemaps, entries: [], checked: [], findings })
  }

  // ---- whole-file checks ----------------------------------------------------------
  const seen = new Set()
  const unique = entries.filter((e) => (seen.has(e.loc) ? false : (seen.add(e.loc), true)))
  if (unique.length < entries.length) add('info', 'sitemap-duplicates', `${entries.length - unique.length} URL(s) are listed more than once`)
  const badUrls = unique.filter((e) => {
    try {
      const p = new URL(e.loc).protocol
      return p !== 'http:' && p !== 'https:'
    } catch {
      return true
    }
  })
  if (badUrls.length) add('error', 'sitemap-format', `${badUrls.length} <loc> value(s) are not absolute http(s) URLs, e.g. "${badUrls[0].loc}"`)
  const valid = unique.filter((e) => !badUrls.includes(e))
  // A URL may sit on its sitemap's host, or on the host whose robots.txt
  // listed the sitemap: that listing is the cross-submission proof
  // (sitemaps.org, "Sitemaps & Cross Submits").
  const crossHost = valid.filter((e) => {
    const sitemapHost = hostOf(e.sitemap)
    const locHost = hostOf(e.loc)
    return sitemapHost && locHost !== sitemapHost && locHost !== e.robotsHost
  })
  if (crossHost.length) add('warn', 'cross-host', `${crossHost.length} URL(s) are on a different host from their sitemap, e.g. ${crossHost[0].loc} in ${crossHost[0].sitemap}; engines ignore them unless that host's robots.txt lists the sitemap or cross-submission is verified in Search Console`)
  findings.push(...lastmodFindings(valid))

  // ---- per-URL checks -------------------------------------------------------------------
  // URLs on another host are reported above and never fetched: a sitemap from an untrusted site
  // must not be able to point this tool at arbitrary addresses.
  const fetchable = valid.filter((e) => !crossHost.includes(e))
  const targets = evenSample(fetchable, sample)
  let checked = []
  if (noFetch) {
    add('not-checked', 'loc', `${valid.length} URL(s) were not fetched (--no-fetch); status, redirect, noindex and canonical were not checked`)
  } else {
    checked = await pool(targets, concurrency, async (e) => ({ ...e, ...(await checkLoc(e.loc, { timeoutMs, userAgent: USER_AGENT })) }))
    const retry = checked.filter((r) => r.retryable)
    if (retry.length) {
      await sleep(retryDelay)
      const again = await pool(retry, concurrency, async (e) => ({ ...e, ...(await checkLoc(e.loc, { timeoutMs, userAgent: USER_AGENT })), retried: true }))
      const byLoc = new Map(again.map((r) => [r.loc, r]))
      checked = checked.map((r) => byLoc.get(r.loc) ?? r)
    }
    for (const r of checked) {
      if (r.unreachable) add('not-checked', 'loc', `${r.loc} did not answer${r.retried ? ' after one retry' : ''}: ${r.unreachable}`)
      else if (r.blocked) add('not-checked', 'loc-blocked', `${r.loc} answered with a bot-protection wall (${r.blocked}), to a browser user agent too; not evidence either way`)
      for (const p of r.problems) findings.push({ ...p, message: `${r.loc}: ${p.message}` })
    }
    const browserOnly = checked.filter((r) => r.browserOnly)
    if (browserOnly.length) add('warn', 'loc-bot-wall', `${browserOnly.length} URL(s) refused this tool's user agent but served a browser, e.g. ${browserOnly[0].loc}; they were checked on the browser's copy. Crawlers are judged by user agent and IP too: run check-crawlers.mjs --live.`)
    if (sample && sample < fetchable.length) add('info', 'sample', `checked ${targets.length} of ${fetchable.length} URLs (--sample ${sample}); the rest were not fetched`)
  }

  const code = report(values.json, { arg, discovery, sitemaps, entries: valid, checked, findings })
  const inconclusive = checked.filter((r) => r.unreachable || r.blocked).length
  if (code === EXIT.CLEAN && checked.length && inconclusive === checked.length) return EXIT.UNCHECKED
  // Only indexes were read (the budget ran out above the URL lists): nothing was checked.
  if (code === EXIT.CLEAN && urlsetsRead === 0 && !noFetch) return EXIT.UNCHECKED
  return code
}

/**
 * Share `budget` sitemap reads across the child lists of several indexes,
 * round-robin, so a big index cannot starve a small one; within each index
 * the picks are spread evenly. Records what was left unread in `unread`.
 */
function allocate(groups, budget, unread = []) {
  const quotas = groups.map(() => 0)
  let left = budget
  let progress = true
  while (left > 0 && progress) {
    progress = false
    for (let i = 0; i < groups.length && left > 0; i++) {
      if (quotas[i] < groups[i].children.length) {
        quotas[i]++
        left--
        progress = true
      }
    }
  }
  const picked = []
  groups.forEach((g, i) => {
    const take = quotas[i] ? evenSample(g.children, quotas[i]) : []
    if (take.length < g.children.length) unread.push({ parent: g.parent, listed: g.children.length, read: take.length })
    picked.push(...take)
  })
  return picked
}

function notChecked(json, arg, reason) {
  if (json) console.log(JSON.stringify({ tool: 'check-sitemap', version: VERSION, input: arg, checked: false, reason }, null, 2))
  else console.log(`check-sitemap  ${arg}\n\n  NOT CHECKED  ${reason}\n`)
  return EXIT.UNCHECKED
}

function report(json, { arg, discovery, sitemaps, entries, checked, findings }) {
  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level])
  const clean = checked.filter((r) => !r.unreachable && !r.blocked && r.problems.length === 0).length
  if (json) {
    console.log(JSON.stringify({
      tool: 'check-sitemap', version: VERSION, input: arg, checked: true, discovery, sitemaps, urls: entries.length,
      fetched: checked.length, clean,
      results: checked.map((r) => ({ loc: r.loc, lastmod: r.lastmod ?? null, status: r.status, problems: r.problems, unreachable: r.unreachable ?? null, blocked: r.blocked ?? null })),
      findings, summary: summaryLine(findings),
    }, null, 2))
    return exitFor(findings)
  }
  const lines = [`check-sitemap  ${arg}`, '']
  if (discovery) lines.push(`  discovery    ${discovery}`)
  const shownMaps = sitemaps.slice(0, 30)
  for (const s of shownMaps) lines.push(`  ${s.type.padEnd(12)} ${s.source}  (${s.count} entr${s.count === 1 ? 'y' : 'ies'})`)
  if (sitemaps.length > shownMaps.length) lines.push(`  ...          and ${sitemaps.length - shownMaps.length} more sitemap(s)`)
  lines.push(`  urls         ${entries.length} unique, ${checked.length} fetched, ${clean} clean`, '')
  // One rule repeated for every sampled URL buries everything else: list a
  // few of each, and say how many more.
  const perRule = new Map()
  for (const f of findings) {
    const key = `${f.level} ${f.rule}`
    const n = (perRule.get(key) ?? 0) + 1
    perRule.set(key, n)
    if (n <= PER_RULE) lines.push(formatFinding(f))
  }
  for (const [key, n] of perRule) if (n > PER_RULE) lines.push(`  ... and ${n - PER_RULE} more ${key.split(' ')[1]} finding(s) at ${key.split(' ')[0]} level (use --json for all)`)
  lines.push('', `  ${summaryLine(findings)}`, '')
  console.log(lines.join('\n'))
  return exitFor(findings)
}

await runMain(main, HELP)
