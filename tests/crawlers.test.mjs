/**
 * check-crawlers.mjs and lib/crawlers.mjs, against a local HTTP server that
 * plays the part of a site, its CDN and its robots.txt. No test touches the
 * internet.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/crawlers.mjs verdictFor(): the curl-control branch removed, so a
 *     site that blocks every script reads as blocking each crawler. Caught by
 *     "generic bot protection is reported once, not as per-crawler blocks".
 *   - lib/crawlers.mjs analysePolicy(): Googlebot's blocked level changed
 *     from 'error' to 'warn'. Caught by "blocking Googlebot is an error;
 *     blocking a training crawler is information".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { classifyProbe, loadRoster, verdictFor } from '../skills/seo-geo/scripts/lib/crawlers.mjs'
import { SEO, fixture, readFixture, run, runJson, rules, send, serve } from './helpers.mjs'

const CHECK = join(SEO, 'check-crawlers.mjs')
const PAGE = '<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>'
const bot = (json, token) => json.bots.find((b) => b.token === token)

test('the roster loads, and every row carries the fields the checker needs', () => {
  const roster = loadRoster()
  assert.ok(roster.length >= 25)
  for (const b of roster) {
    for (const k of ['vendor', 'token', 'ua', 'purpose', 'purposeLine', 'robots', 'docsUrl']) assert.ok(k in b, `${b.label} lacks ${k}`)
    assert.ok(['training', 'search', 'user-fetch', 'control-token'].includes(b.purpose), b.label)
  }
  assert.deepEqual(roster.find((b) => b.token === 'Applebot').fallback.tokens, ['Googlebot'])
  assert.ok(roster.find((b) => b.token === 'Amzn-SearchBot').fallback.tokens.includes('Googlebot'))
})

test('a Google group in a robots.txt file does not govern Google-Extended', async () => {
  const r = await runJson(CHECK, [fixture('robots-google-prefix.txt')])
  assert.equal(bot(r.json, 'Google-Extended').allowed, true)
  assert.equal(bot(r.json, 'Google-Extended').via, 'star')
  assert.equal(bot(r.json, 'Googlebot').allowed, true)
  assert.ok(r.json.findings.some((f) => f.rule === 'robots-near-miss' && /Google-Extended/.test(f.message)))
})

test('Applebot follows the Googlebot group when not named, and the report says so', async () => {
  const r = await runJson(CHECK, [fixture('robots-fallback.txt')])
  assert.equal(bot(r.json, 'Applebot').allowed, true)
  assert.equal(bot(r.json, 'Applebot').via, 'fallback')
  assert.equal(bot(r.json, 'Amzn-SearchBot').via, 'fallback')
  assert.equal(bot(r.json, 'PerplexityBot').allowed, false)
  assert.ok(r.json.findings.some((f) => f.rule === 'fallback-group' && /Applebot/.test(f.message)))
})

test('blocking Googlebot is an error; blocking a training crawler is information', async () => {
  const r = await runJson(CHECK, [fixture('robots-block-search.txt')])
  assert.equal(r.code, 1)
  assert.ok(r.json.findings.some((f) => f.level === 'error' && f.rule === 'search-bot-blocked' && /Googlebot/.test(f.message)))
  assert.ok(r.json.findings.some((f) => f.level === 'warn' && f.rule === 'search-bot-blocked' && /OAI-SearchBot/.test(f.message)))
  assert.ok(r.json.findings.some((f) => f.level === 'info' && f.rule === 'training-bots-blocked' && /GPTBot/.test(f.message)))
  assert.ok(r.json.findings.some((f) => f.rule === 'robots-near-miss' && /Claude/.test(f.message)))
  assert.ok(r.json.findings.some((f) => f.rule === 'crawl-delay-ignored' && /Applebot/.test(f.message)))
  const open = await runJson(CHECK, ['-'], { stdin: 'User-agent: *\nAllow: /\n' })
  assert.equal(open.code, 0)
  assert.deepEqual(rules(open.json.findings, 'error'), [])
})

test('robots.txt 404 means everything allowed; 500 and 429 mean everything disallowed', async () => {
  let status = 404
  const srv = await serve((req, res) => (req.url === '/robots.txt' ? send(res, status, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' }) : send(res, 404, 'nf')))
  try {
    const missing = await runJson(CHECK, [srv.origin])
    assert.equal(missing.json.fetchState, 'unavailable')
    assert.ok(missing.json.bots.filter((b) => b.token).every((b) => b.allowed === true))
    assert.ok(rules(missing.json.findings, 'info').includes('robots-missing'))
    assert.equal(missing.code, 0)

    for (const s of [500, 503, 429]) {
      status = s
      const down = await runJson(CHECK, [srv.origin])
      assert.equal(down.json.fetchState, 'unreachable', String(s))
      assert.ok(down.json.bots.filter((b) => b.token).every((b) => b.allowed === false))
      assert.ok(rules(down.json.findings, 'error').includes('robots-unreachable'))
      assert.equal(down.code, 1)
    }
  } finally {
    await srv.close()
  }
})

test('a robots.txt that is really an HTML page is flagged', async () => {
  const srv = await serve((req, res) => send(res, 200, PAGE))
  try {
    const r = await runJson(CHECK, [srv.origin])
    assert.ok(rules(r.json.findings, 'warn').includes('robots-is-html'))
  } finally {
    await srv.close()
  }
})

test('--live: an edge block on a search crawler is an error, separate from robots policy', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' })
    if (req.url === '/llms.txt') return send(res, 404, 'nf')
    const ua = req.headers['user-agent'] || ''
    if (/PerplexityBot|GPTBot/.test(ua)) return send(res, 403, 'blocked', { server: 'test-cdn' })
    return send(res, 200, PAGE)
  })
  try {
    const r = await runJson(CHECK, [srv.origin, '--live'])
    assert.equal(r.code, 1)
    assert.equal(bot(r.json, 'PerplexityBot').verdict, 'edge-blocked')
    assert.equal(bot(r.json, 'PerplexityBot').allowed, true, 'the robots column is unchanged by the edge block')
    assert.equal(bot(r.json, 'GPTBot').verdict, 'edge-blocked')
    assert.equal(bot(r.json, 'OAI-SearchBot').verdict, 'open')
    assert.equal(bot(r.json, 'Google-Extended').verdict, 'policy-only')
    assert.ok(r.json.findings.some((f) => f.level === 'error' && f.rule === 'edge-blocked' && /PerplexityBot/.test(f.message)))
    assert.ok(r.json.findings.some((f) => f.level === 'warn' && f.rule === 'edge-blocked' && /GPTBot/.test(f.message)))
    assert.ok(!rules(r.json.findings).includes('bot-protection'))
  } finally {
    await srv.close()
  }
})

test('generic bot protection is reported once, not as per-crawler blocks', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' })
    const ua = req.headers['user-agent'] || ''
    if (/Chrome\/139/.test(ua) && !/compatible/.test(ua)) return send(res, 200, PAGE)
    return send(res, 403, 'blocked')
  })
  try {
    const r = await runJson(CHECK, [srv.origin, '--live'])
    assert.ok(rules(r.json.findings, 'warn').includes('bot-protection'))
    assert.ok(!rules(r.json.findings).includes('edge-blocked'))
    assert.equal(bot(r.json, 'PerplexityBot').verdict, 'bot-protection')
  } finally {
    await srv.close()
  }
})

test('without --live, edge blocks are reported as not checked', async () => {
  const srv = await serve((req, res) => send(res, req.url === '/robots.txt' ? 200 : 404, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' }))
  try {
    const r = await runJson(CHECK, [srv.origin])
    assert.ok(r.json.findings.some((f) => f.rule === 'live' && f.level === 'not-checked'))
  } finally {
    await srv.close()
  }
})

test('llms.txt: valid, malformed, HTML and absent are each reported, and absence is never a fault', async () => {
  let llms = { status: 404, body: 'nf', type: 'text/plain' }
  const srv = await serve((req, res) => {
    if (req.url === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' })
    if (req.url === '/llms.txt') return send(res, llms.status, llms.body, { 'content-type': llms.type })
    return send(res, 200, PAGE)
  })
  try {
    const absent = await runJson(CHECK, [srv.origin])
    assert.equal(absent.json.llmsTxt.state, 'absent')
    assert.ok(absent.json.findings.some((f) => f.rule === 'llms-txt' && f.level === 'info' && /no major AI search engine documents using it/.test(f.message)))
    assert.equal(absent.code, 0)

    llms = { status: 200, body: readFixture('llms-valid.txt'), type: 'text/plain' }
    const valid = await runJson(CHECK, [srv.origin])
    assert.equal(valid.json.llmsTxt.valid, true)

    llms = { status: 200, body: '## Docs\n\n- not a link\n### Deep\n', type: 'text/plain' }
    const bad = await runJson(CHECK, [srv.origin])
    const issues = rules(bad.json.findings, 'warn')
    assert.ok(issues.includes('llms-txt:h1-first') || issues.includes('llms-txt:h1-required'))
    assert.ok(issues.includes('llms-txt:no-deep-headings'))

    llms = { status: 200, body: PAGE, type: 'text/html' }
    const html = await runJson(CHECK, [srv.origin])
    assert.equal(html.json.llmsTxt.state, 'html')
  } finally {
    await srv.close()
  }
})

test('probe classification and verdicts', () => {
  assert.equal(classifyProbe(200, false), 'ok')
  assert.equal(classifyProbe(200, true), 'challenge')
  assert.equal(classifyProbe(402, false), 'payment-required')
  assert.equal(classifyProbe(403, false), 'forbidden')
  assert.equal(classifyProbe(null, false), 'unreachable')
  const controls = { browser: { signal: 'ok' }, curl: { signal: 'ok' } }
  const row = { token: 'X', purpose: 'search', compliance: 'honoured', allowed: false }
  assert.equal(verdictFor(row, { signal: 'ok' }, controls), 'robots-blocked')
  assert.equal(verdictFor(row, { signal: 'forbidden' }, controls), 'blocked')
  assert.equal(verdictFor({ ...row, allowed: true }, { signal: 'forbidden' }, { ...controls, browser: { signal: 'forbidden' } }), 'unknown')
  assert.equal(verdictFor({ ...row, purpose: 'user-fetch', compliance: 'may-ignore', allowed: false }, { signal: 'ok' }, controls), 'signal-only')
  assert.equal(verdictFor({ token: null }, null, controls), 'unverifiable')
})

test('exit codes: bad flags are usage errors, --live with a file is refused, an unreachable site is not checked', async () => {
  assert.equal((await run(CHECK, ['--bogus'])).code, 2)
  assert.equal((await run(CHECK, [fixture('robots-fallback.txt'), '--live'])).code, 2)
  assert.equal((await run(CHECK, [fixture('robots-fallback.txt'), '--path', 'nope'])).code, 2)
  const srv = await serve((req, res) => send(res, 200, ''))
  const origin = srv.origin
  await srv.close()
  const r = await run(CHECK, [origin, '--timeout', '3000'])
  assert.equal(r.code, 3)
  assert.match(r.stdout, /NOT CHECKED/)
})
