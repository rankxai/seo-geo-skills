#!/usr/bin/env node
/**
 * check-crawlers.mjs: which AI crawlers a site's robots.txt lets in, read the
 * way RFC 9309 says, and (with --live) which ones its server or CDN actually
 * lets through.
 *
 *   node skills/seo-geo/scripts/check-crawlers.mjs https://example.com
 *   node skills/seo-geo/scripts/check-crawlers.mjs https://example.com --live
 *   node skills/seo-geo/scripts/check-crawlers.mjs robots.txt
 *   curl -s https://example.com/robots.txt | node skills/seo-geo/scripts/check-crawlers.mjs -
 *
 * What it checks, and why:
 *
 *   Policy per crawler   For every bot in data/crawlers.json, whether robots.txt
 *                        allows it at the path (default /), which group decided,
 *                        and the rule. Grouped by purpose, because blocking a
 *                        training crawler and blocking a search crawler are
 *                        different decisions with different costs.
 *   RFC 9309 selection   Exact, case-insensitive product-token match (section
 *                        2.2.1); a named group replaces *; matching groups merge;
 *                        longest rule wins and Allow wins a tie (section 2.2.2).
 *                        A "Google" group does not govern Google-Extended.
 *   Vendor fallbacks     Applebot follows the Googlebot group when no group names
 *                        it (Apple's documentation). Amzn-SearchBot follows the
 *                        rules "given to other search bots" (Amazon's
 *                        documentation), read here as Googlebot, then Bingbot.
 *   Fetch semantics      4xx means no rules (allow all); 5xx, 429 or no answer
 *                        means crawlers must assume complete disallow (RFC 9309
 *                        section 2.3.1; Google for 429). The second is an error.
 *   Near misses          A User-agent value such as "Claude" that looks like a
 *                        crawler name but matches nothing, because matching is
 *                        exact.
 *   --live               Fetches the homepage as a browser, as curl, and as each
 *                        crawler with a documented user agent, and reports edge
 *                        blocks (the crawler refused while a browser is served)
 *                        separately from robots.txt policy. When curl is refused
 *                        too, it reports generic bot protection instead of
 *                        blaming each crawler. A search crawler blocked at the
 *                        edge is an error; others warn.
 *   llms.txt             When given a site, fetches /llms.txt and checks it
 *                        against the format at llmstxt.org. A missing file is
 *                        never a fault: no major AI search engine documents
 *                        reading it, and Google says it has no effect on Search.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { BROWSER_UA, EXIT, UsageError, botWall, classifyArg, exitFor, fetchPage, formatFinding, intOption, parseCli, readInput, runMain, summaryLine, VERSION } from './lib/cli.mjs'
import { parseRobots } from './lib/robots.mjs'
import { PURPOSE_ORDER, PURPOSE_TITLES, analysePolicy, describeVia, liveFindings, loadRoster, probeAll, verdictFor } from './lib/crawlers.mjs'
import { looksLikeHtml, validateLlmsTxt } from './lib/llms-txt.mjs'

const HELP = `usage: node check-crawlers.mjs <site URL | robots.txt file | -> [options]

Reads robots.txt for every AI crawler in data/crawlers.json, per RFC 9309,
grouped by purpose (search, training, user-fetch, control tokens).

options:
  --live            also fetch the homepage as a browser, as curl and as each
                    crawler, and report CDN or firewall blocks (site URL only)
  --path <path>     the path to evaluate (default /)
  --timeout <ms>    per-request timeout in milliseconds (default 15000)
  --json            machine-readable output
  -h, --help        this text

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }

/**
 * Google reads the first 500 KiB of a robots.txt and ignores the rest
 * ("Content which is after the maximum file size is ignored"), and RFC 9309
 * section 2.5 sets the same floor. Rules past that point are therefore not
 * rules, and a verdict built from them would be wrong for Googlebot.
 */
const ROBOTS_READ_BYTES = 500 * 1024

const robotsBody = (buffer) => buffer.subarray(0, ROBOTS_READ_BYTES).toString('utf8')

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    live: { type: 'boolean' },
    path: { type: 'string' },
    timeout: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length !== 1) throw new UsageError('give exactly one site URL, robots.txt file or - (stdin)')
  const timeoutMs = intOption(values.timeout, 'timeout', 15_000, 1)
  const path = values.path ?? '/'
  if (!path.startsWith('/')) throw new UsageError('--path must start with /')

  const arg = positionals[0]
  const kind = classifyArg(arg).kind
  if (values.live && kind !== 'url') throw new UsageError('--live needs a site URL, not a file')

  const roster = loadRoster()
  const findings = []
  let origin = null
  let robotsText = ''
  let status = 200
  let bytes = 0
  let robotsSource
  let statusLabel = null

  if (kind === 'url') {
    origin = new URL(classifyArg(arg).url).origin
    robotsSource = `${origin}/robots.txt`
    // RFC 9309 section 2.3.1.2: follow at least five redirects; past that a
    // crawler MAY treat the file as unavailable, and Google treats it as a 404.
    const opts = { timeoutMs, accept: 'text/plain,*/*;q=0.8', maxRedirects: 5, maxBytes: 2 * 1024 * 1024 }
    let res = await fetchPage(robotsSource, opts)
    if (res.error && res.redirectLimit) {
      status = 404
      statusLabel = 'redirect limit'
      findings.push({ level: 'warn', rule: 'robots-redirects', message: `robots.txt: ${res.error}. RFC 9309 lets a crawler treat a robots.txt it cannot reach within five redirects as unavailable, and Google treats it as a 404, so no rule in it applies to anyone. Chain: ${res.redirectChain.map((h) => `${h.status} ${h.url}`).join(' > ')}` })
    } else if (res.error) {
      const out = { tool: 'check-crawlers', version: VERSION, input: arg, checked: false, reason: `robots.txt did not answer: ${res.error}` }
      if (values.json) console.log(JSON.stringify(out, null, 2))
      else console.log(`check-crawlers  ${robotsSource}\n\n  NOT CHECKED  robots.txt did not answer: ${res.error}\n  (RFC 9309 treats an unreachable robots.txt as complete disallow, but a failure on this machine's side looks the same, so nothing is concluded.)\n`)
      return EXIT.UNCHECKED
    } else {
      // A bot wall, or a 5xx, may be what THIS tool gets rather than what a
      // crawler gets. Ask again as a browser before reading the status as the
      // site's policy: "403 = no rules" and "503 = crawl nothing" are both
      // strong conclusions to draw from a firewall's answer to a script.
      const wall = botWall(res.status, res.headers) ?? (res.status >= 500 ? `HTTP ${res.status}` : null)
      if (wall) {
        const again = await fetchPage(robotsSource, { ...opts, userAgent: BROWSER_UA })
        if (!again.error && again.status >= 200 && again.status < 300 && !botWall(again.status, again.headers)) {
          findings.push({ level: 'warn', rule: 'robots-wall', message: `robots.txt answered this tool with ${wall} but served a browser HTTP ${again.status}, so the policy below is read from the browser's copy. Crawlers may get either answer, and they mean opposite things: a 403 means "no rules" and a 5xx or 429 means "crawl nothing". Check what the CDN serves verified crawlers (Search Console's robots.txt report shows Google's copy).` })
          res = again
        } else if (botWall(res.status, res.headers)) {
          findings.push({ level: 'not-checked', rule: 'robots-wall', message: `robots.txt answered this tool and a browser with a bot-protection wall (${wall}). The verdicts below apply what RFC 9309 says HTTP ${res.status} means, but a crawler the CDN admits may be served a real file with real rules.` })
        }
      }
      if (res.redirected) findings.push({ level: 'info', rule: 'robots-redirect', message: `robots.txt redirected (${res.redirectChain.map((h) => h.status).join(' > ')}) to ${res.finalUrl}; crawlers follow up to five redirects and apply the rules they find there` })
      status = res.status
      bytes = res.bytes
      robotsText = status >= 200 && status < 300 ? robotsBody(res.buffer) : ''
      if (status >= 200 && status < 300 && looksLikeHtml(robotsText)) {
        findings.push({ level: 'warn', rule: 'robots-is-html', message: 'robots.txt answered 200 with an HTML page. Crawlers parse it as robots.txt, find no valid lines, and apply no rules.' })
      }
    }
  } else {
    const input = await readInput(arg)
    if (input.error) {
      if (values.json) console.log(JSON.stringify({ tool: 'check-crawlers', version: VERSION, input: arg, checked: false, reason: input.error }, null, 2))
      else console.log(`check-crawlers  ${arg}\n\n  NOT CHECKED  ${input.error}\n`)
      return EXIT.UNCHECKED
    }
    robotsText = robotsBody(input.buffer)
    bytes = input.bytes
    robotsSource = input.kind === 'file' ? input.path : 'stdin'
  }

  const robots = parseRobots(robotsText)
  const policy = analysePolicy({ robots, status, roster, path, bytes })
  findings.push(...policy.findings)
  const rows = policy.rows

  // ---- live probe -----------------------------------------------------------
  let controls = null
  if (values.live) {
    const pageUrl = `${origin}${path}`
    const probes = await probeAll(pageUrl, roster, { timeoutMs })
    controls = { browser: probes.browser, curl: probes.curl, botsSkipped: probes.skipped }
    for (const row of rows) {
      row.evidence = row.token && !probes.skipped ? (probes.bots.get(row.token) ?? null) : null
      row.verdict = verdictFor(row, row.evidence, controls)
    }
    findings.push(...liveFindings(rows, controls))
  } else if (kind === 'url') {
    findings.push({ level: 'not-checked', rule: 'live', message: 'edge and CDN blocks were not checked; add --live to fetch the page as each crawler' })
  }

  // ---- llms.txt ----------------------------------------------------------------
  let llms = null
  if (kind === 'url') {
    const res = await fetchPage(`${origin}/llms.txt`, { timeoutMs, accept: 'text/plain,text/markdown,*/*;q=0.8' })
    if (res.error) {
      llms = { state: 'not-checked', reason: res.error }
      findings.push({ level: 'not-checked', rule: 'llms-txt', message: `/llms.txt did not answer: ${res.error}` })
    } else if (res.status === 200 && !looksLikeHtml(res.text)) {
      const v = validateLlmsTxt(res.text)
      llms = { state: 'present', ...v }
      if (v.valid) findings.push({ level: 'info', rule: 'llms-txt', message: `/llms.txt present and well formed: "${v.h1}", ${v.sections.length} section(s), ${v.totalLinks} link(s). No major AI search engine documents reading it.` })
      for (const issue of v.issues.slice(0, 10)) findings.push({ level: 'warn', rule: `llms-txt:${issue.rule}`, message: `line ${issue.line}: ${issue.message}` })
      if (v.issues.length > 10) findings.push({ level: 'warn', rule: 'llms-txt', message: `and ${v.issues.length - 10} more format issue(s)` })
    } else if (res.status === 200) {
      llms = { state: 'html' }
      findings.push({ level: 'warn', rule: 'llms-txt', message: '/llms.txt answered 200 with an HTML page, probably a catch-all route. If you publish an llms.txt, serve it as text; if you do not, a 404 is more honest.' })
    } else {
      llms = { state: 'absent', status: res.status }
      findings.push({ level: 'info', rule: 'llms-txt', message: `no /llms.txt (HTTP ${res.status}). Not a fault: no major AI search engine documents using it, and Google says it neither helps nor hurts Search.` })
    }
  }

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level])

  if (values.json) {
    console.log(JSON.stringify({
      tool: 'check-crawlers', version: VERSION, input: arg, checked: true, robotsSource, robotsStatus: status, fetchState: policy.fetchState, path,
      groups: robots.groups.length, sitemaps: robots.sitemaps, controls, bots: rows, llmsTxt: llms, findings, summary: summaryLine(findings),
    }, null, 2))
    return exitFor(findings)
  }

  const lines = [`check-crawlers  ${robotsSource}  (${kind === 'url' ? `${statusLabel ?? `HTTP ${status}`}, ` : ''}${bytes.toLocaleString('en-US')} bytes, ${robots.groups.length} group(s), path ${path})`, '']
  for (const purpose of PURPOSE_ORDER) {
    lines.push(`  ${PURPOSE_TITLES[purpose]}`)
    for (const r of rows.filter((x) => x.purpose === purpose)) {
      const verdict = r.allowed === null ? 'no token' : r.allowed ? 'allowed' : 'DISALLOWED'
      const via = r.allowed === null ? (r.robotsNote ?? '') : describeVia(r)
      const live = r.verdict ? `  live: ${r.evidence ? `${r.evidence.status ?? '---'} ` : ''}${r.verdict}` : ''
      lines.push(`    ${r.label.padEnd(22)} ${verdict.padEnd(11)} ${via}${live}`)
    }
    lines.push('')
  }
  if (controls) {
    lines.push(`  LIVE CONTROLS  browser ${controls.browser.status ?? '---'} ${controls.browser.signal}, curl ${controls.curl.status ?? '---'} ${controls.curl.signal}`, '')
  }
  for (const f of findings) lines.push(formatFinding(f))
  lines.push('', `  ${summaryLine(findings)}`, '')
  console.log(lines.join('\n'))
  return exitFor(findings)
}

await runMain(main, HELP)
