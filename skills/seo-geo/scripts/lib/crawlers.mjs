/**
 * The logic behind check-crawlers.mjs: robots.txt policy per AI crawler, the
 * optional live probe, and the verdict that combines the two.
 *
 * Two columns are kept apart on purpose:
 *   POLICY    what robots.txt asks, read per RFC 9309 (lib/robots.mjs).
 *   EVIDENCE  what a request carrying each crawler's user agent actually got,
 *             compared with two controls: a browser user agent and curl.
 * Policy is intent and the probe is evidence; neither is proof. A probe
 * sends the right user agent from the wrong IP address, so a site that
 * verifies crawlers by IP can block the probe and admit the real crawler.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BROWSER_UA, USER_AGENT, botWall, pool } from './cli.mjs'
import { fetchSemantics, nearMissAgents, policyFor } from './robots.mjs'

export const CRAWLERS_FILE = fileURLToPath(new URL('../../data/crawlers.json', import.meta.url))

export function loadRoster(file = CRAWLERS_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return data.bots.map((b) => ({ ...b, label: b.token ?? b.label ?? b.vendor }))
}

export const PURPOSE_ORDER = ['search', 'training', 'user-fetch', 'control-token']
export const PURPOSE_TITLES = {
  training: 'TRAINING (content may be used to train models)',
  search: 'SEARCH (indexes pages an AI product cites)',
  'user-fetch': 'USER-FETCH (fetches a page when a person asks)',
  'control-token': 'CONTROL TOKENS (robots.txt signals, no crawler)',
}

/** Crawlers whose vendor says Crawl-delay is not supported. */
const NO_CRAWL_DELAY = new Set(['applebot', 'amazonbot', 'amzn-searchbot'])

/**
 * The robots.txt POLICY for every roster bot at `path`, plus findings.
 * `status` is the robots.txt HTTP status (null for a network failure).
 */
export function analysePolicy({ robots, status, roster, path = '/', bytes = 0 }) {
  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  const sem = fetchSemantics(status)

  if (sem.state === 'unreachable') add('error', 'robots-unreachable', sem.note)
  else if (sem.state === 'unavailable') add('info', 'robots-missing', sem.note)

  // RFC 9309 section 2.5: crawlers SHOULD parse at least 500 KiB. Google
  // ignores everything after 500 KiB, so rules past that point do nothing.
  if (bytes > 500 * 1024) add('warn', 'robots-size', `robots.txt is ${(bytes / 1024).toFixed(0)} KiB; Google ignores everything after the first 500 KiB, so the rules past that point are not read here either`)

  const grouped = { training: [], userFetch: [], signal: [] }
  if (robots && sem.state === 'ok') {
    const tokens = roster.filter((b) => b.token).map((b) => b.token)
    const cased = (t) => tokens.find((x) => x.toLowerCase() === t) ?? t
    for (const miss of nearMissAgents(robots, tokens)) {
      add('warn', 'robots-near-miss', `"User-agent: ${miss.agent}" names no crawler on the roster. Matching is exact (RFC 9309 section 2.2.1), so it does not apply to ${miss.wouldMatch.map(cased).join(', ')}.`)
    }
    // Lines Google reads only because its parser forgives them. The verdicts
    // above follow Google; other crawlers may skip these lines entirely.
    for (const t of (robots.typos ?? []).slice(0, 10)) {
      add('warn', 'robots-typo', `line ${t.line} "${t.text}" (${t.why}): Google reads it as ${t.why === 'no colon' ? `"${t.reads}"` : `a ${t.reads} line`}, but RFC 9309 does not, and other crawlers may ignore it. Write the field name exactly, followed by a colon.`)
    }
    if ((robots.typos ?? []).length > 10) add('warn', 'robots-typo', `and ${robots.typos.length - 10} more misspelt or colon-less line(s)`)
    // A robots.txt Noindex rule stopped working in Google on 1 September 2019
    // (Google Search Central blog, 2 July 2019). Sites still rely on it.
    const dead = (robots.unknownFields ?? []).filter((f) => f === 'noindex' || f === 'nofollow')
    if (dead.length) add('warn', 'robots-noindex', `robots.txt uses ${dead.map((f) => `"${f[0].toUpperCase()}${f.slice(1)}:"`).join(' and ')}, which Google stopped supporting on 1 September 2019 and RFC 9309 never defined. Nothing is kept out of the index by it: use a noindex robots meta tag or X-Robots-Tag header on the pages themselves.`)
  }

  const rows = roster.map((bot) => {
    if (!bot.token) {
      return { ...pick(bot), allowed: null, via: 'no-token', matchedAgent: null, rule: null, note: bot.robotsNote }
    }
    const p = policyFor(robots, bot.token, { path, fallbackTokens: bot.fallback?.tokens ?? [], status })
    const row = { ...pick(bot), allowed: p.allowed, via: p.via, matchedAgent: p.matchedAgent, rule: p.rule, crawlDelay: p.crawlDelay }

    const where = describeVia(p)
    if (!p.allowed && sem.state === 'ok') {
      if (bot.purpose === 'search') {
        add(bot.token === 'Googlebot' ? 'error' : 'warn', 'search-bot-blocked', `${bot.token} is disallowed from ${path} (${where}). ${bot.purposeLine}`)
      } else if (bot.purpose === 'control-token') {
        add('info', 'control-token-set', `${bot.token} is disallowed (${where}). ${bot.robotsNote ?? bot.purposeLine}`)
      } else if (bot.purpose === 'user-fetch' && bot.robots === 'may-ignore') {
        grouped.signal.push(bot.token)
      } else if (bot.purpose === 'user-fetch') {
        grouped.userFetch.push(bot.token)
      } else {
        grouped.training.push(bot.token)
      }
    }
    if (p.via === 'fallback') {
      add('info', 'fallback-group', `${bot.token} has no group of its own and follows the ${p.matchedAgent} group. ${bot.fallback?.note ?? ''}`.trim())
    }
    if (p.crawlDelay !== undefined && NO_CRAWL_DELAY.has(bot.token.toLowerCase())) {
      add('info', 'crawl-delay-ignored', `the group for ${bot.token} sets Crawl-delay: ${p.crawlDelay}, which ${bot.vendor} says it does not support`)
    }
    return row
  })
  if (grouped.training.length) {
    add('info', 'training-bots-blocked', `${grouped.training.length} training crawler(s) disallowed from ${path}: ${grouped.training.join(', ')}. Opting out of training is a choice, not a fault, and does not remove the site from those vendors' search bots.`)
  }
  if (grouped.userFetch.length) {
    add('info', 'user-fetch-blocked', `${grouped.userFetch.join(', ')} disallowed from ${path}. Their vendors say they obey robots.txt even when a person asks, so those assistants cannot read this page on request.`)
  }
  if (grouped.signal.length) {
    add('info', 'user-fetch-blocked', `${grouped.signal.join(', ')} disallowed from ${path}, but their vendors say robots.txt may not apply to user-requested fetches, so this is a request, not a control.`)
  }
  return { rows, findings, fetchState: sem.state }
}

function pick(bot) {
  return { label: bot.label, token: bot.token, vendor: bot.vendor, purpose: bot.purpose, compliance: bot.robots, robotsNote: bot.robotsNote ?? null, docsUrl: bot.docsUrl, hasUa: Boolean(bot.ua) }
}

export function describeVia(p) {
  if (p.via === 'own') return `its own group${p.rule ? `, rule "${p.rule.type}: ${p.rule.pattern}"` : ''}`
  if (p.via === 'fallback') return `the ${p.matchedAgent} group, by the vendor's documented fallback${p.rule ? `, rule "${p.rule.type}: ${p.rule.pattern}"` : ''}`
  if (p.via === 'star') return `the * group${p.rule ? `, rule "${p.rule.type}: ${p.rule.pattern}"` : ''}`
  if (p.via === 'none') return 'no group applies'
  return 'robots.txt fetch state'
}

/* ---- live probe ------------------------------------------------------------ */

export { BROWSER_UA }
export const CURL_UA = 'curl/8.9.1'

/**
 * Classify one probe response. 402 is how pay-per-crawl edges answer, and a
 * challenge header (Cloudflare's cf-mitigated, AWS WAF's x-amzn-waf-action,
 * Vercel's x-vercel-mitigated, HUMAN's x-px-blocked) marks a challenge page
 * served with any status. Neither is the origin's content.
 *
 * 429 is its own signal, not a block: twenty-odd probes in a few seconds is
 * exactly what a rate limiter is for, and reading the limiter's 429 as "this
 * crawler is refused" blamed whichever bots happened to be probed last.
 */
export function classifyProbe(status, challenged) {
  if (status === null) return 'unreachable'
  if (challenged) return 'challenge'
  if (status >= 200 && status < 300) return status === 202 ? 'challenge' : 'ok'
  if (status === 402) return 'payment-required'
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404 || status === 410) return 'not-found'
  if (status >= 500) return 'server-error'
  if (status >= 300 && status < 400) return 'redirect'
  return 'forbidden'
}

export const isBlocked = (signal) => signal === 'forbidden' || signal === 'payment-required' || signal === 'challenge'

/** A header-only challenge signal (the status is judged separately). */
function challengeHeader(headers) {
  const wall = botWall(200, headers)
  return Boolean(wall)
}

export async function probe(url, userAgent, timeoutMs = 15_000) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.body?.cancel().catch(() => {})
    const cfMitigated = (res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge'
    const challenged = cfMitigated || challengeHeader(res.headers)
    return { status: res.status, signal: classifyProbe(res.status, challenged), server: res.headers.get('server'), cfMitigated }
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error?.cause?.code || error?.message || String(error)
    return { status: null, signal: 'unreachable', server: null, cfMitigated: false, error: reason }
  }
}

/**
 * Fetch `url` as a browser and as curl first, then as every roster bot with a
 * user agent. When the browser itself is refused or unreachable, the bot
 * probes are skipped: no bot result could be told apart from a block on
 * everyone, and a site that tarpits unknown clients would otherwise hold the
 * run for a full timeout per bot (measured: 91 seconds on one large
 * marketplace, for no evidence at all).
 */
export async function probeAll(url, roster, { timeoutMs = 15_000, concurrency = 4 } = {}) {
  const [browser, curl] = await Promise.all([probe(url, BROWSER_UA, timeoutMs), probe(url, CURL_UA, timeoutMs)])
  const bots = new Map([['browser', browser], ['curl', curl]])
  if (browser.signal !== 'ok') return { browser, curl, bots, skipped: true }
  const uas = roster.filter((b) => b.ua).map((b) => ({ key: b.token, ua: b.ua }))
  const results = await pool(uas, concurrency, (u) => probe(url, u.ua, timeoutMs))
  uas.forEach((u, i) => bots.set(u.key, results[i]))
  return { browser, curl, bots, skipped: false }
}

/**
 * The combined verdict for one bot:
 *   open            policy allows and the probe reached the page
 *   edge-blocked    policy allows but the server or CDN turns this user agent away
 *   edge-error      the page answered this user agent with a 404 or 5xx while a
 *                   browser got it (a firewall that disguises its block, or an
 *                   origin that errors for unknown clients)
 *   robots-blocked  policy disallows, the probe got through (compliant bots stay away)
 *   blocked         policy disallows and the edge blocks too
 *   bot-protection  curl is blocked as well, so this is generic bot protection
 *   signal-only     a user-triggered fetcher that may ignore robots.txt
 *   policy-only     a control token: nothing to probe
 *   unverifiable    no documented token
 *   unknown         the probe could not tell (no answer, rate limited, or the
 *                   browser control was refused too)
 */
export function verdictFor(row, evidence, controls) {
  if (!row.token) return 'unverifiable'
  if (row.purpose === 'control-token') return 'policy-only'
  if (!evidence || evidence.signal === 'unreachable' || evidence.signal === 'rate-limited') return 'unknown'
  const signalOnly = row.purpose === 'user-fetch' && row.compliance === 'may-ignore'
  if (isBlocked(evidence.signal)) {
    if (controls.browser.signal !== 'ok') return 'unknown'
    if (isBlocked(controls.curl.signal)) return 'bot-protection'
    return row.allowed === false && !signalOnly ? 'blocked' : 'edge-blocked'
  }
  if ((evidence.signal === 'not-found' || evidence.signal === 'server-error') && controls.browser.signal === 'ok') {
    return row.allowed === false && !signalOnly ? 'blocked' : 'edge-error'
  }
  if (signalOnly) return 'signal-only'
  if (row.allowed === false) return 'robots-blocked'
  return 'open'
}

/**
 * Search crawlers whose edge block is an ERROR: the ones behind Google, Bing
 * (and the answers built on its index), Apple, ChatGPT search, Claude and
 * Perplexity. For any other search crawler an edge block WARNS: turning away
 * a smaller engine at the CDN is often deliberate even when robots.txt was
 * never updated to match (seen in the panel: a Japanese ISP refusing
 * Bytespider, a publisher refusing meta-webindexer).
 */
const MAJOR_SEARCH = new Set(['Googlebot', 'Bingbot', 'Applebot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'])

/** Findings from the live probe, given rows that already carry `verdict`. */
export function liveFindings(rows, controls) {
  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  if (controls.browser.signal === 'unreachable' && controls.curl.signal === 'unreachable') {
    add('not-checked', 'live', `the page did not answer the browser or curl probe (${controls.browser.error ?? 'no response'}), so no per-bot evidence was collected`)
    return findings
  }
  if (controls.browser.signal !== 'ok') {
    add('not-checked', 'live', `the page answered a browser user agent with ${controls.browser.status ?? 'no response'} (${controls.browser.signal}), so a block on a bot cannot be told apart from a block on everyone; the crawler probes were skipped`)
    return findings
  }
  const probed = rows.filter((r) => r.evidence)
  if (isBlocked(controls.curl.signal) && probed.length && probed.every((r) => isBlocked(r.evidence.signal))) {
    add('warn', 'bot-protection', `curl and every crawler user agent were blocked while a browser got ${controls.browser.status}. This is generic bot protection; it cannot say which crawlers the site means to allow. Check the CDN's bot settings and its verified-bot allowlist.`)
  }
  const limited = rows.filter((r) => r.evidence?.signal === 'rate-limited').map((r) => r.token)
  if (limited.length) add('not-checked', 'live', `${limited.join(', ')} got HTTP 429 (rate limited): the probes themselves tripped a limiter, so nothing is concluded for ${limited.length === 1 ? 'it' : 'them'}. Re-run later.`)
  for (const r of rows) {
    const s = r.evidence ? `${r.evidence.status ?? 'no response'} ${r.evidence.signal}` : ''
    if (r.verdict === 'edge-blocked') {
      add(r.purpose === 'search' && MAJOR_SEARCH.has(r.token) ? 'error' : 'warn', 'edge-blocked', `${r.token}: robots.txt ${r.allowed === false ? 'disallows it' : 'allows it'}, but the server answered its user agent with ${s} while a browser got ${controls.browser.status}${r.evidence?.server ? ` (server: ${r.evidence.server})` : ''}. A CDN or firewall rule is overriding robots.txt.`)
    } else if (r.verdict === 'edge-error') {
      add('warn', 'edge-error', `${r.token}: robots.txt allows it, but the page answered its user agent with ${s} while a browser got ${controls.browser.status}. Either a firewall disguises its block as an error, or the origin fails for this client; re-run once before acting on it.`)
    } else if (r.verdict === 'robots-blocked') {
      add('info', 'robots-not-enforced', `${r.token}: robots.txt disallows it and the server still served the page (${s}); compliant crawlers stay away regardless`)
    }
  }
  add('info', 'probe-caveat', 'probes send each crawler\'s user agent from this machine\'s IP. Sites that verify crawlers by IP or reverse DNS can treat a probe differently from the real crawler.')
  return findings
}
