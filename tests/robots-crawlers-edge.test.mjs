/**
 * robots.txt as Google's parser reads it, and the live crawler probe on sites
 * that rate-limit, challenge or tarpit. Each case is a finding from the
 * September 2026 panel.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - robots.mjs canonicalField(): the FIELD_TYPOS lookup removed. Caught by
 *     "Google's forgiven misspellings and colon-less lines are read, and
 *     reported".
 *   - robots.mjs matchLength(): replaced with the old regular-expression
 *     matcher. Caught by "a hostile wildcard pattern is matched in linear
 *     time" (the regex version takes minutes on that input).
 *   - crawlers.mjs classifyProbe(): `status === 429` returned 'forbidden'
 *     again. Caught by "a 429 is the probe tripping a rate limiter, not a
 *     block".
 *   - crawlers.mjs probeAll(): the early return when the browser is refused
 *     removed. Caught by "when a browser is refused, the crawler probes are
 *     skipped".
 *   - check-crawlers.mjs: robotsBody() read the whole buffer instead of the
 *     first 500 KiB. Caught by "rules past 500 KiB are not rules".
 *   - check-crawlers.mjs: the browser retry for a walled robots.txt removed.
 *     Caught by "a robots.txt refused to this tool is read from a browser's
 *     copy, with a warning".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isPathAllowed, matchLength, parseRobots, policyFor } from '../skills/seo-geo/scripts/lib/robots.mjs'
import { classifyProbe, liveFindings, probeAll, verdictFor } from '../skills/seo-geo/scripts/lib/crawlers.mjs'
import { validateLlmsTxt } from '../skills/seo-geo/scripts/lib/llms-txt.mjs'
import { SEO, rules, runJson, send, serve, tempFile } from './helpers.mjs'

const CRAWLERS = join(SEO, 'check-crawlers.mjs')

test('Google\'s forgiven misspellings and colon-less lines are read, and reported', () => {
  const r = parseRobots('User agent: gptbot\nDissallow: /private\nDisallow /tmp\nuser-agent: *\nDisallow: /a b c\nSite-map: https://example.com/s.xml\n')
  assert.deepEqual(r.groups[0].agents, ['gptbot'])
  assert.deepEqual(r.groups[0].rules.map((x) => `${x.type} ${x.pattern}`), ['disallow /private', 'disallow /tmp'])
  assert.deepEqual(r.sitemaps, ['https://example.com/s.xml'])
  assert.deepEqual(r.typos.map((t) => t.why), ['misspelt field', 'misspelt field', 'no colon', 'misspelt field'])
  // Three words with no colon is not a line Google reads.
  assert.equal(parseRobots('User-agent: *\nDisallow / x\n').groups[0].rules.length, 0)
  assert.equal(policyFor(r, 'GPTBot', { path: '/private/x' }).allowed, false)
})

test('a hostile wildcard pattern is matched in linear time', () => {
  const pattern = `/${'*a'.repeat(30)}*b`
  const path = `/${'a'.repeat(5000)}`
  const t0 = Date.now()
  assert.equal(matchLength(pattern, path), null)
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
})

test('wildcards, end anchors and a literal $ follow RFC 9309', () => {
  assert.equal(matchLength('/*.php$', '/a/b.php'), 7)
  assert.equal(matchLength('/*.php$', '/a/b.php?x=1'), null)
  assert.equal(matchLength('/a$b', '/a$b'), 4, '$ in the middle is a literal')
  assert.equal(matchLength('/fish*', '/fish.html'), 6)
  assert.equal(matchLength('/caf%C3%A9', '/café'), 10)
  // Longest match wins; a tie goes to Allow.
  assert.equal(isPathAllowed([{ type: 'disallow', pattern: '/p' }, { type: 'allow', pattern: '/p' }], '/p').allowed, true)
  assert.equal(isPathAllowed([{ type: 'allow', pattern: '/' }, { type: 'disallow', pattern: '/*.pdf$' }], '/a.pdf').allowed, false)
})

test('a robots.txt Noindex rule is reported as dead since 2019', async () => {
  const file = tempFile('robots.txt', 'User-agent: *\nNoindex: /private\nDisallow:\n')
  const r = await runJson(CRAWLERS, [file])
  assert.ok(r.json.findings.some((f) => f.rule === 'robots-noindex' && f.level === 'warn' && /1 September 2019/.test(f.message)))
  const clean = await runJson(CRAWLERS, [tempFile('robots.txt', 'User-agent: *\nDisallow: /private\n')])
  assert.ok(!clean.json.findings.some((f) => f.rule === 'robots-noindex'))
})

test('rules past 500 KiB are not rules', async () => {
  const padding = `# ${'x'.repeat(600 * 1024)}\n`
  const file = tempFile('robots.txt', `User-agent: GPTBot\nAllow: /\n${padding}User-agent: ClaudeBot\nDisallow: /\n`)
  const r = await runJson(CRAWLERS, [file])
  assert.ok(r.json.findings.some((f) => f.rule === 'robots-size'))
  assert.equal(r.json.bots.find((b) => b.token === 'ClaudeBot').allowed, true, 'the ClaudeBot group sits past the 500 KiB Google reads')
})

test('a 429 is the probe tripping a rate limiter, not a block', () => {
  assert.equal(classifyProbe(429, false), 'rate-limited')
  assert.equal(classifyProbe(202, false), 'challenge')
  const row = { token: 'GPTBot', purpose: 'training', compliance: 'obeys', allowed: true }
  const controls = { browser: { signal: 'ok', status: 200 }, curl: { signal: 'ok', status: 200 } }
  assert.equal(verdictFor(row, { signal: 'rate-limited', status: 429 }, controls), 'unknown')
  const f = liveFindings([{ ...row, evidence: { signal: 'rate-limited', status: 429 }, verdict: 'unknown' }], controls)
  assert.ok(f.some((x) => x.level === 'not-checked' && /429/.test(x.message)))
  assert.ok(!f.some((x) => x.rule === 'edge-blocked'))
})

test('a 404 or 5xx served only to a crawler is an edge difference, not "open"', () => {
  const row = { token: 'OAI-SearchBot', purpose: 'search', compliance: 'obeys', allowed: true }
  const controls = { browser: { signal: 'ok', status: 200 }, curl: { signal: 'ok', status: 200 } }
  assert.equal(verdictFor(row, { signal: 'not-found', status: 404 }, controls), 'edge-error')
  assert.equal(verdictFor(row, { signal: 'server-error', status: 503 }, controls), 'edge-error')
  assert.equal(verdictFor(row, { signal: 'ok', status: 200 }, controls), 'open')
})

test('when a browser is refused, the crawler probes are skipped', async () => {
  let requests = 0
  const srv = await serve((req, res) => {
    requests++
    send(res, 403, 'no', { server: 'AkamaiGHost' })
  })
  try {
    const roster = [{ token: 'GPTBot', ua: 'GPTBot/1.1' }, { token: 'ClaudeBot', ua: 'ClaudeBot/1.0' }]
    const probes = await probeAll(`${srv.origin}/`, roster, { timeoutMs: 5000 })
    assert.equal(probes.skipped, true)
    assert.equal(requests, 2, 'the browser and curl controls only')
  } finally {
    await srv.close()
  }
})

test('a challenge header marks a challenge whatever the status', async () => {
  const srv = await serve((req, res) => send(res, 200, 'ok', /GPTBot/.test(req.headers['user-agent']) ? { 'x-amzn-waf-action': 'challenge' } : {}))
  try {
    const probes = await probeAll(`${srv.origin}/`, [{ token: 'GPTBot', ua: 'GPTBot/1.1' }], { timeoutMs: 5000 })
    assert.equal(probes.bots.get('GPTBot').signal, 'challenge')
    assert.equal(probes.browser.signal, 'ok')
  } finally {
    await srv.close()
  }
})

test('a robots.txt refused to this tool is read from a browser\'s copy, with a warning', async () => {
  const srv = await serve((req, res) => {
    if (req.url !== '/robots.txt') return send(res, 404, 'nf')
    if (/Chrome\//.test(req.headers['user-agent'])) return send(res, 200, 'User-agent: GPTBot\nDisallow: /\n', { 'content-type': 'text/plain' })
    return send(res, 403, 'blocked', { server: 'cloudflare' })
  })
  try {
    const r = await runJson(CRAWLERS, [srv.origin])
    assert.ok(r.json.findings.some((f) => f.rule === 'robots-wall' && f.level === 'warn'))
    assert.equal(r.json.robotsStatus, 200)
    assert.equal(r.json.bots.find((b) => b.token === 'GPTBot').allowed, false, 'read from the real file, not "403 means allow all"')
  } finally {
    await srv.close()
  }
})

test('a robots.txt past five redirects is unavailable (Google: a 404), not a crash', async () => {
  const srv = await serve((req, res) => {
    const n = Number(req.url.match(/^\/r(\d+)$/)?.[1] ?? -1)
    if (req.url === '/robots.txt') return send(res, 301, '', { location: '/r1' })
    if (n >= 0) return send(res, 301, '', { location: `/r${n + 1}` })
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CRAWLERS, [srv.origin])
    assert.equal(r.json.checked, true)
    assert.ok(r.json.findings.some((f) => f.rule === 'robots-redirects' && /five redirects/.test(f.message)))
    assert.equal(r.json.fetchState, 'unavailable')
  } finally {
    await srv.close()
  }
})

test('llms.txt list problems are reported once per section, not once per line', () => {
  const v = validateLlmsTxt(`# Site\n\n## Patterns\n\n${Array.from({ length: 12 }, (_, i) => `- Pattern ${i}: \`/x/${i}\``).join('\n')}\n\n## Docs\n\n- [A](https://a.example)\n- not a link\n`)
  const items = v.issues.filter((i) => i.rule === 'link-item')
  assert.equal(items.length, 2)
  assert.match(items[0].message, /section "Patterns" has 12 list entries \(lines 5 to 16\)/)
  assert.match(items[1].message, /section "Docs" has 1 list entry \(line 21\) that is not a/)
  assert.deepEqual(rules(v.issues.map((i) => ({ ...i, level: 'warn' }))), ['link-item', 'link-item'])
})

test('an edge block is an error for the major search crawlers and a warning for the rest', () => {
  const controls = { browser: { signal: 'ok', status: 200 }, curl: { signal: 'ok', status: 200 } }
  const row = (token) => ({ token, purpose: 'search', compliance: 'obeys', allowed: true, evidence: { signal: 'forbidden', status: 403 }, verdict: 'edge-blocked' })
  const f = liveFindings([row('OAI-SearchBot'), row('Bytespider'), row('meta-webindexer')], controls).filter((x) => x.rule === 'edge-blocked')
  assert.deepEqual(f.map((x) => `${x.level} ${x.message.split(':')[0]}`), ['error OAI-SearchBot', 'warn Bytespider', 'warn meta-webindexer'])
})
