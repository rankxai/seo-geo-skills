/**
 * audit-page on the pages real sites serve rather than the pages a template
 * produces: malformed markup, missing heads, other charsets, bot walls,
 * scoped robots headers. Every case is a false positive or a missed problem
 * found in the September 2026 panel (twenty live sites and twenty saved
 * edge-case pages), pinned with a case that fires and one that stays quiet.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - robots.mjs parseIndexingDirectives(): the DIRECTIVES check removed, so
 *     every "name:" prefix became a crawler scope ("unavailable_after:" read as
 *     a crawler name). Caught by "an unavailable_after date in the past is a
 *     noindex".
 *   - audit.mjs reportIndexing(): `serious ? 'error' : 'warn'` changed to
 *     always 'error'. Caught by "a header scoped to one minor crawler does
 *     not noindex the page".
 *   - audit-page.mjs: the browser retry on a bot wall removed (the wall page
 *     audited as the site). Caught by "a bot wall is retried as a browser".
 *   - audit.mjs: canonicals compared by raw href again instead of the URL
 *     they resolve to. Caught by "a relative and an absolute canonical to
 *     the same URL agree".
 *   - audit.mjs: the bing-noarchive block deleted. Caught by "noarchive and
 *     nocache warn for Bing's AI answers".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { auditHtml, firstInvalidHeadElement, linkHeaderCanonicals, metaRefresh } from '../skills/seo-geo/scripts/lib/audit.mjs'
import { SEO, rules, run, runJson, send, serve } from './helpers.mjs'

const AUDIT = join(SEO, 'audit-page.mjs')
const words = 'Plain words that make up the body of a real article for the text length rule. '.repeat(12)
const std = '<title>T</title><meta name="description" content="A description that is long enough to avoid the short note here."><meta property="og:image" content="https://example.com/i.png">'
const page = (head, body = '') => `<!doctype html><html lang="en"><head>${std}${head}</head><body><main><h1>H</h1><p>${words}</p>${body}</main></body></html>`
const canon = '<link rel="canonical" href="https://example.com/p">'
const ctx = (extra = {}) => ({ url: 'https://example.com/p', source: 'file', ...extra })
const audit = (html, c = ctx()) => auditHtml(html, c).findings
const at = (findings, rule) => findings.filter((f) => f.rule === rule)

test('an implied head is read, and an SVG title in the body is not a second title', () => {
  const html = `<!doctype html><html lang="en"><title>Only</title><link rel="canonical" href="https://example.com/p"><body><main><h1>H</h1><p>${words}</p><svg><title>Icon</title></svg></main></body></html>`
  const { findings, facts } = auditHtml(html, ctx())
  assert.equal(facts.title, 'Only')
  assert.ok(!at(findings, 'title').length)
  assert.ok(at(findings, 'canonical').some((f) => f.level === 'info' && /points at this URL/.test(f.message)))
})

test('an unclosed <title> is named as such, not as a missing one', () => {
  const f = audit(page('').replace('<title>T</title>', '<title>Broken'))
  assert.ok(at(f, 'title').some((x) => x.level === 'error' && /never closed/.test(x.message)))
  assert.ok(!at(audit(page('')), 'title').length)
})

test('JSON-LD with a comment or a trailing comma is an error that says why', () => {
  const f = audit(page(`${canon}<script type="application/ld+json">{ "@type": "Article", "headline": "x", }</script>`))
  assert.ok(at(f, 'json-ld-parse').some((x) => x.level === 'error' && /no comments and no trailing commas/.test(x.message)))
})

test('markup inside a script string is not markup', () => {
  const html = page(`${canon}<script>document.write('<link rel="canonical" href="https://evil.example/">'); var x = '<!--';</script>`, '<script>var t = "<meta name=robots content=noindex>";</script>')
  const f = audit(html)
  assert.ok(!f.some((x) => x.level === 'error'), JSON.stringify(f.filter((x) => x.level === 'error')))
  assert.ok(at(f, 'canonical').some((x) => /points at this URL/.test(x.message)))
})

test('a relative and an absolute canonical to the same URL agree; two different ones conflict', () => {
  const same = audit(page(`${canon}<link rel="canonical" href="/p">`))
  assert.ok(!at(same, 'canonical').some((x) => x.level === 'error'), JSON.stringify(at(same, 'canonical')))
  const differ = audit(page(`${canon}<link rel="canonical" href="/q">`))
  assert.ok(at(differ, 'canonical').some((x) => x.level === 'error'))
})

test('a relative canonical resolves against <base href>, the way Google resolves it', () => {
  const f = audit(page('<base href="https://cdn.example.org/mirror/"><link rel="canonical" href="p">'))
  assert.ok(at(f, 'canonical').some((x) => /resolves against <base href/.test(x.message)))
  assert.ok(at(f, 'canonical').some((x) => /https:\/\/cdn\.example\.org\/mirror\/p, not at this URL/.test(x.message)))
  const plain = audit(page('<link rel="canonical" href="/p">'))
  assert.ok(at(plain, 'canonical').some((x) => /points at this URL/.test(x.message)))
})

test('an empty canonical href is reported, not read as "points at this URL"', () => {
  const f = audit(page('<link rel="canonical" href="">'))
  assert.ok(at(f, 'canonical').some((x) => /empty href/.test(x.message)))
  assert.ok(!at(f, 'canonical').some((x) => /points at this URL/.test(x.message)))
})

test('a canonical in the Link header counts, and one that disagrees with the head conflicts', () => {
  assert.deepEqual(linkHeaderCanonicals('<https://example.com/a>; rel="preload", <https://example.com/p>; rel="canonical"'), ['https://example.com/p'])
  assert.deepEqual(linkHeaderCanonicals('<https://example.com/x>; rel=alternate; hreflang=de'), [])
  const headers = new Headers({ link: '<https://example.com/p>; rel="canonical"' })
  const onlyHeader = auditHtml(page(''), { url: 'https://example.com/p', finalUrl: 'https://example.com/p', source: 'url', headers }).findings
  assert.ok(!at(onlyHeader, 'canonical').some((x) => /no rel=canonical/.test(x.message)), 'a header canonical is a canonical')
  const conflict = auditHtml(page('<link rel="canonical" href="https://example.com/other">'), { url: 'https://example.com/p', source: 'url', headers }).findings
  assert.ok(at(conflict, 'canonical').some((x) => x.level === 'error' && /Link header/.test(x.message)))
})

test('max-image-preview:none is an image setting, not a noindex', () => {
  const meta = audit(page(`${canon}<meta name="robots" content="max-image-preview:none">`))
  assert.ok(!meta.some((x) => x.level === 'error'))
  const headers = new Headers({ 'x-robots-tag': 'max-image-preview:none, max-snippet:-1' })
  const header = auditHtml(page(canon), { url: 'https://example.com/p', source: 'url', headers }).findings
  assert.ok(!header.some((x) => x.level === 'error'), JSON.stringify(header.filter((x) => x.level === 'error')))
})

test('a header scoped to one minor crawler does not noindex the page; one for Google does', () => {
  const run1 = (value) => auditHtml(page(canon), { url: 'https://example.com/p', source: 'url', headers: new Headers({ 'x-robots-tag': value }) }).findings
  assert.ok(!run1('otherbot: noindex, nofollow').some((x) => x.level === 'error'))
  assert.ok(at(run1('googlebot-news: noindex'), 'x-robots-tag').some((x) => x.level === 'warn' && /Google News only/.test(x.message)))
  assert.ok(at(run1('googlebot: noindex'), 'x-robots-tag').some((x) => x.level === 'error' && /asks Google not to index/.test(x.message)))
  assert.ok(at(run1('noindex'), 'x-robots-tag').some((x) => x.level === 'error'))
  const news = audit(page(`${canon}<meta name="googlebot-news" content="noindex">`))
  assert.ok(at(news, 'robots-meta').some((x) => x.level === 'warn'))
  assert.ok(!news.some((x) => x.level === 'error'))
})

test('an unavailable_after date in the past is a noindex; one in the future is not', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  const past = auditHtml(page(`${canon}<meta name="robots" content="unavailable_after: 2025-01-01">`), ctx({ now })).findings
  assert.ok(at(past, 'robots-meta').some((x) => x.level === 'error' && /has passed/.test(x.message)))
  const future = auditHtml(page(`${canon}<meta name="robots" content="unavailable_after: 2030-01-01">`), ctx({ now })).findings
  assert.ok(!future.some((x) => x.level === 'error'))
})

test('noarchive and nocache warn for Bing\'s AI answers, scoped to who they address; Google-only ones are quiet', () => {
  const all = audit(page(`${canon}<meta name="robots" content="noarchive">`))
  assert.ok(at(all, 'bing-noarchive').some((x) => x.level === 'warn' && /Copilot/.test(x.message) && /every crawler/.test(x.message) && /Google ignores both/.test(x.message)))
  const header = auditHtml(page(canon), { url: 'https://example.com/p', source: 'url', headers: new Headers({ 'x-robots-tag': 'bingbot: noarchive' }) }).findings
  const w = at(header, 'bing-noarchive')
  assert.equal(w.length, 1)
  assert.match(w[0].message, /bingbot only/)
  assert.ok(!/the bingbot part/.test(w[0].message), 'one scope needs no "part" label')
  assert.ok(at(audit(page(`${canon}<meta name="bingbot" content="nocache">`)), 'bing-noarchive').some((x) => /title, URL and snippet/.test(x.message)))
  const both = at(audit(page(`${canon}<meta name="robots" content="noarchive, nocache">`)), 'bing-noarchive')
  assert.ok(both.length && both.every((x) => /title, URL and snippet/.test(x.message) && /treats noarchive plus nocache as nocache/.test(x.message) && !/keeps this page out/.test(x.message)), 'Bing treats both tags as nocache')
  assert.ok(!at(audit(page(`${canon}<meta name="googlebot" content="noarchive">`)), 'bing-noarchive').length)
  assert.ok(!at(audit(page(`${canon}<meta name="robots" content="noindex, noarchive">`)), 'bing-noarchive').length, 'noindex already says more')
})

test('an element that cannot be in <head> is reported when a canonical or robots tag follows it', () => {
  assert.deepEqual(firstInvalidHeadElement('<title>x</title><img src="p.gif"><link rel="canonical">'), { tag: 'img', index: 16 })
  assert.equal(firstInvalidHeadElement('<title>x</title><noscript></noscript><script></script>'), null)
  const f = audit(`<!doctype html><html lang="en"><head>${std}<img src="https://tracker.example/p.gif">${canon}</head><body><main><h1>H</h1><p>${words}</p></main></body></html>`)
  assert.ok(at(f, 'head-invalid').some((x) => x.level === 'warn' && /rel=canonical/.test(x.message)))
  const pixelInNoscript = audit(page(`${canon}<noscript><img src="https://tracker.example/p.gif"></noscript>`))
  assert.ok(!at(pixelInNoscript, 'head-invalid').length, 'noscript content is raw text to a crawler that runs scripts')
})

test('a meta refresh to another URL is a redirect; one that reloads the page is information', () => {
  assert.deepEqual(metaRefresh("0; url='https://example.com/new'"), { seconds: 0, url: 'https://example.com/new' })
  assert.deepEqual(metaRefresh('300'), { seconds: 300, url: null })
  const f = audit(page(`${canon}<meta http-equiv="refresh" content="0; url=/new-home">`))
  assert.ok(at(f, 'meta-refresh').some((x) => x.level === 'warn' && /https:\/\/example\.com\/new-home/.test(x.message) && /permanent/.test(x.message)))
  assert.ok(at(audit(page(`${canon}<meta http-equiv="refresh" content="300">`)), 'meta-refresh').every((x) => x.level === 'info'))
})

test('upper-case markup is read like lower-case markup', () => {
  const f = audit(`<!DOCTYPE HTML><HTML LANG="EN"><HEAD><TITLE>U</TITLE><LINK REL="CANONICAL" HREF="https://example.com/p"><META NAME="ROBOTS" CONTENT="NOINDEX"></HEAD><BODY><MAIN><H1>U</H1><P>${words}</P></MAIN></BODY></HTML>`)
  assert.ok(at(f, 'robots-meta').some((x) => x.level === 'error'))
  assert.ok(at(f, 'canonical').some((x) => /points at this URL/.test(x.message)))
})

test('a frameset is explained as a frameset, not as client rendering', () => {
  const f = audit('<html><head><title>F</title></head><frameset cols="20,80"><frame src="menu.htm"><frame src="main.htm"></frameset></html>')
  assert.ok(at(f, 'server-text').some((x) => x.level === 'error' && /frameset/.test(x.message) && /menu\.htm/.test(x.message)))
})

test('invisible characters in script bodies are code, not copy; in text and JSON-LD they count', () => {
  assert.ok(!at(audit(page(canon, '<script>var re = /[\u200B\uFEFF]/</script>')), 'invisible-chars').length)
  assert.ok(at(audit(page(`${canon}<script type="application/ld+json">{"name": "Ca\u200Bt"}</script>`)), 'invisible-chars').length)
})

test('a truncated read over the limit still reports the size as a floor', () => {
  const f = audit(page(canon), ctx({ bytes: 5 * 1024 * 1024, truncated: true }))
  assert.ok(at(f, 'html-size').some((x) => x.level === 'error' && /at least/.test(x.message)))
})

/* ---- the CLI against a local server ------------------------------------------------ */

const good = page(canon.replace('https://example.com/p', 'PLACEHOLDER'))

test('a bot wall is retried as a browser; the browser copy is audited and the wall is named', async () => {
  const srv = await serve((req, res, origin) => {
    const isBrowser = /Chrome\//.test(req.headers['user-agent'])
    if (req.url === '/walled') return isBrowser ? send(res, 200, good.replace('PLACEHOLDER', `${origin}/walled`)) : send(res, 403, '<title>Blocked</title><meta name="robots" content="noindex">', { server: 'DataDome', 'x-datadome': 'protected' })
    if (req.url === '/wall-everyone') return send(res, 403, '<p>Please enable JS</p>', { server: 'AkamaiGHost' })
    if (req.url === '/challenge') return send(res, 202, '<title></title><script>challenge()</script>')
    if (req.url === '/pdf') return send(res, 200, '%PDF-1.7', { 'content-type': 'application/pdf' })
    if (req.url === '/loop') return send(res, 302, '', { location: '/loop2' })
    if (req.url === '/loop2') return send(res, 302, '', { location: '/loop' })
    if (req.url === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' })
      return res.end(Buffer.from(good.replace('PLACEHOLDER', `${origin}/latin1`).replace('<title>T</title>', '<title>Caf\xE9</title>'), 'latin1'))
    }
    return send(res, 404, 'nf')
  })
  try {
    const walled = await runJson(AUDIT, [`${srv.origin}/walled`])
    assert.equal(walled.json.checked, true)
    assert.ok(walled.json.findings.some((f) => f.rule === 'bot-wall' && f.level === 'warn' && /DataDome/.test(f.message)))
    assert.ok(!walled.json.findings.some((f) => f.rule === 'robots-meta'), 'the wall\'s noindex is not the page\'s')
    assert.equal(walled.json.facts.title, 'T')

    const everyone = await runJson(AUDIT, [`${srv.origin}/wall-everyone`])
    assert.equal(everyone.code, 3)
    assert.equal(everyone.json.checked, false)
    assert.match(everyone.json.reason, /Akamai.*the same/)

    const challenge = await run(AUDIT, [`${srv.origin}/challenge`])
    assert.equal(challenge.code, 3)
    assert.match(challenge.stdout, /NOT CHECKED .*202/)

    const pdf = await runJson(AUDIT, [`${srv.origin}/pdf`])
    assert.equal(pdf.code, 3)
    assert.match(pdf.json.reason, /not an HTML page \(Content-Type: application\/pdf/)

    const loop = await runJson(AUDIT, [`${srv.origin}/loop`])
    assert.equal(loop.code, 1, 'a redirect loop is a finding: nobody reaches a page')
    assert.ok(loop.json.findings.some((f) => f.rule === 'redirect' && f.level === 'error' && /loop/.test(f.message)))

    const latin = await runJson(AUDIT, [`${srv.origin}/latin1`])
    assert.equal(latin.json.facts.title, 'Café')
    assert.equal(latin.json.facts.charset, 'windows-1252')
  } finally {
    await srv.close()
  }
})

test('--user-agent is sent as given, with browser and googlebot shorthands', async () => {
  const seen = []
  const srv = await serve((req, res, origin) => {
    seen.push(req.headers['user-agent'])
    send(res, 200, good.replace('PLACEHOLDER', `${origin}/`))
  })
  try {
    await run(AUDIT, [`${srv.origin}/`, '--user-agent', 'googlebot'])
    await run(AUDIT, [`${srv.origin}/`, '--user-agent', 'MyBot/1.0'])
    assert.match(seen[0], /Googlebot\/2\.1/)
    assert.equal(seen[1], 'MyBot/1.0')
  } finally {
    await srv.close()
  }
})
