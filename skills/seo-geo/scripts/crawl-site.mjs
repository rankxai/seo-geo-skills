#!/usr/bin/env node
/**
 * crawl-site.mjs: crawl a capped number of pages on one site and report the
 * defects that only show up across pages.
 *
 *   node skills/seo-geo/scripts/crawl-site.mjs https://example.com
 *   node skills/seo-geo/scripts/crawl-site.mjs https://example.com --max 500
 *   node skills/seo-geo/scripts/crawl-site.mjs https://example.com --sitemap https://example.com/sitemap.xml
 *
 * Breadth-first from the start URL, then any sitemap URL no link led to, until
 * --max URLs have been fetched. It reports, ranked by how many URLs each
 * finding touches:
 *
 *   broken-link            internal links to a 4xx or 5xx, with the linking pages
 *   fragment-missing       links to #id where the id is not in the served HTML
 *   internal-redirect, redirect-chain, redirect-loop
 *                          internal links that redirect, chains of 2 or more hops
 *   not-in-sitemap         indexable pages linked internally but not in the sitemap
 *   sitemap-orphan         sitemap URLs no page reachable from the start links to
 *                          (only when every internal link was followed; a capped
 *                          crawl says so instead of guessing)
 *   sitemap-url-status     sitemap URLs the crawl fetched that are not a plain 200
 *   duplicate-title, duplicate-description
 *                          grouped, over indexable, self-canonical pages
 *   missing-title, missing-description, missing-h1
 *   noindex-linked, noindex-in-sitemap
 *   canonical-elsewhere, canonical-broken
 *   deep-pages             more than 4 clicks from the start URL, plus the whole
 *                          click depth distribution
 *
 * Politeness: same host only (plus the host the start URL redirects to), four
 * requests at a time, a per-request timeout, a hard cap on URLs fetched, and
 * robots.txt obeyed for this tool's user agent (which falls to the * group)
 * unless --ignore-robots is given for a site you own. A Crawl-delay in that
 * group is honoured, up to 10 seconds, one request at a time. A URL that
 * answers 429, 5xx or nothing is retried once. Only HTML bodies are read, to
 * at most 5 MB; other files are closed after the headers.
 *
 * Anything the crawl did not reach (the cap, robots.txt, a bot wall, a network
 * failure) is reported as not checked, never as clean.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { BROWSER_UA, EXIT, USER_AGENT, UsageError, botWall, classifyArg, decodeText, exitFor, fetchPage, formatFinding, intOption, parseCli, readBody, runMain, sleep, summaryLine, VERSION } from './lib/cli.mjs'
import { fetchSemantics, isPathAllowed, parseRobots, productToken, rulesForAgent } from './lib/robots.mjs'
import { MAX_BYTES, evenSample, parseSitemap, sitemapText } from './lib/sitemap.mjs'
import { analyseCrawl, clickDepths, crawlKey, depthDistribution, extractPage } from './lib/crawl.mjs'

const HELP = `usage: node crawl-site.mjs <site URL> [options]

Crawls the site breadth-first from the URL given (same host only) and reports
broken internal links, missing #fragment targets, internal redirects and
chains, pages missing from the sitemap, sitemap URLs nothing links to,
duplicate and missing titles and descriptions, missing h1, noindex pages that
are linked or listed, canonicals pointing elsewhere, and click depth.

options:
  --max <n>             fetch at most n URLs (default 200)
  --sitemap <url>       read this sitemap instead of the ones robots.txt lists
                        (default: robots.txt Sitemap lines, else /sitemap.xml)
  --concurrency <n>     parallel requests (default 4)
  --timeout <ms>        per-request timeout in milliseconds (default 15000)
  --retry-delay <ms>    wait before the single retry of a failed URL (default 10000)
  --ignore-robots       crawl paths robots.txt disallows (only on a site you own)
  --json                machine-readable output
  -h, --help            this text

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }
const PER_RULE = 8
const PAGE_READ_BYTES = 5 * 1024 * 1024
/**
 * Sitemap reading stops at 50 child sitemaps or 50,000 same-site URLs,
 * whichever comes first, so a 40-page crawl of a large site does not download
 * half a million sitemap entries. A sitemap read only in part cannot say a page
 * is ABSENT from it, so the checks that need that say "not checked" instead.
 */
const MAX_CHILD_SITEMAPS = 50
const MAX_SITEMAP_URLS = 50_000
const MAX_CRAWL_DELAY_S = 10
const ROBOTS_TOKEN = productToken(USER_AGENT)

const isHtmlType = (type) => /html/i.test(type || '')

/**
 * Fetch one URL for the crawl: redirects followed by hand (at most 10 hops,
 * stopping at the first hop that leaves the site), and the body read only when
 * it is HTML. Never throws.
 */
async function fetchOnce(url, { userAgent, timeoutMs, isSite }) {
  const chain = []
  let current = url
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    for (;;) {
      const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, signal })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
        await res.body?.cancel().catch(() => {})
        let next
        try {
          next = new URL(location, current).href
        } catch {
          return { status: res.status, chain, finalUrl: current, redirectError: `redirect to an invalid Location "${location}"` }
        }
        chain.push({ url: current, status: res.status, location: next })
        const nextKey = crawlKey(next)
        if (!nextKey) return { status: res.status, chain, finalUrl: next, offsite: true }
        if (chain.some((h) => crawlKey(h.url) === nextKey)) return { status: res.status, chain, finalUrl: next, redirectError: `redirect loop (${chain.map((h) => h.status).join(' > ')} back to ${next})` }
        if (chain.length > 10) return { status: res.status, chain, finalUrl: next, redirectError: 'more than 10 redirects' }
        if (!isSite(nextKey)) return { status: res.status, chain, finalUrl: next, offsite: true }
        current = next
        continue
      }
      const contentType = res.headers.get('content-type') ?? ''
      const wall = botWall(res.status, res.headers)
      let text = null
      let truncated = false
      if (!wall && res.status === 200 && (isHtmlType(contentType) || !contentType)) {
        const body = await readBody(res, PAGE_READ_BYTES)
        truncated = body.truncated
        const decoded = decodeText(body.buffer, contentType).text
        text = isHtmlType(contentType) || /^\s*</.test(decoded) ? decoded : null
      } else {
        await res.body?.cancel().catch(() => {})
      }
      return { status: res.status, chain, finalUrl: current, headers: res.headers, contentType, text, truncated, wall }
    }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || (error?.name === 'AbortError' && signal.aborted)
    return { error: timedOut ? `timed out after ${timeoutMs} ms` : error?.cause?.code || error?.message || String(error), chain }
  }
}

/** fetchOnce, with the browser fallback for a bot wall and one retry for 429, 5xx or no answer. */
async function fetchForCrawl(url, opts) {
  const attempt = async () => {
    const first = await fetchOnce(url, { ...opts, userAgent: USER_AGENT })
    if (!first.wall) return first
    const again = await fetchOnce(url, { ...opts, userAgent: BROWSER_UA })
    if (again.error || again.wall) return { ...first, blocked: first.wall }
    return { ...again, browserOnly: true }
  }
  let r = await attempt()
  if (r.error || r.status === 429 || r.status >= 500) {
    await sleep(opts.retryDelay)
    r = { ...(await attempt()), retried: true }
  }
  if (r.status === 429 && !r.blocked) r.blocked = 'HTTP 429 (rate limited)'
  return r
}

async function readRobots(origin, timeoutMs) {
  const res = await fetchPage(`${origin}/robots.txt`, { timeoutMs, accept: 'text/plain,*/*;q=0.8', maxRedirects: 5, maxBytes: 2 * 1024 * 1024 })
  const status = res.error ? null : res.status
  const sem = fetchSemantics(status)
  const robots = sem.state === 'ok' ? parseRobots(res.buffer.subarray(0, 500 * 1024).toString('utf8')) : null
  const { rules = [], crawlDelay } = robots ? rulesForAgent(robots, ROBOTS_TOKEN) : {}
  return { status, error: res.error ?? null, sem, robots, rules, crawlDelay, finalUrl: res.finalUrl ?? `${origin}/robots.txt` }
}

/** Read the sitemaps into a Set of same-site keys. Returns { keys, read, notes, complete }. */
async function readSitemaps(sources, { timeoutMs, isSite }) {
  const keys = new Set()
  const read = []
  const notes = []
  let level = sources.map((s) => ({ source: s, depth: 0 }))
  let offsite = 0
  let complete = true
  let full = false
  while (level.length && !full) {
    const next = []
    for (const sm of level) {
      if (full) {
        complete = false
        break
      }
      const res = await fetchPage(sm.source, { timeoutMs, accept: 'application/xml,text/xml,*/*;q=0.8', maxBytes: MAX_BYTES + 1 })
      if (res.error || res.status !== 200) {
        notes.push({ source: sm.source, problem: res.error ?? `HTTP ${res.status}` })
        if (sm.depth > 0 || read.length) complete = false
        continue
      }
      let parsed
      try {
        parsed = parseSitemap(sitemapText(res.buffer))
      } catch (error) {
        notes.push({ source: sm.source, problem: error.message })
        complete = false
        continue
      }
      read.push({ source: sm.source, type: parsed.type, count: parsed.entries.length })
      if (parsed.type === 'index') {
        if (sm.depth >= 1) continue
        const children = parsed.entries.map((e) => crawlKey(e.loc)).filter(Boolean)
        const picked = evenSample(children, MAX_CHILD_SITEMAPS)
        if (picked.length < children.length) {
          complete = false
          notes.push({ source: sm.source, problem: `lists ${children.length} child sitemaps; at most ${picked.length} are read, spread evenly` })
        }
        next.push(...picked.map((source) => ({ source, depth: sm.depth + 1 })))
        continue
      }
      for (const e of parsed.entries) {
        const k = crawlKey(e.loc)
        if (!k) continue
        if (!isSite(k)) {
          offsite++
          continue
        }
        if (keys.size >= MAX_SITEMAP_URLS) {
          notes.push({ source: sm.source, problem: `reading stopped at ${MAX_SITEMAP_URLS} URLs on this site; the rest of the sitemap was not read` })
          complete = false
          full = true
          break
        }
        keys.add(k)
      }
    }
    level = next
  }
  if (offsite) notes.push({ source: 'sitemap', problem: `${offsite} URL(s) on other hosts were ignored` })
  return { keys, read, notes, complete }
}

function notChecked(json, input, reason) {
  if (json) console.log(JSON.stringify({ tool: 'crawl-site', version: VERSION, input, checked: false, reason }, null, 2))
  else console.log(`crawl-site  ${input}\n\n  NOT CHECKED  ${reason}\n`)
  return EXIT.UNCHECKED
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    max: { type: 'string' },
    sitemap: { type: 'string' },
    concurrency: { type: 'string' },
    timeout: { type: 'string' },
    'retry-delay': { type: 'string' },
    'ignore-robots': { type: 'boolean' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length !== 1) throw new UsageError('give exactly one site URL')
  const what = classifyArg(positionals[0])
  if (what.kind !== 'url') throw new UsageError('crawl-site needs a site URL (http or https), not a file')
  const max = intOption(values.max, 'max', 200, 1)
  let concurrency = intOption(values.concurrency, 'concurrency', 4, 1)
  const timeoutMs = intOption(values.timeout, 'timeout', 15_000, 1)
  const retryDelay = intOption(values['retry-delay'], 'retry-delay', 10_000)
  if (values.sitemap && !/^https?:\/\//i.test(values.sitemap)) throw new UsageError('--sitemap must be an http(s) URL')
  const ignoreRobots = Boolean(values['ignore-robots'])
  const input = positionals[0]
  const findings = []
  const add = (level, rule, message, affects = 0) => findings.push({ level, rule, message, affects, urls: [] })

  // ---- robots.txt and the start URL ------------------------------------------------
  const startKey = crawlKey(what.url)
  const siteHosts = new Set([new URL(startKey).host])
  const isSite = (k) => {
    try {
      return siteHosts.has(new URL(k).host)
    } catch {
      return false
    }
  }
  let robots = await readRobots(new URL(startKey).origin, timeoutMs)
  const allowed = (k) => {
    if (ignoreRobots || robots.sem.allowAll || !robots.robots) return !robots.sem.disallowAll || ignoreRobots
    const u = new URL(k)
    return isPathAllowed(robots.rules, `${u.pathname}${u.search}`).allowed
  }
  if (!allowed(startKey)) {
    return notChecked(values.json, input, robots.sem.disallowAll
      ? `${robots.sem.note}. Nothing was crawled. On a site you own, --ignore-robots crawls anyway.`
      : `robots.txt disallows ${new URL(startKey).pathname} for this tool's user agent (the * group), so nothing was crawled. On a site you own, --ignore-robots crawls anyway.`)
  }
  const fetchOpts = { timeoutMs, retryDelay, isSite: (k) => isSite(k) }
  // The start URL may redirect to another host (apex to www, http to https): that host is the site.
  const start = await fetchForCrawl(startKey, { ...fetchOpts, isSite: () => true })
  if (start.error) return notChecked(values.json, input, `the start URL did not answer: ${start.error}`)
  if (start.blocked) return notChecked(values.json, input, `the start URL answered this tool and a browser user agent with a bot-protection wall (${start.blocked}), so nothing was crawled. That says nothing about what Googlebot receives.`)
  if (start.redirectError) return notChecked(values.json, input, `the start URL ${start.redirectError}`)
  const startFinal = crawlKey(start.finalUrl)
  const finalHost = new URL(startFinal).host
  if (!siteHosts.has(finalHost)) {
    siteHosts.add(finalHost)
    robots = await readRobots(new URL(startFinal).origin, timeoutMs)
    if (!allowed(startFinal)) return notChecked(values.json, input, `the start URL redirects to ${startFinal}, which robots.txt on that host disallows for this tool (or its robots.txt could not be read), so nothing was crawled`)
  }
  if (start.chain.length) add('info', 'start-redirect', `the start URL redirected (${start.chain.map((h) => h.status).join(' > ')}) to ${startFinal}; the crawl covers ${[...siteHosts].join(' and ')}`)
  if (robots.sem.state !== 'ok' && !ignoreRobots) add('info', 'robots', robots.sem.note ?? `robots.txt answered ${robots.status}`)
  if (ignoreRobots) add('info', 'robots', '--ignore-robots: robots.txt rules were not applied')
  let perRequestDelay = 0
  if (!ignoreRobots && robots.crawlDelay !== undefined && robots.crawlDelay > 0) {
    perRequestDelay = Math.min(robots.crawlDelay, MAX_CRAWL_DELAY_S) * 1000
    concurrency = 1
    add('info', 'crawl-delay', `robots.txt sets Crawl-delay: ${robots.crawlDelay} for this tool's group; honoured as one request every ${perRequestDelay / 1000} s${robots.crawlDelay > MAX_CRAWL_DELAY_S ? ` (capped at ${MAX_CRAWL_DELAY_S} s)` : ''}`)
  }

  // ---- sitemaps -------------------------------------------------------------------------------
  let sitemapSources = []
  let sitemapDiscovery
  if (values.sitemap) {
    sitemapSources = [values.sitemap]
    sitemapDiscovery = 'given with --sitemap'
  } else if (robots.robots?.sitemaps.length) {
    sitemapSources = robots.robots.sitemaps.map((s) => crawlKey(s, robots.finalUrl)).filter(Boolean)
    sitemapDiscovery = `robots.txt lists ${sitemapSources.length}`
  } else {
    sitemapSources = [`${new URL(startFinal).origin}/sitemap.xml`]
    sitemapDiscovery = 'robots.txt lists none; tried /sitemap.xml'
  }
  const sm = await readSitemaps(sitemapSources, { timeoutMs, isSite })
  const sitemapRead = sm.read.some((s) => s.type === 'urlset' || s.type === 'text' || s.type === 'feed')
  for (const n of sm.notes) add('info', 'sitemap', `${n.source}: ${n.problem}`)

  // ---- the crawl ---------------------------------------------------------------------------------
  const pages = new Map()
  const inlinks = new Map()
  const fragments = new Map()
  const edges = new Map()
  const seen = new Set()
  const linkQueue = []
  const seedQueue = []
  const robotsBlocked = new Map()
  let fetched = 0
  let linkCrawlComplete = false
  let externalLinks = 0
  const addTo = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(value)
  }
  const enqueue = (k, queue) => {
    if (seen.has(k)) return
    seen.add(k)
    queue.push(k)
  }

  const record = (key, r) => {
    const finalKey = r.finalUrl ? crawlKey(r.finalUrl) : key
    const rec = { key, status: r.status ?? null, chain: r.chain ?? [], finalKey, offsite: Boolean(r.offsite), redirectError: r.redirectError ?? null, blocked: r.blocked ?? null, browserOnly: Boolean(r.browserOnly), error: r.error ?? null, facts: null, truncated: Boolean(r.truncated) }
    pages.set(key, rec)
    if (rec.chain.length && finalKey && finalKey !== key) addTo(edges, key, finalKey)
    if (!r.text || r.status !== 200 || r.blocked) return
    // The page reached is recorded under its own URL; a redirecting URL keeps only its chain.
    let target = rec
    if (finalKey !== key) {
      if (pages.has(finalKey)) return
      seen.add(finalKey)
      target = { ...rec, key: finalKey, chain: [], finalKey, redirectError: null }
      pages.set(finalKey, target)
    }
    target.facts = extractPage(r.text, r.finalUrl, r.headers)
    for (const link of target.facts.links) {
      if (!isSite(link.url)) {
        externalLinks++
        continue
      }
      if (link.url !== target.key) addTo(inlinks, link.url, target.key)
      addTo(edges, target.key, link.url)
      if (link.fragment) {
        if (!fragments.has(link.url)) fragments.set(link.url, new Map())
        addTo(fragments.get(link.url), link.fragment, target.key)
      }
      enqueue(link.url, linkQueue)
    }
    // Links are kept as graph edges; the per-page list is not needed again.
    target.facts.links = target.facts.links.length
  }

  seen.add(startKey)
  record(startKey, start)
  fetched = 1
  if (startFinal !== startKey) seen.add(startFinal)

  const seedIter = sm.keys.values()
  // Links first, breadth-first. Sitemap URLs no link led to are fetched only
  // once no fetch is in flight and the link queue is empty, because a fetch in
  // flight can still add links.
  const nextItem = (active) => {
    while (linkQueue.length) {
      const k = linkQueue.shift()
      if (pages.has(k)) continue
      if (!allowed(k)) {
        robotsBlocked.set(k, true)
        continue
      }
      return k
    }
    if (active > 0 && !linkCrawlComplete) return null
    linkCrawlComplete = true
    for (const k of seedIter) {
      if (seen.has(k)) continue
      seen.add(k)
      if (!allowed(k)) {
        robotsBlocked.set(k, true)
        continue
      }
      seedQueue.push(k)
      break
    }
    return seedQueue.shift() ?? null
  }

  await new Promise((resolve) => {
    let active = 0
    const pump = () => {
      while (active < concurrency && fetched < max) {
        const k = nextItem(active)
        if (!k) break
        active++
        fetched++
        ;(async () => {
          if (perRequestDelay) await sleep(perRequestDelay)
          const r = await fetchForCrawl(k, fetchOpts)
          if (!pages.has(k)) record(k, r)
        })().finally(() => {
          active--
          pump()
        })
      }
      if (active === 0) resolve()
    }
    pump()
  })

  // Anything linked or listed but never fetched.
  const unfetched = [...seen].filter((k) => !pages.has(k) && !robotsBlocked.has(k))
  const sitemapLeft = [...sm.keys].filter((k) => !seen.has(k)).length
  const capped = fetched >= max && (unfetched.length > 0 || sitemapLeft > 0 || linkQueue.length > 0)
  if (!capped) linkCrawlComplete = true

  const state = { pages, inlinks, fragments, edges, startKeys: [startKey, startFinal], sitemap: sm.keys, sitemapRead, sitemapComplete: sm.complete, capped, linkCrawlComplete, max }
  findings.push(...analyseCrawl(state))

  // Sitemap URLs the crawl happened to fetch that are not a plain 200.
  if (sitemapRead) {
    const bad = [...pages.values()].filter((p) => sm.keys.has(p.key) && !p.blocked && !p.error && (p.chain.length || (p.status && p.status !== 200)))
    if (bad.length) {
      const list = bad.map((p) => `${p.key} (${p.chain.length ? `redirects to ${p.finalKey}` : `HTTP ${p.status}`})`)
      findings.push({ level: 'warn', rule: 'sitemap-url-status', message: `${bad.length} sitemap URL(s) fetched in this crawl are not a plain 200: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. check-sitemap.mjs checks every sitemap URL.`, affects: bad.length, urls: bad.map((p) => p.key) })
    }
  }

  // ---- what was not checked -------------------------------------------------------------------------
  const linkedUnfetched = unfetched.filter((k) => inlinks.has(k))
  if (capped) add('not-checked', 'capped', `the crawl stopped at --max ${max}: ${unfetched.length} linked URL(s)${sitemapLeft ? ` and ${sitemapLeft} further sitemap URL(s)` : ''} were not fetched, so their status, fields and links were not checked. Raise --max for a fuller crawl.`, unfetched.length + sitemapLeft)
  else if (linkedUnfetched.length) add('not-checked', 'unfetched', `${linkedUnfetched.length} linked URL(s) were not fetched`, linkedUnfetched.length)
  const walled = [...pages.values()].filter((p) => p.blocked)
  if (walled.length) add('not-checked', 'blocked', `${walled.length} URL(s) answered with a bot-protection wall or kept rate limiting, to a browser user agent too; not evidence either way: ${walled.slice(0, 5).map((p) => p.key).join(', ')}`, walled.length)
  const failed = [...pages.values()].filter((p) => p.error)
  if (failed.length) add('not-checked', 'unreachable', `${failed.length} URL(s) did not answer after one retry: ${failed.slice(0, 5).map((p) => `${p.key} (${p.error})`).join(', ')}`, failed.length)
  const browserOnly = [...pages.values()].filter((p) => p.browserOnly)
  if (browserOnly.length) add('warn', 'bot-wall', `${browserOnly.length} URL(s) refused this tool's user agent but served a browser, e.g. ${browserOnly[0].key}; they were read from the browser's copy. Run check-crawlers.mjs --live to see what crawlers get.`, browserOnly.length)
  if (robotsBlocked.size) {
    const keys = [...robotsBlocked.keys()]
    add('info', 'robots-blocked', `${keys.length} internal URL(s) are disallowed by robots.txt for this tool and were not fetched, e.g. ${keys.slice(0, 3).join(', ')}`, keys.length)
  }
  const truncated = [...pages.values()].filter((p) => p.truncated)
  if (truncated.length) add('warn', 'page-size', `${truncated.length} page(s) are over 5 MB of HTML and were read only to that point, e.g. ${truncated[0].key}. Googlebot indexes the first 2 MB.`, truncated.length)
  if (externalLinks) add('info', 'external-links', `${externalLinks} link(s) to other hosts were not followed or checked`)

  const { dist, unreached } = depthDistribution(state)
  const htmlCount = [...pages.values()].filter((p) => p.status === 200 && p.facts).length
  const redirects = [...pages.values()].filter((p) => p.chain.length).length
  const errors = [...pages.values()].filter((p) => p.status >= 400 && !p.blocked).length

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.affects ?? 0) - (a.affects ?? 0))

  if (values.json) {
    const depth = clickDepths(state.startKeys, edges)
    console.log(JSON.stringify({
      tool: 'crawl-site', version: VERSION, input, checked: true, start: startKey, hosts: [...siteHosts],
      robots: { status: robots.status, state: robots.sem.state, crawlDelay: robots.crawlDelay ?? null, ignored: ignoreRobots },
      sitemap: { discovery: sitemapDiscovery, read: sm.read, urls: sm.keys.size, complete: sm.complete },
      max, fetched, capped, linkCrawlComplete,
      counts: { html: htmlCount, redirects, errors, blocked: walled.length, unreachable: failed.length, robotsBlocked: robotsBlocked.size, unfetched: unfetched.length + sitemapLeft },
      depth: { distribution: dist, unreachedFromStart: unreached },
      pages: [...pages.values()].map((p) => ({
        url: p.key, status: p.status, redirectsTo: p.chain.length ? p.finalKey : null, depth: depth.get(p.key) ?? null,
        inlinks: inlinks.get(p.key)?.size ?? 0, inSitemap: sm.keys.has(p.key),
        title: p.facts?.title ?? null, description: p.facts?.description ?? null, h1: p.facts?.h1Count ?? null,
        canonical: p.facts?.canonical ?? null, noindex: p.facts?.noindex ?? null, blocked: p.blocked, error: p.error,
      })),
      findings, summary: summaryLine(findings),
    }, null, 2))
    return exitFor(findings)
  }

  const lines = [`crawl-site  ${startKey}  (${fetched} URL(s) fetched${capped ? `, stopped at --max ${max}` : ', every internal link followed'})`, '']
  lines.push(`  robots.txt   ${robots.status === null ? 'no answer' : `HTTP ${robots.status}`}${ignoreRobots ? ', ignored' : `, rules for * applied${robots.crawlDelay ? `, Crawl-delay ${robots.crawlDelay}` : ''}`}`)
  lines.push(`  sitemap      ${sitemapDiscovery}; ${sm.read.length ? `${sm.read.length} file(s) read, ${sm.keys.size} URL(s) on this site${sm.complete ? '' : ', read in part'}` : 'none read'}`)
  lines.push(`  fetched      ${htmlCount} HTML page(s) at 200, ${redirects} redirect(s), ${errors} at 4xx or 5xx, ${walled.length} blocked, ${failed.length} unreachable`)
  const distText = Object.keys(dist).sort((a, b) => a - b).map((d) => `${d}: ${dist[d]}`).join('  ')
  lines.push(`  click depth  ${distText || 'none'}${unreached ? `  (not reachable by links from the start: ${unreached})` : ''}`, '')
  const perRule = new Map()
  for (const f of findings) {
    const key = `${f.level} ${f.rule}`
    const n = (perRule.get(key) ?? 0) + 1
    perRule.set(key, n)
    if (n <= PER_RULE) lines.push(formatFinding(f))
  }
  for (const [key, n] of perRule) if (n > PER_RULE) lines.push(`  ... and ${n - PER_RULE} more ${key.split(' ')[1]} finding(s) at ${key.split(' ')[0]} level (use --json for all)`)
  lines.push('', `  ${summaryLine(findings)}`)
  lines.push('  Findings are ranked by how many URLs each touches. Check each against the live HTML before acting on it.', '')
  console.log(lines.join('\n'))
  return exitFor(findings)
}

await runMain(main, HELP)
