/**
 * check-logs.mjs and lib/logs.mjs, against fixture logs and IP lists served by
 * a local HTTP server or read from a file through --ranges. No test touches
 * the internet: every crawler a --verify run sees is given its list.
 *
 * fixtures/logs/access.log holds, in combined format: real Googlebot hits
 * (IPv4, IPv6, IPv4-mapped IPv6 and an Apache vhost_combined line), a spoofed
 * Googlebot the CDN refuses, a Googlebot-Image hit that is not Googlebot,
 * Bingbot getting 503 for robots.txt, PerplexityBot mostly refused, GPTBot
 * refused, a browser with an escaped quote in its user agent, a common-format
 * line and a line that is no log at all.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/logs.mjs inCidr(): the shift computed from 32 for both versions.
 *     Caught by "CIDR matching for IPv4 and IPv6".
 *   - lib/logs.mjs botMatchers(): the trailing lookahead removed, so
 *     "Googlebot" also matches "Googlebot-Image". Caught by "a crawler is
 *     matched by its product token and nothing longer".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { botMatchers, inCidr, matchBot, parseCidr, parseClfTime, parseIp, parseIPv6, parseLogLine, rangesFromJson } from '../skills/seo-geo/scripts/lib/logs.mjs'
import { loadRoster } from '../skills/seo-geo/scripts/lib/crawlers.mjs'
import { SEO, fixture, run, runJson, rules, send, serve, tempFile } from './helpers.mjs'

const LOGS = join(SEO, 'check-logs.mjs')
const ACCESS = fixture(join('logs', 'access.log'))
const EDGE = fixture(join('logs', 'edge.jsonl'))
const GOOGLE_RANGES = fixture(join('logs', 'googlebot-ranges.json'))
const BING_RANGES = fixture(join('logs', 'bingbot-ranges.json'))
const bot = (json, token) => json.bots.find((b) => b.token === token)
const find = (json, rule, text = '') => json.findings.filter((f) => f.rule === rule && f.message.includes(text))

const googleList = () => serve((req, res) => (req.url === '/googlebot.json' ? send(res, 200, readFileSync(GOOGLE_RANGES, 'utf8'), { 'content-type': 'application/json' }) : send(res, 404, 'nf')))

test('per crawler: requests, URLs, status mix, re-fetches, robots.txt and first and last seen', async () => {
  const r = await runJson(LOGS, [ACCESS])
  assert.equal(r.code, 1, 'the robots.txt 503 is an error')
  assert.equal(r.json.lines, 33)
  assert.deepEqual(r.json.formats, { combined: 31, common: 1 })
  const g = bot(r.json, 'Googlebot')
  assert.equal(g.requests, 15, '9 real and 6 spoofed; the Googlebot-Image hit is not Googlebot')
  assert.equal(g.purpose, 'search')
  assert.equal(g.robots.fetches, 1)
  assert.equal(g.topUrls[0].url, '/pricing')
  assert.equal(g.topUrls[0].requests, 3)
  assert.ok(Math.abs(g.refetchShare - 2 / 14) < 1e-9, '14 non-robots requests, 12 unique URLs')
  assert.equal(g.firstSeen, '2026-09-10T01:00:00.000Z')
  assert.equal(bot(r.json, 'Bingbot').robots.status['503'], 2)
  assert.equal(r.json.otherRequests, 2, 'the browser and Googlebot-Image')
  assert.equal(r.json.noUserAgent, 1)
  assert.equal(r.json.unparsed, 1)
})

test('findings: robots.txt errors, a refused search crawler, a refused training crawler, and no verification', async () => {
  const r = await runJson(LOGS, [ACCESS])
  assert.equal(find(r.json, 'robots-errors', 'Bingbot')[0].level, 'error')
  assert.equal(find(r.json, 'refused', 'PerplexityBot')[0].level, 'warn', 'unverified hits only warn')
  assert.equal(find(r.json, 'refused', 'GPTBot')[0].level, 'info', 'refusing a training crawler may be a choice')
  assert.equal(find(r.json, 'refused', 'Googlebot').length, 0, '6 of 15 is not most')
  assert.ok(rules(r.json.findings, 'not-checked').includes('verification'))
  const notSeen = find(r.json, 'not-seen')
  assert.equal(notSeen.length, 1, 'minor search crawlers are grouped into one note')
  assert.equal(notSeen[0].level, 'info')
  assert.match(notSeen[0].message, /not seen in this log window/)
  assert.doesNotMatch(notSeen[0].message, /GPTBot|ChatGPT-User/, 'only search crawlers are a finding when absent')
})

test('--verify labels real, spoofed and unverifiable hits against the published ranges', async () => {
  const srv = await googleList()
  try {
    const r = await runJson(LOGS, [ACCESS, '--verify', '--ranges', `Googlebot=${srv.origin}/googlebot.json`, '--ranges', `bingbot=${BING_RANGES}`, '--ranges', `GPTBot=${BING_RANGES}`, '--ranges', `PerplexityBot=${srv.origin}/missing.json`])
    const g = bot(r.json, 'Googlebot').verification
    assert.equal(g.state, 'checked')
    assert.equal(g.verified.requests, 9, 'IPv4, IPv6, IPv4-mapped IPv6 and the vhost line')
    assert.equal(g.spoofed.requests, 6)
    assert.deepEqual(g.spoofed.topIps, [{ ip: '203.0.113.9', requests: 6 }])
    assert.equal(find(r.json, 'spoofed', 'Googlebot')[0].level, 'info')
    assert.ok(find(r.json, 'spoofed-refused', 'Googlebot').length === 1, 'refusing impostors is the CDN working')
    assert.equal(bot(r.json, 'Bingbot').verification.verified.requests, 3)
    assert.equal(bot(r.json, 'PerplexityBot').verification.state, 'failed')
    assert.ok(find(r.json, 'verification', 'PerplexityBot').some((f) => f.level === 'not-checked'))
    assert.equal(find(r.json, 'verification', 'user agents were not verified').length, 0)
  } finally {
    await srv.close()
  }
})

test('a verified search crawler that is mostly refused is an error; the same hits unverified only warn', async () => {
  const G = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  const log = Array.from({ length: 6 }, (_, i) => `66.249.66.9 - - [1${i}/Sep/2026:10:00:00 +0000] "GET /p${i} HTTP/1.1" ${i ? 403 : 200} 10 "-" "${G}"`).join('\n')
  const f = tempFile('blocked.log', `${log}\n`)
  const verified = await runJson(LOGS, [f, '--verify', '--ranges', `Googlebot=${GOOGLE_RANGES}`])
  assert.equal(verified.code, 1)
  assert.equal(find(verified.json, 'refused', 'Googlebot')[0].level, 'error')
  assert.match(find(verified.json, 'refused', 'Googlebot')[0].message, /on 83% of its 6 verified request/)
  const unverified = await runJson(LOGS, [f])
  assert.equal(find(unverified.json, 'refused', 'Googlebot')[0].level, 'warn')
  assert.match(find(unverified.json, 'refused', 'Googlebot')[0].message, /Run --verify/)
})

test('Googlebot absent from a multi-day log is a warning', async () => {
  const B = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'
  const f = tempFile('nog.log', `192.0.2.1 - - [10/Sep/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "${B}"\n192.0.2.1 - - [15/Sep/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 10 "-" "${B}"\n`)
  const r = await runJson(LOGS, [f])
  const g = find(r.json, 'not-seen', 'Googlebot (Google)')
  assert.equal(g.length, 1)
  assert.equal(g[0].level, 'warn')
  assert.match(g[0].message, /not seen in this log window \(5\.0 days\)/)
})

test('JSON-lines logs (Cloudflare Logpush, a Vercel drain) and gzip input', async () => {
  const r = await runJson(LOGS, [EDGE])
  assert.equal(r.json.formats.json, 3)
  assert.equal(r.json.unparsed, 1, 'a JSON line with no request fields is not a log line')
  assert.equal(bot(r.json, 'Googlebot').requests, 2)
  assert.equal(bot(r.json, 'Bingbot').topUrls[0].url, '/docs')
  assert.equal(r.json.window.first, new Date(1789200000000).toISOString(), 'nanosecond timestamps are read')
  const gz = tempFile('access.log.gz', gzipSync(readFileSync(ACCESS)))
  const z = await runJson(LOGS, [gz])
  assert.equal(bot(z.json, 'Googlebot').requests, 15)
  const both = await runJson(LOGS, [ACCESS, EDGE])
  assert.equal(bot(both.json, 'Googlebot').requests, 17)
})

test('text report, --help, usage errors and unreadable input', async () => {
  const r = await run(LOGS, [ACCESS])
  assert.match(r.stdout, /SEARCH \(/)
  assert.match(r.stdout, /user agents NOT verified/)
  assert.match(r.stdout, /ERROR {2}robots-errors/)
  assert.doesNotMatch(r.stdout, /\u2014/)
  assert.equal((await run(LOGS, ['--help'])).code, 0)
  assert.equal((await run(LOGS, [])).code, 2)
  assert.equal((await run(LOGS, [ACCESS, '--ranges', 'Googlebot=x.json'])).code, 2, '--ranges needs --verify')
  assert.equal((await run(LOGS, [ACCESS, '--verify', '--ranges', 'nonsense'])).code, 2)
  assert.equal((await run(LOGS, [join(ACCESS, '..', 'no-such.log')])).code, 3)
  assert.equal((await run(LOGS, [tempFile('junk.log', 'nothing here\nnor here\n')])).code, 3)
})

test('CIDR matching for IPv4 and IPv6', () => {
  const ip = (s) => parseIp(s)
  assert.ok(inCidr(ip('66.249.66.1'), parseCidr('66.249.64.0/19')))
  assert.ok(!inCidr(ip('66.249.96.1'), parseCidr('66.249.64.0/19')))
  assert.ok(inCidr(ip('2001:4860:4801:10::1'), parseCidr('2001:4860:4801:10::/64')))
  assert.ok(!inCidr(ip('2001:4860:4801:11::1'), parseCidr('2001:4860:4801:10::/64')))
  assert.ok(inCidr(ip('::ffff:66.249.66.2'), parseCidr('66.249.64.0/19')), 'IPv4-mapped IPv6 matches IPv4 ranges')
  assert.ok(!inCidr(ip('66.249.66.1'), parseCidr('2001:4860:4801:10::/64')), 'versions never cross')
  assert.ok(inCidr(ip('192.0.2.7'), parseCidr('192.0.2.7')), 'a bare address is a /32')
  assert.ok(inCidr(ip('10.1.2.3'), parseCidr('0.0.0.0/0')))
  assert.equal(parseIPv6('2001:db8::1'), (0x20010db8n << 96n) | 1n)
  assert.equal(parseIPv6('::'), 0n)
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null)
  assert.equal(parseIPv6('1::2::3'), null)
  assert.equal(parseIp('256.1.1.1'), null)
  assert.equal(parseCidr('192.0.2.0/33'), null)
})

test('published range lists in each shape vendors use', () => {
  assert.equal(rangesFromJson({ prefixes: [{ ipv4Prefix: '192.0.2.0/24' }, { ipv6Prefix: '2001:db8::/32' }] }).length, 2)
  assert.equal(rangesFromJson(['192.0.2.0/24', '198.51.100.0/24']).length, 2)
  assert.equal(rangesFromJson({ prefixes: ['192.0.2.0/24'], creationTime: '2026-09-01T00:00:00' }).length, 1, 'a timestamp is not a range')
})

test('a crawler is matched by its product token and nothing longer', () => {
  const m = botMatchers(loadRoster())
  assert.equal(matchBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', m)?.token, 'Googlebot')
  assert.equal(matchBot('Googlebot-Image/1.0', m), null)
  assert.equal(matchBot('Mozilla/5.0 (compatible; AdsBot-Google; +http://www.google.com/adsbot.html)', m), null)
  assert.equal(matchBot('Mozilla/5.0 (compatible; bingbot/2.0)', m)?.token, 'Bingbot', 'case-insensitive')
  assert.equal(matchBot('Mozilla/5.0; compatible; Claude-User/1.0', m)?.token, 'Claude-User')
  assert.equal(matchBot('Mozilla/5.0 (Windows NT 10.0) Chrome/139.0.0.0', m), null)
  assert.ok(!m.some((x) => x.bot.purpose === 'control-token'), 'no crawler sends a control token')
})

test('log line parsing: time zones, escaped quotes, full-URL request lines', () => {
  assert.equal(parseClfTime('10/Sep/2026:12:00:00 +0200'), Date.UTC(2026, 8, 10, 10, 0, 0))
  const e = parseLogLine('192.0.2.1 - - [10/Sep/2026:12:00:00 +0000] "GET https://example.com/a?b=1 HTTP/1.1" 200 5 "-" "UA \\"x\\" y"')
  assert.equal(e.path, '/a?b=1')
  assert.equal(e.ua, 'UA "x" y')
  assert.equal(parseLogLine('192.0.2.1 - - [10/Sep/2026:12:00:00 +0000] "GET / HTTP/1.1" 200 5').format, 'common')
  assert.equal(parseLogLine('not a log line'), null)
})
