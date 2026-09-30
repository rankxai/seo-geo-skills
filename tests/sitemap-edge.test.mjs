/**
 * check-sitemap.mjs on what large and unusual sites actually serve. Every
 * case is a crash, a hang, a false positive or a missed problem from the
 * September 2026 panel (a 2,100-child index that crashed the run, a
 * marketplace whose 13.8 million URLs exhausted a 4 GB heap, a news sitemap
 * flagged as restamped, geo redirects reported as broken entries).
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - check-sitemap.mjs: the nested-index guard `sm.depth >= 1` changed back
 *     to `sm.depth >= 2`. Caught by "an index inside an index is reported and
 *     not followed".
 *   - check-sitemap.mjs allocate(): the round-robin replaced by "every child
 *     of every index". Caught by "--max-sitemaps is one budget shared
 *     across indexes".
 *   - check-sitemap.mjs: the --max-urls stop removed. Caught by "--max-urls
 *     stops reading and says so".
 *   - sitemap.mjs sitemapText(): maxOutputLength removed from gunzipSync.
 *     Caught by "a gzip bomb is reported as over the limit".
 *   - sitemap.mjs lastmodFindings(): the news-sitemap exemption removed.
 *     Caught by "a Google News sitemap is not a restamp".
 *   - sitemap.mjs checkLoc(): isLocaleRedirect() forced to false. Caught by
 *     "a redirect to the same page in another locale warns".
 *   - sitemap.mjs checkLoc(): a wall on both user agents audited as the
 *     page (`res = again`) instead of returned as blocked. Caught by "rate
 *     limiting and walls are not checked, never errors".
 *   - sitemap.mjs: the un-prefixed <loc> lookup removed, so the first
 *     prefixed one wins. Caught by "an <image:loc> before the page's <loc>".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { isLocaleRedirect, lastmodFindings, parseSitemap, sitemapText } from '../skills/seo-geo/scripts/lib/sitemap.mjs'
import { SEO, rules, run, runJson, send, serve, tempFile } from './helpers.mjs'

const CHECK = join(SEO, 'check-sitemap.mjs')
const urlset = (locs, extra = '') => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc>${extra}</url>`).join('')}</urlset>`
const index = (locs) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`
const selfCanonical = (url) => `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body>x</body></html>`
const xml = { 'content-type': 'application/xml' }

test('an index inside an index is reported and not followed; a sitemap reached twice is read once', async () => {
  const seen = []
  const srv = await serve((req, res, origin) => {
    seen.push(req.url)
    if (req.url === '/robots.txt') return send(res, 200, `Sitemap: ${origin}/top.xml\nSitemap: ${origin}/leaf.xml\n`, { 'content-type': 'text/plain' })
    if (req.url === '/top.xml') return send(res, 200, index([`${origin}/inner.xml`, `${origin}/leaf.xml`]), xml)
    if (req.url === '/inner.xml') return send(res, 200, index([`${origin}/deep.xml`]), xml)
    if (req.url === '/leaf.xml') return send(res, 200, urlset([`${origin}/p`]), xml)
    if (req.url === '/p') return send(res, 200, selfCanonical(`${origin}/p`))
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [srv.origin, '--retry-delay', '0'])
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-nesting' && /inner\.xml/.test(f.message)))
    assert.ok(!seen.includes('/deep.xml'), 'a nested index is not followed')
    assert.equal(seen.filter((u) => u === '/leaf.xml').length, 1)
  } finally {
    await srv.close()
  }
})

test('a relative Sitemap: line and a relative child <loc> are reported, never a crash', async () => {
  const srv = await serve((req, res, origin) => {
    if (req.url === '/robots.txt') return send(res, 200, 'Sitemap: /sm.xml\n', { 'content-type': 'text/plain' })
    if (req.url === '/sm.xml') return send(res, 200, index(['example.com/by/someone', `${origin}/leaf.xml`]), xml)
    if (req.url === '/leaf.xml') return send(res, 200, urlset([`${origin}/p`]), xml)
    if (req.url === '/p') return send(res, 200, selfCanonical(`${origin}/p`))
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [srv.origin])
    assert.equal(r.json.checked, true, r.stdout)
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-discovery' && f.level === 'warn' && /relative URL/.test(f.message)))
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-format' && f.level === 'error' && /example\.com\/by\/someone/.test(f.message)))
    assert.equal(r.json.urls, 1)
  } finally {
    await srv.close()
  }
})

test('--max-sitemaps is one budget shared across indexes, round-robin', async () => {
  const seen = []
  const srv = await serve((req, res, origin) => {
    seen.push(req.url)
    if (req.url === '/robots.txt') return send(res, 200, `Sitemap: ${origin}/a.xml\nSitemap: ${origin}/b.xml\n`, { 'content-type': 'text/plain' })
    if (req.url === '/a.xml') return send(res, 200, index(Array.from({ length: 10 }, (_, i) => `${origin}/a${i}.xml`)), xml)
    if (req.url === '/b.xml') return send(res, 200, index([`${origin}/b0.xml`, `${origin}/b1.xml`]), xml)
    if (/^\/[ab]\d\.xml$/.test(req.url)) return send(res, 200, urlset([`${origin}/p${req.url.slice(1, 3)}`]), xml)
    return send(res, 200, selfCanonical(origin + req.url))
  })
  try {
    const r = await runJson(CHECK, [srv.origin, '--max-sitemaps', '5', '--sample', '1', '--retry-delay', '0'])
    const children = seen.filter((u) => /^\/[ab]\d\.xml$/.test(u))
    assert.equal(children.length, 3, `two indexes use 2 of 5, leaving 3: ${children.join(' ')}`)
    assert.ok(children.some((u) => u.startsWith('/b')), 'the small index is not starved by the big one')
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-count' && f.level === 'not-checked' && /12 sitemaps are listed in 2 places/.test(f.message)))
  } finally {
    await srv.close()
  }
})

test('--max-urls stops reading and says so', async () => {
  const seen = []
  const srv = await serve((req, res, origin) => {
    seen.push(req.url)
    if (req.url === '/index.xml') return send(res, 200, index(Array.from({ length: 6 }, (_, i) => `${origin}/s${i}.xml`)), xml)
    return send(res, 200, urlset(Array.from({ length: 50 }, (_, i) => `${origin}${req.url}/u${i}`)), xml)
  })
  try {
    const r = await runJson(CHECK, [`${srv.origin}/index.xml`, '--max-urls', '60', '--sample', '1', '--retry-delay', '0'])
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-count' && /reading stopped at 100 URLs \(--max-urls 60\)/.test(f.message)), JSON.stringify(r.json.findings))
    assert.ok(seen.filter((u) => /^\/s\d\.xml$/.test(u)).length < 6)
  } finally {
    await srv.close()
  }
})

test('a gzip bomb is reported as over the limit, not decompressed into memory', async () => {
  const bomb = gzipSync(Buffer.alloc(51 * 1024 * 1024, 0x20))
  assert.throws(() => sitemapText(bomb), /more than 50 MB/)
  const file = tempFile('bomb.xml.gz', bomb)
  const r = await run(CHECK, [file, '--no-fetch'])
  assert.equal(r.code, 3)
  assert.match(r.stdout, /decompresses to more than 50 MB/)
  assert.match(sitemapText(gzipSync(Buffer.from(urlset(['https://example.com/'])))), /<urlset/)
})

test('text sitemaps and RSS or Atom feeds are sitemaps Google accepts', () => {
  assert.deepEqual(parseSitemap('https://example.com/a\r\nhttps://example.com/b\n').entries.map((e) => e.loc), ['https://example.com/a', 'https://example.com/b'])
  assert.equal(parseSitemap('# Title\n- [x](https://example.com/)\n').type, 'unknown', 'an llms.txt listed as a sitemap is not one')
  const rss = parseSitemap('<rss version="2.0"><channel><item><link>https://example.com/post</link><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>')
  assert.equal(rss.type, 'feed')
  assert.deepEqual(rss.entries, [{ loc: 'https://example.com/post', lastmod: '2026-09-29T10:00:00.000Z' }])
  const atom = parseSitemap('<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://example.com/a"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>')
  assert.deepEqual(atom.entries.map((e) => e.loc), ['https://example.com/a'])
})

test('an <image:loc> before the page\'s <loc> is never read as the page URL', () => {
  const { entries } = parseSitemap('<urlset><url><image:image><image:loc>https://cdn.example.com/i.jpg</image:loc></image:image><loc>https://example.com/page</loc></url></urlset>')
  assert.equal(entries[0].loc, 'https://example.com/page')
})

test('a Google News sitemap is not a restamp; restamps are judged per sitemap', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  const news = parseSitemap(urlset(Array.from({ length: 20 }, (_, i) => `https://example.com/n${i}`), '<lastmod>2026-09-29</lastmod><news:news><news:title>x</news:title></news:news>')).entries.map((e) => ({ ...e, sitemap: 'news.xml' }))
  assert.ok(!rules(lastmodFindings(news, now)).includes('lastmod-restamp'))
  const varied = Array.from({ length: 40 }, (_, i) => ({ loc: `https://example.com/p${i}`, lastmod: `2026-0${1 + (i % 8)}-1${i % 9}`, sitemap: 'posts.xml' }))
  const restamped = Array.from({ length: 12 }, (_, i) => ({ loc: `https://example.com/g${i}`, lastmod: '2026-09-28', sitemap: 'pages.xml' }))
  const f = lastmodFindings([...varied, ...restamped], now)
  assert.ok(f.some((x) => x.rule === 'lastmod-restamp' && /in pages\.xml/.test(x.message)), 'pooling hid it: 12 of 52 is under 80%')
  const many = Array.from({ length: 5 }, (_, s) => Array.from({ length: 10 }, (_, i) => ({ loc: `https://example.com/${s}/${i}`, lastmod: '2026-09-28', sitemap: `s${s}.xml` }))).flat()
  assert.equal(lastmodFindings(many, now).filter((x) => x.rule === 'lastmod-restamp').length, 1, 'five restamped sitemaps are one finding')
})

test('a redirect to the same page in another locale warns; a redirect elsewhere is an error', async () => {
  assert.equal(isLocaleRedirect('https://example.com/legal', 'https://example.com/gb/legal'), true)
  assert.equal(isLocaleRedirect('https://example.com/legal', 'https://example.com/en-us/legal'), true)
  assert.equal(isLocaleRedirect('https://example.com/legal', 'https://example.com/login'), false)
  assert.equal(isLocaleRedirect('https://example.com/legal', 'https://other.example/gb/legal'), false)
  assert.equal(isLocaleRedirect('https://example.com/landmark/nl/r.no.html', 'https://example.com/landmark/nl/r.en-gb.html'), true, 'a locale infix in the file name')
  assert.equal(isLocaleRedirect('https://example.com/a?lang=de', 'https://example.com/a?lang=en'), true)
  assert.equal(isLocaleRedirect('http://example.com/a', 'https://example.com/a'), false, 'a protocol change is not a locale')
  const srv = await serve((req, res, origin) => {
    if (req.url === '/sm.xml') return send(res, 200, urlset([`${origin}/geo`, `${origin}/moved`, `${origin}/renamed`, `${origin}/broken-location`]), xml)
    if (req.url === '/geo') return send(res, 307, '', { location: '/gb/geo' })
    if (req.url === '/moved') return send(res, 301, '', { location: '/gb/moved' })
    if (req.url === '/renamed') return send(res, 301, '', { location: '/elsewhere' })
    if (req.url === '/broken-location') return send(res, 302, '', { location: 'http://[bad' })
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [`${srv.origin}/sm.xml`, '--retry-delay', '0'])
    assert.deepEqual(r.json.results.find((x) => x.loc.endsWith('/geo')).problems.map((p) => `${p.level} ${p.rule}`), ['warn loc-locale-redirect'])
    const moved = r.json.results.find((x) => x.loc.endsWith('/moved')).problems
    assert.deepEqual(moved.map((p) => `${p.level} ${p.rule}`), ['warn loc-locale-redirect'])
    assert.match(moved[0].message, /permanently .*If every visitor, Googlebot included/)
    assert.deepEqual(r.json.results.find((x) => x.loc.endsWith('/renamed')).problems.map((p) => `${p.level} ${p.rule}`), ['error loc-redirect'])
    assert.ok(r.json.results.find((x) => x.loc.endsWith('/broken-location')).problems.some((p) => /invalid Location/.test(p.message)), 'an invalid Location is a finding, not a crash')
  } finally {
    await srv.close()
  }
})

test('rate limiting and walls are not checked, never errors; a browser-only page is checked and named', async () => {
  const srv = await serve((req, res, origin) => {
    const browser = /Chrome\//.test(req.headers['user-agent'])
    if (req.url === '/sm.xml') return send(res, 200, urlset([`${origin}/limited`, `${origin}/walled`, `${origin}/browser-only`, `${origin}/image-setting`, `${origin}/news-only`]), xml)
    if (req.url === '/limited') return send(res, 429, 'slow down')
    if (req.url === '/walled') return send(res, 403, 'no', { server: 'DataDome', 'x-datadome': 'protected' })
    if (req.url === '/browser-only') return browser ? send(res, 200, selfCanonical(`${origin}/browser-only`)) : send(res, 403, 'no', { server: 'cloudflare' })
    if (req.url === '/image-setting') return send(res, 200, selfCanonical(`${origin}/image-setting`), { 'x-robots-tag': 'max-image-preview:none' })
    if (req.url === '/news-only') return send(res, 200, selfCanonical(`${origin}/news-only`), { 'x-robots-tag': 'googlebot-news: noindex' })
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [`${srv.origin}/sm.xml`, '--retry-delay', '0'])
    const errors = r.json.findings.filter((f) => f.level === 'error')
    assert.deepEqual(errors, [], JSON.stringify(errors))
    assert.ok(r.json.findings.some((f) => f.rule === 'loc-blocked' && /limited/.test(f.message) && /429/.test(f.message)))
    assert.ok(r.json.findings.some((f) => f.rule === 'loc-blocked' && /walled/.test(f.message) && /DataDome/.test(f.message)))
    assert.ok(r.json.findings.some((f) => f.rule === 'loc-bot-wall' && f.level === 'warn' && /browser-only/.test(f.message)))
    assert.equal(r.json.clean, 3, 'browser-only, image-setting and news-only are clean')
  } finally {
    await srv.close()
  }
})

test('no sitemap in robots.txt or at /sitemap.xml falls back to /sitemap_index.xml; an unreadable robots.txt is not "no Sitemap: line"', async () => {
  const srv = await serve((req, res, origin) => {
    if (req.url === '/robots.txt') return send(res, 429, 'slow')
    if (req.url === '/sitemap_index.xml') return send(res, 200, urlset([`${origin}/p`]), xml)
    if (req.url === '/p') return send(res, 200, selfCanonical(`${origin}/p`))
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [srv.origin])
    assert.equal(r.json.sitemaps[0].source, `${srv.origin}/sitemap_index.xml`)
    assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-discovery' && f.level === 'not-checked' && /could not be read \(HTTP 429\)/.test(f.message)))
    assert.ok(!r.json.findings.some((f) => /has no Sitemap: line/.test(f.message)))
  } finally {
    await srv.close()
  }
})

test('hundreds of indexes in robots.txt still leave reads for the URL lists; a run that reads none is not checked', async () => {
  const srv = await serve((req, res, origin) => {
    if (req.url === '/robots.txt') return send(res, 200, Array.from({ length: 10 }, (_, i) => `Sitemap: ${origin}/idx${i}.xml`).join('\n'), { 'content-type': 'text/plain' })
    const idx = req.url.match(/^\/idx(\d+)\.xml$/)
    if (idx) return send(res, 200, index([`${origin}/leaf${idx[1]}.xml`]), xml)
    const leaf = req.url.match(/^\/leaf(\d+)\.xml$/)
    if (leaf) return send(res, 200, leaf[1] === '0' ? urlset([]) : urlset([`${origin}/p${leaf[1]}`]), xml)
    return send(res, 200, selfCanonical(origin + req.url))
  })
  try {
    const some = await runJson(CHECK, [srv.origin, '--max-sitemaps', '4', '--retry-delay', '0'])
    assert.equal(some.json.sitemaps.filter((s) => s.type === 'urlset').length, 2, 'two index reads, two URL-list reads')
    assert.ok(some.json.urls > 0 || some.json.findings.some((f) => f.rule === 'sitemap-empty'))
    const none = await runJson(CHECK, [srv.origin, '--max-sitemaps', '1'])
    assert.equal(none.json.urls, 0)
    assert.equal(none.code, 3, 'only an index was read, so no URL was checked')
  } finally {
    await srv.close()
  }
})

test('an empty urlset warns', async () => {
  const file = tempFile('empty.xml', urlset([]))
  const r = await runJson(CHECK, [file, '--no-fetch'])
  assert.ok(r.json.findings.some((f) => f.rule === 'sitemap-empty' && f.level === 'warn'))
})

test('URLs on another host are warned about and never fetched', async () => {
  const otherHits = []
  const other = await serve((req, res) => { otherHits.push(req.url); send(res, 200, 'internal') })
  const srv = await serve((req, res, origin) => {
    if (req.url === '/robots.txt') return send(res, 200, `Sitemap: ${origin}/s.xml\n`, { 'content-type': 'text/plain' })
    if (req.url === '/s.xml') return send(res, 200, urlset([`${origin}/p`, `${other.origin}/secret`]), xml)
    if (req.url === '/p') return send(res, 200, selfCanonical(`${origin}/p`))
    return send(res, 404, 'nf')
  })
  try {
    const r = await runJson(CHECK, [srv.origin, '--retry-delay', '0'])
    assert.ok(r.json.findings.some((f) => f.rule === 'cross-host'), 'the cross-host URL is reported')
    assert.deepEqual(otherHits, [], 'and the other host is never requested')
  } finally {
    await srv.close()
    await other.close()
  }
})
