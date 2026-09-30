/**
 * check-sitemap.mjs and lib/sitemap.mjs, against a local HTTP server that
 * serves a sitemap index, a plain child, a gzipped child and one page for
 * every failure the sweep must name.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/sitemap.mjs checkLoc(): the X-Robots-Tag check deleted, leaving only
 *     the meta tag. Caught by "every advertised URL is checked for status,
 *     redirect, noindex and canonical".
 *   - lib/sitemap.mjs lastmodFindings(): RESTAMP_SHARE raised from 0.8 to
 *     0.95. Caught by "one lastmod on most URLs is flagged".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { evenSample, lastmodFindings, parseSitemap } from '../skills/seo-geo/scripts/lib/sitemap.mjs'
import { SEO, fixture, readFixture, run, runJson, rules, send, serve } from './helpers.mjs'

const CHECK = join(SEO, 'check-sitemap.mjs')
const urlset = (locs) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-09-${String(10 + (l.length % 9)).padStart(2, '0')}</lastmod></url>`).join('')}</urlset>`
const htmlWith = (canonical, head = '') => `<!doctype html><html><head><link rel="canonical" href="${canonical}">${head}</head><body><p>x</p></body></html>`

function site() {
  let flaky = 0
  return serve((req, res, origin) => {
    const u = req.url
    if (u === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap_index.xml\n`, { 'content-type': 'text/plain' })
    if (u === '/sitemap_index.xml') {
      return send(res, 200, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/pages.xml</loc></sitemap><sitemap><loc>${origin}/posts.xml.gz</loc></sitemap></sitemapindex>`, { 'content-type': 'application/xml' })
    }
    if (u === '/pages.xml') {
      const paths = ['/ok', '/redirect', '/gone', '/noindex-meta', '/noindex-header', '/canon-other', '/canon-slash', '/flaky', '/no-canonical']
      return send(res, 200, urlset(paths.map((p) => origin + p)), { 'content-type': 'application/xml' })
    }
    if (u === '/posts.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' })
      return res.end(gzipSync(urlset([`${origin}/post-1`, `${origin}/ok`])))
    }
    const self = origin + u
    switch (u) {
      case '/ok':
      case '/post-1':
        return send(res, 200, htmlWith(self))
      case '/redirect':
        return send(res, 301, '', { location: `${origin}/ok` })
      case '/gone':
        return send(res, 404, 'nf')
      case '/noindex-meta':
        return send(res, 200, htmlWith(self, '<meta name="robots" content="noindex, follow">'))
      case '/noindex-header':
        return send(res, 200, htmlWith(self), { 'x-robots-tag': 'noindex' })
      case '/canon-other':
        return send(res, 200, htmlWith(`${origin}/ok`))
      case '/canon-slash':
        return send(res, 200, htmlWith(`${self}/`))
      case '/flaky':
        flaky += 1
        return flaky === 1 ? send(res, 503, 'busy') : send(res, 200, htmlWith(self))
      case '/no-canonical':
        return send(res, 200, '<!doctype html><html><head></head><body>x</body></html>')
      default:
        return send(res, 404, 'nf')
    }
  })
}

const problemsFor = (json, path) => json.results.find((r) => r.loc.endsWith(path))?.problems.map((p) => p.rule) ?? null

test('every advertised URL is checked for status, redirect, noindex and canonical', async () => {
  const srv = await site()
  try {
    const r = await runJson(CHECK, [srv.origin, '--retry-delay', '0'])
    assert.equal(r.code, 1)
    assert.match(r.json.discovery, /robots\.txt lists 1 sitemap/)
    assert.equal(r.json.sitemaps.length, 3, 'the index and both children, one of them gzipped')
    assert.equal(r.json.urls, 10, 'duplicates across children are counted once')
    assert.deepEqual(problemsFor(r.json, '/ok'), [])
    assert.deepEqual(problemsFor(r.json, '/post-1'), [])
    assert.deepEqual(problemsFor(r.json, '/redirect'), ['loc-redirect'])
    assert.deepEqual(problemsFor(r.json, '/gone'), ['loc-status'])
    assert.deepEqual(problemsFor(r.json, '/noindex-meta'), ['loc-noindex'])
    assert.deepEqual(problemsFor(r.json, '/noindex-header'), ['loc-noindex'])
    assert.deepEqual(problemsFor(r.json, '/canon-other'), ['loc-canonical'])
    assert.deepEqual(problemsFor(r.json, '/canon-slash'), ['loc-canonical'])
    assert.ok(r.json.findings.some((f) => /canon-slash/.test(f.message) && /trailing slash/.test(f.message)))
    assert.deepEqual(problemsFor(r.json, '/flaky'), [], 'a 503 is retried once and then passes')
    assert.deepEqual(problemsFor(r.json, '/no-canonical'), ['loc-canonical'])
    assert.ok(r.json.findings.some((f) => f.level === 'warn' && /no-canonical: no canonical/.test(f.message)))
  } finally {
    await srv.close()
  }
})

test('--sample checks only that many URLs and says so', async () => {
  const srv = await site()
  try {
    const r = await runJson(CHECK, [`${srv.origin}/pages.xml`, '--sample', '3', '--retry-delay', '0'])
    assert.equal(r.json.fetched, 3)
    assert.ok(r.json.findings.some((f) => f.rule === 'sample' && /checked 3 of 9/.test(f.message)))
  } finally {
    await srv.close()
  }
})

test('one lastmod on most URLs is flagged; varied dates are not', () => {
  const { entries } = parseSitemap(readFixture('sitemap-lastmod.xml'))
  const now = new Date('2026-09-29T00:00:00Z')
  const f = lastmodFindings(entries, now)
  assert.ok(rules(f, 'warn').includes('lastmod-restamp'))
  const varied = entries.map((e, i) => ({ ...e, lastmod: `2026-0${1 + (i % 9)}-1${i % 10}` }))
  assert.ok(!rules(lastmodFindings(varied, now)).includes('lastmod-restamp'))
  const few = entries.slice(0, 5).map((e) => ({ ...e, lastmod: '2026-09-01' }))
  assert.ok(!rules(lastmodFindings(few, now)).includes('lastmod-restamp'), 'under 10 URLs there is no pattern to see')
})

test('future and malformed lastmod values warn; missing ones are information', () => {
  const { entries } = parseSitemap(readFixture('sitemap-lastmod.xml'))
  const f = lastmodFindings(entries, new Date('2026-09-29T00:00:00Z'))
  assert.ok(f.some((x) => x.rule === 'lastmod-future' && /2099-01-01/.test(x.message)))
  assert.ok(f.some((x) => x.rule === 'lastmod-format' && /01\/09\/2026/.test(x.message)))
  assert.ok(f.some((x) => x.rule === 'lastmod-missing' && x.level === 'info'))
  const clean = [{ loc: 'https://e.com/', lastmod: '2026-09-28' }]
  assert.deepEqual(rules(lastmodFindings(clean, new Date('2026-09-29T00:00:00Z'))), [])
})

test('entities in <loc> are decoded', () => {
  const { entries } = parseSitemap(readFixture('sitemap-lastmod.xml'))
  assert.ok(entries.some((e) => e.loc === 'https://example.com/k?x=1&y=2'))
})

test('--no-fetch on a file runs the whole-file checks and marks the rest not checked', async () => {
  const r = await runJson(CHECK, [fixture('sitemap-lastmod.xml'), '--no-fetch'])
  assert.equal(r.code, 0)
  assert.ok(rules(r.json.findings, 'warn').includes('lastmod-restamp'))
  assert.ok(r.json.findings.some((f) => f.rule === 'loc' && f.level === 'not-checked'))
})

test('an even sample spreads across the list', () => {
  const list = Array.from({ length: 100 }, (_, i) => i)
  assert.deepEqual(evenSample(list, 4), [0, 25, 50, 75])
  assert.equal(evenSample(list, 0).length, 100)
  assert.equal(evenSample(list, 500).length, 100)
})

test('a sitemap that is neither urlset nor index is an error; a site with none is not checked', async () => {
  const srv = await serve((req, res) => (req.url === '/bad.xml' ? send(res, 200, '<html></html>', { 'content-type': 'text/html' }) : send(res, 404, 'nf')))
  try {
    const bad = await runJson(CHECK, [`${srv.origin}/bad.xml`])
    assert.equal(bad.code, 1)
    assert.ok(rules(bad.json.findings, 'error').includes('sitemap-format'))
    // A sitemap is optional (Google: a small, well-linked site may not need
    // one), so finding none is "nothing to check", not a defect. Both common
    // locations are tried before saying so.
    const none = await run(CHECK, [srv.origin])
    assert.equal(none.code, 3, none.stdout)
    assert.match(none.stdout, /no sitemap found: .*\/sitemap\.xml and \/sitemap_index\.xml answered HTTP 404/)
  } finally {
    await srv.close()
  }
  const down = await run(CHECK, [`${srv.origin}/sitemap.xml`, '--timeout', '3000'])
  assert.equal(down.code, 3)
  assert.match(down.stdout, /NOT CHECKED/)
})

test('usage errors exit 2', async () => {
  assert.equal((await run(CHECK, [])).code, 2)
  assert.equal((await run(CHECK, ['x.xml', '--sample', 'many'])).code, 2)
  assert.equal((await run(CHECK, ['javascript:alert(1)'])).code, 2)
})
