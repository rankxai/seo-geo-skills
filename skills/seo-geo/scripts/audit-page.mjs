#!/usr/bin/env node
/**
 * audit-page.mjs: the mechanical on-page checks for one page, read the way a
 * crawler that does not run JavaScript reads it.
 *
 *   node skills/seo-geo/scripts/audit-page.mjs https://example.com/pricing
 *   node skills/seo-geo/scripts/audit-page.mjs saved-page.html --url https://example.com/pricing
 *   curl -s https://example.com/ | node skills/seo-geo/scripts/audit-page.mjs -
 *
 * What it checks, and the evidence for each rule:
 *
 *   server-text        Visible text in the raw HTML. GPTBot, ClaudeBot and
 *                      PerplexityBot do not execute JavaScript (each vendor's
 *                      crawler documentation), so text that appears only after
 *                      scripts run does not exist for them. Error under 500
 *                      characters.
 *   html-size          Googlebot indexes the first 2 MB of an HTML file,
 *                      measured uncompressed (Google's Googlebot page, updated
 *                      3 Feb 2026). Warn over 1 MB, error over 2 MB.
 *   one-h1, heading-levels, main-landmark, html-lang
 *                      Document structure for screen readers and for passage
 *                      extraction. Google says several h1s are fine for ranking,
 *                      so these warn and never fail.
 *   title, meta-description
 *                      Presence and rough length. Google truncates titles by
 *                      pixel width (about 60 characters) and rewrites most
 *                      descriptions, so length only warns.
 *   canonical          Exactly one, in the head, absolute, and pointing at this
 *                      URL when a URL is known. Google ignores canonicals in the
 *                      body and may ignore conflicting ones altogether.
 *   robots-meta, x-robots-tag
 *                      noindex is an error. nosnippet and max-snippet:0 warn,
 *                      because Google applies them to AI Overviews and AI Mode
 *                      too. The header is only visible when a URL is fetched.
 *   og-image           Open Graph image present and absolute, for link previews.
 *   img-alt, img-dimensions, lcp-lazy
 *                      Missing alt text; missing width and height (layout shift);
 *                      and the first image lazy-loaded, which delays Largest
 *                      Contentful Paint when that image is the hero (web.dev).
 *   json-ld-*          Every block parses, the @type list, placeholder values,
 *                      and types that no longer earn a Google rich result
 *                      (HowTo, SpecialAnnouncement, OccupationAggregationByEmployer
 *                      warn; FAQPage is information, retired 7 May 2026).
 *   invisible-chars    Zero-width, bidirectional and Unicode tag characters,
 *                      which have no legitimate use in published copy.
 *   answer-first       Information only: the first paragraph's length and
 *                      whether it opens with a direct statement.
 *   myth:*             Claims from data/myths.json that are known to be wrong,
 *                      found in the visible text. Warnings, because quoting a
 *                      claim to correct it is legitimate.
 *
 * What it does not check: whether the content is worth citing, whether the
 * answer is really at the top, whether the page says anything new. Those need
 * judgement and matter more.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { BROWSER_UA, EXIT, UsageError, botWall, exitFor, formatFinding, intOption, parseCli, readInput, runMain, summaryLine, VERSION } from './lib/cli.mjs'
import { auditHtml } from './lib/audit.mjs'

const HELP = `usage: node audit-page.mjs <url | file.html | -> [options]

Checks one page: server-rendered text, headings, title and description,
canonical, robots directives, Open Graph image, images, JSON-LD, the 2 MB
Googlebot limit, invisible characters, the opening paragraph and known myths.

options:
  --url <url>       the page's real URL, when auditing a file or stdin
                    (enables the self-canonical check)
  --user-agent <ua> send this user agent instead of the tool's own; "browser"
                    and "googlebot" are shorthands (a site that verifies
                    Googlebot by IP will still treat you as a visitor)
  --timeout <ms>    fetch timeout in milliseconds (default 30000)
  --json            machine-readable output
  -h, --help        this text

When the server answers the tool with a bot-protection wall (a 403 or 429, a
Cloudflare or AWS WAF challenge, a 202 interstitial), the page is fetched once
more as a browser. If that is refused too, the result is NOT CHECKED: a wall
is not the page, and auditing it would report the wall's defects as the site's.

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }
const UA_ALIASES = { browser: BROWSER_UA, googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }

/** Googlebot's limit is 2 MB; read a little past it so "over the limit" is measured, then stop. */
const READ_CAP = 5 * 1024 * 1024

function notChecked(json, input, reason, extra = {}) {
  if (json) console.log(JSON.stringify({ tool: 'audit-page', version: VERSION, input, checked: false, reason, ...extra }, null, 2))
  else console.log(`audit-page  ${input}\n\n  NOT CHECKED  ${reason}\n`)
  return EXIT.UNCHECKED
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    url: { type: 'string' },
    timeout: { type: 'string' },
    'user-agent': { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length !== 1) throw new UsageError('give exactly one URL, file or - (stdin)')
  const timeoutMs = intOption(values.timeout, 'timeout', 30_000, 1)
  if (values.url && !/^https?:\/\//i.test(values.url)) throw new UsageError('--url must be an http(s) URL')
  const customUa = values['user-agent'] ? (UA_ALIASES[values['user-agent'].toLowerCase()] ?? values['user-agent']) : null

  const pre = []
  let input = await readInput(positionals[0], { timeoutMs, maxBytes: READ_CAP, ...(customUa ? { userAgent: customUa } : {}) })
  if (input.error && input.redirectLimit) {
    // A redirect loop is a finding, not a failure to check: nobody, crawler or person, reaches a page.
    const findings = [{ level: 'error', rule: 'redirect', message: `${input.url}: ${input.error}. Crawlers and visitors never reach a page. Chain: ${input.redirectChain.map((h) => `${h.status} ${h.url}`).join(' > ')}` }]
    if (values.json) console.log(JSON.stringify({ tool: 'audit-page', version: VERSION, input: positionals[0], checked: true, status: null, facts: { url: input.url, redirects: input.redirectChain }, findings, summary: summaryLine(findings) }, null, 2))
    else console.log([`audit-page  ${input.url}`, '', ...findings.map((f) => formatFinding(f)), '', `  ${summaryLine(findings)}`, ''].join('\n'))
    return EXIT.FINDINGS
  }
  if (input.error) return notChecked(values.json, positionals[0], `could not read the page: ${input.error}`)

  if (input.kind === 'url') {
    const wall = botWall(input.status, input.headers)
    if (wall) {
      if (customUa) return notChecked(values.json, positionals[0], `the server answered the user agent you gave with a bot-protection wall (${wall}), so the page was not read`, { status: input.status })
      const again = await readInput(positionals[0], { timeoutMs, maxBytes: READ_CAP, userAgent: BROWSER_UA })
      const wallAgain = again.error ? null : botWall(again.status, again.headers)
      if (again.error || wallAgain) {
        return notChecked(values.json, positionals[0], `the server answered this tool with a bot-protection wall (${wall}) and a browser user agent with ${again.error ?? (wallAgain === wall ? "the same" : wallAgain)}, so the page was not read. That says nothing about what Googlebot receives: check it with Search Console's URL Inspection.`, { status: input.status })
      }
      pre.push({ level: 'warn', rule: 'bot-wall', message: `the server answered this tool's user agent with a bot-protection wall (${wall}) but served a browser HTTP ${again.status}; these checks ran on the browser copy. Crawlers are judged by user agent and IP too: run check-crawlers.mjs --live to see which ones are turned away.` })
      input = again
    }
    const type = input.contentType ?? ''
    if (type && !/html|xml/i.test(type)) {
      return notChecked(values.json, positionals[0], `${input.finalUrl} is not an HTML page (Content-Type: ${type}, HTTP ${input.status})`, { status: input.status })
    }
  }

  const ctx = {
    source: input.kind,
    url: input.kind === 'url' ? input.url : values.url,
    finalUrl: input.kind === 'url' ? input.finalUrl : values.url,
    headers: input.headers,
    bytes: input.bytes,
    truncated: input.truncated,
  }
  const { findings, facts } = auditHtml(input.text, ctx)
  findings.unshift(...pre)
  facts.charset = input.charset ?? null

  if (input.kind === 'url') {
    if (input.status < 200 || input.status >= 300) {
      findings.unshift({ level: 'error', rule: 'http-status', message: `the page answered HTTP ${input.status}; search engines do not index a non-200 page` })
    } else if (input.status !== 200) {
      findings.unshift({ level: 'warn', rule: 'http-status', message: `the page answered HTTP ${input.status}, not 200; check what a crawler receives` })
    }
    if (input.redirected) {
      const chain = input.redirectChain
      facts.redirects = chain
      const hops = chain.map((h) => h.status).join(' > ')
      findings.unshift({ level: 'info', rule: 'redirect', message: `${input.url} redirected ${chain.length === 1 ? 'once' : `${chain.length} times`} (${hops}) to ${input.finalUrl}; the checks ran on the final URL. Link to the final URL directly.` })
    }
  }
  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level])

  if (values.json) {
    console.log(JSON.stringify({ tool: 'audit-page', version: VERSION, input: positionals[0], checked: true, status: input.status ?? null, facts, findings, summary: summaryLine(findings) }, null, 2))
  } else {
    const size = `${input.truncated ? 'over ' : ''}${input.bytes.toLocaleString('en-US')} bytes`
    const where = input.kind === 'url' ? `${input.finalUrl}  (HTTP ${input.status}, ${size})` : `${input.kind === 'file' ? input.path : 'stdin'}  (${size})`
    const lines = [`audit-page  ${where}`, '']
    if (facts.title) lines.push(`  title        ${facts.title}`)
    if (facts.canonical) lines.push(`  canonical    ${facts.canonical}`)
    if (facts.types?.length) lines.push(`  @types       ${facts.types.join(', ')}`)
    lines.push('')
    for (const f of findings) lines.push(formatFinding(f))
    lines.push('', `  ${summaryLine(findings)}`)
    lines.push('  A clean run means the mechanical rules pass. Whether the page deserves to be cited is a separate, human question.', '')
    console.log(lines.join('\n'))
  }
  return exitFor(findings)
}

await runMain(main, HELP)
