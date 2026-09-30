#!/usr/bin/env node
/**
 * check-sources.mjs: round-trip every external link in a draft and sort the
 * results into dead, alive and could-not-check.
 *
 *   node skills/content-review/scripts/check-sources.mjs draft.md
 *   node skills/content-review/scripts/check-sources.mjs page.html --json
 *
 * Why: round-trip verification is the cheapest step in a content review and
 * the one most likely to find a real defect. The usual failure is a URL
 * written from memory rather than fetched, which either does not exist or
 * says something different from the sentence it is attached to. This script
 * catches the first case; the second needs a person to read the page.
 *
 * What counts as dead, and why it is narrower than "not 200":
 *   dead           404 or 410. The page is gone. ERROR.
 *   alive          2xx, or 3xx that ends somewhere (redirects are followed).
 *   not checked    401, 403, 429, any 5xx, a timeout or a network error. This
 *                  is bot protection, rate limiting or a bad afternoon at the
 *                  origin, and many publishers serve exactly this to a script
 *                  while being alive in a browser. Never a pass and never a
 *                  failure: open those by hand.
 *
 * Method: HEAD first, because it costs the publisher almost nothing. Some
 * origins answer HEAD with 403, 404, 405 or 501 while serving GET correctly
 * (some large help-centre sites answer HEAD with 404 and GET with 200), and
 * some frameworks answer HEAD with 400 or 406, so those, and a HEAD that
 * fails outright, are retried once with GET. Retrying a
 * 404 is safe: a page that is really gone answers the GET with 404 too.
 * Four requests at a time, 25 seconds each.
 *
 * Exit codes: 0 no dead links, 1 dead links found, 2 usage error, 3 could
 * not check (the file could not be read, or no link could be checked at all).
 */

import { EXIT, USER_AGENT, UsageError, classifyArg, formatFinding, intOption, parseCli, pool, readInput, runMain, summaryLine, VERSION } from './shared/cli.mjs'
import { classifyStatus, detectFormat, externalUrls, parseDocument } from './lib/content.mjs'

const HELP = `usage: node check-sources.mjs <file.md | file.html | -> [options]

Fetches every external http(s) link in the draft. Dead means 404 or 410 only;
401, 403, 429, 5xx and timeouts are "not checked", never a pass.

options:
  --timeout <ms>      per-request timeout in milliseconds (default 25000)
  --concurrency <n>   parallel requests (default 4)
  --format <fmt>      markdown or html (default: from the extension or content)
  --json              machine-readable output
  -h, --help          this text

exit codes: 0 no dead links, 1 dead links, 2 usage error, 3 could not check`

/** HEAD answers that are worth a second try with GET. */
export const HEAD_REFUSED = new Set([0, 400, 403, 404, 405, 406, 501])

async function request(url, method, timeoutMs) {
  try {
    const res = await fetch(url, { method, redirect: 'follow', headers: { 'user-agent': USER_AGENT, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel().catch(() => {})
    return { status: res.status, finalUrl: res.url }
  } catch (error) {
    return { status: 0, error: error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error?.cause?.code || error?.message || String(error) }
  }
}

export async function probeSource(url, timeoutMs) {
  const head = await request(url, 'HEAD', timeoutMs)
  if (!HEAD_REFUSED.has(head.status)) return { ...head, method: 'HEAD' }
  const get = await request(url, 'GET', timeoutMs)
  return { ...get, method: 'GET' }
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    timeout: { type: 'string' },
    concurrency: { type: 'string' },
    format: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length !== 1) throw new UsageError('give exactly one file or - (stdin)')
  if (classifyArg(positionals[0], { allowBareHost: false }).kind === 'url') throw new UsageError('check-sources reads a draft file or stdin, not a URL')
  const timeoutMs = intOption(values.timeout, 'timeout', 25_000, 1)
  const concurrency = intOption(values.concurrency, 'concurrency', 4, 1)

  const input = await readInput(positionals[0], {}, { allowBareHost: false })
  if (input.error) {
    if (values.json) console.log(JSON.stringify({ tool: 'check-sources', version: VERSION, input: positionals[0], checked: false, reason: input.error }, null, 2))
    else console.log(`check-sources  ${positionals[0]}\n\n  NOT CHECKED  ${input.error}\n`)
    return EXIT.UNCHECKED
  }
  const format = values.format ? (values.format === 'html' ? 'html' : 'markdown') : detectFormat(input.path, input.text)
  const urls = externalUrls(parseDocument(input.text, format))

  const results = await pool(urls, concurrency, async (u) => {
    const r = await probeSource(u.url, timeoutMs)
    return { ...u, ...r, verdict: classifyStatus(r.status) }
  })

  const findings = []
  for (const r of results) {
    const via = `${r.method}${r.finalUrl && r.finalUrl !== r.url ? `, redirected to ${r.finalUrl}` : ''}`
    if (r.verdict === 'dead') findings.push({ level: 'error', rule: 'dead', message: `${r.url} answered ${r.status} (${via}). Find the page's new home or drop the claim.` })
    else if (r.verdict === 'unknown') findings.push({ level: 'not-checked', rule: 'could-not-check', message: `${r.url} ${r.status ? `answered ${r.status}` : `did not answer (${r.error})`}. Not evidence either way: open it in a browser.` })
    else findings.push({ level: 'info', rule: 'alive', message: `${r.url} ${r.status} (${via})` })
  }
  const counts = { alive: results.filter((r) => r.verdict === 'ok').length, dead: results.filter((r) => r.verdict === 'dead').length, unknown: results.filter((r) => r.verdict === 'unknown').length }

  if (values.json) {
    console.log(JSON.stringify({ tool: 'check-sources', version: VERSION, input: positionals[0], checked: true, counts, results, findings, summary: summaryLine(findings) }, null, 2))
  } else {
    const lines = [`check-sources  ${input.path ?? 'stdin'}  (${urls.length} external link(s))`, '']
    const order = { error: 0, 'not-checked': 1, info: 2 }
    for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) lines.push(formatFinding(f))
    if (!urls.length) lines.push('  no external links found')
    lines.push('', `  ${counts.dead} dead, ${counts.alive} alive, ${counts.unknown} could NOT be checked`)
    if (counts.alive) lines.push('  Alive is not the same as supporting the claim: open each source and check the sentence it is attached to.')
    lines.push('')
    console.log(lines.join('\n'))
  }
  if (counts.dead) return EXIT.FINDINGS
  if (urls.length && counts.unknown === urls.length) return EXIT.UNCHECKED
  return EXIT.CLEAN
}

await runMain(main, HELP)
