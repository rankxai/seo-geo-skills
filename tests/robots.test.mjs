/**
 * lib/robots.mjs: RFC 9309 parsing, group selection, rule precedence, fetch
 * semantics and the documented vendor fallbacks.
 *
 * Two bugs this suite exists to keep fixed:
 *   1. Group selection by PREFIX. The earlier implementation matched a group
 *      when its User-agent value was a prefix of the crawler's token, so a
 *      "Google" group captured Google-Extended. RFC 9309 section 2.2.1 says
 *      exact, case-insensitive product-token matching.
 *   2. No fallback for Applebot (Apple: with no Applebot group it follows
 *      Googlebot's) or Amzn-SearchBot (Amazon: it follows the rules given to
 *      other search bots). Both fell straight through to *.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - groupsNaming(): `g.agents.includes(t)` replaced with
 *     `g.agents.some((a) => a !== '*' && t.startsWith(a))` (the old prefix
 *     rule). Caught by "a Google group does not govern Google-Extended".
 *   - rulesForAgent(): the fallback loop removed. Caught by "Applebot falls
 *     back to the Googlebot group when not named".
 *   - fetchSemantics(): 5xx returned allowAll instead of disallowAll. Caught by
 *     "5xx, 429 and no answer mean complete disallow".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchSemantics, isPathAllowed, nearMissAgents, parseRobots, policyFor, productToken, rulesForAgent } from '../skills/seo-geo/scripts/lib/robots.mjs'
import { readFixture } from './helpers.mjs'

const APPLE_FALLBACK = ['Googlebot']
const AMAZON_FALLBACK = ['Googlebot', 'Bingbot']

test('a Google group does not govern Google-Extended (exact match, not prefix)', () => {
  const robots = parseRobots(readFixture('robots-google-prefix.txt'))
  const ext = policyFor(robots, 'Google-Extended')
  assert.equal(ext.via, 'star')
  assert.equal(ext.allowed, true, 'Google-Extended falls to *, which only blocks /admin/')
  assert.equal(policyFor(robots, 'Google-Agent').via, 'star')
  // Googlebot has its own group and is not affected by the "Google" group either.
  assert.equal(policyFor(robots, 'Googlebot').allowed, true)
  assert.equal(policyFor(robots, 'Googlebot').via, 'own')
})

test('a Googlebot group does not govern Googlebot-Image, and matching ignores case', () => {
  const robots = parseRobots('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n')
  assert.equal(policyFor(robots, 'Googlebot-Image').allowed, true)
  assert.equal(policyFor(robots, 'GOOGLEBOT').allowed, false)
})

test('the User-agent value is reduced to its product token (Googlebot/2.1 names Googlebot)', () => {
  assert.equal(productToken('Googlebot/2.1'), 'googlebot')
  assert.equal(productToken('* # everyone'), '*')
  const robots = parseRobots('User-agent: Googlebot/2.1\nDisallow: /x\n')
  assert.equal(policyFor(robots, 'Googlebot', { path: '/x' }).allowed, false)
})

test('a named group replaces *, it does not add to it', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n')
  assert.equal(policyFor(robots, 'GPTBot').allowed, true)
  assert.equal(policyFor(robots, 'PerplexityBot').allowed, false)
})

test('all groups naming a crawler merge (RFC 9309 section 2.2.1)', () => {
  const robots = parseRobots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /private\n\nUser-agent: GPTBot\nDisallow: /drafts\n')
  assert.deepEqual(rulesForAgent(robots, 'GPTBot').rules.map((r) => r.pattern).sort(), ['/drafts', '/private'])
  assert.deepEqual(rulesForAgent(robots, 'ClaudeBot').rules.map((r) => r.pattern), ['/private'])
})

test('a rule line closes the agent run; a Sitemap line does not', () => {
  const closed = parseRobots('User-agent: A\nDisallow: /a\nUser-agent: B\nDisallow: /b\n')
  assert.deepEqual(rulesForAgent(closed, 'A').rules.map((r) => r.pattern), ['/a'])
  const open = parseRobots('User-agent: A\nSitemap: https://example.com/s.xml\nUser-agent: B\nDisallow: /both\n')
  assert.deepEqual(rulesForAgent(open, 'A').rules.map((r) => r.pattern), ['/both'])
  assert.deepEqual(open.sitemaps, ['https://example.com/s.xml'])
})

test('longest match wins and Allow wins a tie', () => {
  const rules = [
    { type: 'disallow', pattern: '/' },
    { type: 'allow', pattern: '/blog' },
  ]
  assert.equal(isPathAllowed(rules, '/').allowed, false)
  assert.equal(isPathAllowed(rules, '/blog/post').allowed, true)
  const tie = [
    { type: 'disallow', pattern: '/a' },
    { type: 'allow', pattern: '/a' },
  ]
  assert.equal(isPathAllowed(tie, '/a').allowed, true)
})

test('wildcards and the end anchor', () => {
  const rules = [{ type: 'disallow', pattern: '/*.pdf$' }]
  assert.equal(isPathAllowed(rules, '/paper.pdf').allowed, false)
  assert.equal(isPathAllowed(rules, '/paper.pdf.html').allowed, true)
})

test('an empty Disallow allows everything, and so does no robots.txt content', () => {
  assert.equal(policyFor(parseRobots('User-agent: *\nDisallow:\n'), 'GPTBot').allowed, true)
  const none = policyFor(parseRobots(''), 'GPTBot')
  assert.equal(none.allowed, true)
  assert.equal(none.via, 'none')
})

test('Applebot falls back to the Googlebot group when not named', () => {
  const robots = parseRobots(readFixture('robots-fallback.txt'))
  const apple = policyFor(robots, 'Applebot', { fallbackTokens: APPLE_FALLBACK })
  assert.equal(apple.via, 'fallback')
  assert.equal(apple.matchedAgent, 'Googlebot')
  assert.equal(apple.allowed, true, 'the Googlebot group allows /, while * would have blocked it')
  assert.equal(policyFor(robots, 'Applebot', { fallbackTokens: APPLE_FALLBACK, path: '/search-only/x' }).allowed, false)
})

test('Applebot uses its own group when one exists, and * when neither is named', () => {
  const own = parseRobots('User-agent: Applebot\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n')
  assert.equal(policyFor(own, 'Applebot', { fallbackTokens: APPLE_FALLBACK }).allowed, false)
  const neither = parseRobots('User-agent: *\nDisallow: /\n')
  assert.equal(policyFor(neither, 'Applebot', { fallbackTokens: APPLE_FALLBACK }).via, 'star')
})

test('Amzn-SearchBot falls back to other search bots (Googlebot, then Bingbot)', () => {
  const robots = parseRobots(readFixture('robots-fallback.txt'))
  const amzn = policyFor(robots, 'Amzn-SearchBot', { fallbackTokens: AMAZON_FALLBACK })
  assert.equal(amzn.via, 'fallback')
  assert.equal(amzn.allowed, true)
  const bingOnly = parseRobots('User-agent: Bingbot\nDisallow: /b\n\nUser-agent: *\nDisallow: /\n')
  const viaBing = policyFor(bingOnly, 'Amzn-SearchBot', { fallbackTokens: AMAZON_FALLBACK })
  assert.equal(viaBing.matchedAgent, 'Bingbot')
  assert.equal(viaBing.allowed, true)
})

test('a crawler with no documented fallback does not borrow another group', () => {
  const robots = parseRobots(readFixture('robots-fallback.txt'))
  assert.equal(policyFor(robots, 'PerplexityBot').via, 'star')
  assert.equal(policyFor(robots, 'PerplexityBot').allowed, false)
})

test('4xx means no rules: everything allowed', () => {
  for (const status of [400, 401, 403, 404, 410]) {
    const s = fetchSemantics(status)
    assert.equal(s.allowAll, true, String(status))
    assert.equal(policyFor(parseRobots('User-agent: *\nDisallow: /'), 'GPTBot', { status }).allowed, true)
  }
})

test('5xx, 429 and no answer mean complete disallow', () => {
  for (const status of [500, 503, 429, null]) {
    const s = fetchSemantics(status)
    assert.equal(s.disallowAll, true, String(status))
    assert.equal(policyFor(parseRobots(''), 'Googlebot', { status }).allowed, false)
  }
  assert.equal(fetchSemantics(200).state, 'ok')
})

test('near misses: "Claude" names no crawler, "ClaudeBot" is exact', () => {
  const robots = parseRobots('User-agent: Claude\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n')
  const misses = nearMissAgents(robots, ['ClaudeBot', 'Claude-User', 'GPTBot'])
  assert.equal(misses.length, 1)
  assert.equal(misses[0].agent, 'claude')
  assert.deepEqual(misses[0].wouldMatch.sort(), ['claude-user', 'claudebot'])
})

test('comments, CRLF line endings and a BOM are handled', () => {
  const robots = parseRobots('\uFEFF# comment\r\nUSER-AGENT: gptbot  # inline\r\nDISALLOW: /\r\n')
  assert.equal(policyFor(robots, 'GPTBot').allowed, false)
})

test('crawl-delay is read from the merged group', () => {
  const robots = parseRobots('User-agent: ClaudeBot\nCrawl-delay: 5\nDisallow: /tmp\n')
  assert.equal(policyFor(robots, 'ClaudeBot').crawlDelay, 5)
})
