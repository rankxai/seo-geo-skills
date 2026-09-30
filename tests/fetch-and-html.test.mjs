/**
 * The shared plumbing in lib/cli.mjs and lib/html.mjs: fetching, decoding and
 * reading markup the way a browser does. Each case here was a real failure on
 * a live site or a saved edge-case page (September 2026 panel).
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - cli.mjs fetchPage(): the loop check `chain.some((hop) => hop.url === next.href)`
 *     removed. Caught by "a redirect loop and a long chain are reported, not
 *     followed forever".
 *   - cli.mjs readBody(): the `size + chunk.length > maxBytes` cap removed.
 *     Caught by "a body is read only up to the cap".
 *   - cli.mjs charsetOf(): the <meta charset> branch removed. Caught by
 *     "a page is decoded by its declared charset".
 *   - cli.mjs decodeText(): the windows-1252 table bypassed, leaving it to
 *     TextDecoder. Caught by the same test ON NODE 20 ONLY: Node 20.20 decodes
 *     0x80-0x9F as C1 controls, Node 24 gets them right, which is why the
 *     table exists. Run the suite on the oldest supported Node too.
 *   - cli.mjs botWall(): the status 403/429 branch removed. Caught by "a bot
 *     wall is recognised by status and by vendor header".
 *   - html.mjs findInvisible(): the JOINERS context test removed. Caught by
 *     "joiners in Persian, Thai and emoji are spelling, not hidden text".
 *   - html.mjs headOf(): the `<body` boundary removed. Caught by "the head
 *     ends at <body> when there is no </head>".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXIT, UsageError, botWall, charsetOf, classifyArg, decodeText, fetchPage, intOption } from '../skills/seo-geo/scripts/lib/cli.mjs'
import { bodyOf, findInvisible, findTags, headOf, maskRawText, parseAttrs, stripComments } from '../skills/seo-geo/scripts/lib/html.mjs'
import { send, serve } from './helpers.mjs'

test('a redirect loop and a long chain are reported, not followed forever', async () => {
  const srv = await serve((req, res, origin) => {
    if (req.url === '/a') return send(res, 301, '', { location: '/b' })
    if (req.url === '/b') return send(res, 302, '', { location: `${origin}/a` })
    const hop = Number(req.url.match(/^\/hop(\d+)$/)?.[1] ?? -1)
    if (hop >= 0) return send(res, 301, '', { location: `/hop${hop + 1}` })
    return send(res, 404, 'nf')
  })
  try {
    const loop = await fetchPage(`${srv.origin}/a`, { timeoutMs: 5000 })
    assert.equal(loop.redirectLimit, true)
    assert.match(loop.error, /redirect loop/)
    assert.deepEqual(loop.redirectChain.map((h) => h.status), [301, 302])
    const long = await fetchPage(`${srv.origin}/hop0`, { timeoutMs: 5000, maxRedirects: 5 })
    assert.equal(long.redirectLimit, true)
    assert.match(long.error, /more than 5 redirects/)
    const fine = await fetchPage(`${srv.origin}/hop0`.replace('hop0', 'nope'), { timeoutMs: 5000 })
    assert.equal(fine.status, 404)
    assert.equal(fine.redirected, false)
  } finally {
    await srv.close()
  }
})

test('a relative Location is resolved, and the chain is kept', async () => {
  const srv = await serve((req, res) => (req.url === '/old' ? send(res, 308, '', { location: 'new?x=1' }) : send(res, 200, '<p>new</p>')))
  try {
    const r = await fetchPage(`${srv.origin}/old`, { timeoutMs: 5000 })
    assert.equal(r.status, 200)
    assert.equal(r.finalUrl, `${srv.origin}/new?x=1`)
    assert.deepEqual(r.redirectChain.map((h) => h.status), [308])
  } finally {
    await srv.close()
  }
})

test('a body is read only up to the cap, and says it was cut', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    const chunk = Buffer.alloc(64 * 1024, 'a')
    let sent = 0
    const pump = () => {
      while (sent < 200) {
        sent++
        if (!res.write(chunk)) return res.once('drain', pump)
      }
      res.end()
    }
    pump()
  })
  try {
    const r = await fetchPage(`${srv.origin}/big`, { timeoutMs: 10_000, maxBytes: 1_000_000 })
    assert.equal(r.truncated, true)
    assert.equal(r.bytes, 1_000_000)
    const small = await fetchPage(`${srv.origin}/big`, { timeoutMs: 10_000, maxBytes: 20_000_000 })
    assert.equal(small.truncated, false)
    assert.equal(small.bytes, 200 * 64 * 1024)
  } finally {
    await srv.close()
  }
})

test('a malformed URL is an answer, never a crash', async () => {
  const r = await fetchPage('http://', {})
  assert.match(r.error, /not a valid URL/)
  assert.throws(() => classifyArg('https://exa mple.com/'), UsageError)
})

test('a page is decoded by its declared charset', () => {
  const latin = Buffer.from('<meta charset="windows-1252"><title>Caf\xE9 \x93q\x94</title>', 'latin1')
  assert.equal(charsetOf(latin, null), 'windows-1252')
  assert.match(decodeText(latin, null).text, /Café “q”/)
  const sjis = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>', 'latin1'), Buffer.from([0x88, 0xa2, 0x95, 0x94, 0x8a, 0xb0]), Buffer.from('</title>')])
  assert.match(decodeText(sjis, null).text, /阿部寛/)
  assert.equal(charsetOf(latin, 'text/html; charset=utf-8'), 'utf-8', 'the header outranks the document')
  assert.equal(charsetOf(Buffer.from([0xef, 0xbb, 0xbf, 0x3c]), 'text/html; charset=latin1'), 'utf-8', 'a BOM outranks the header')
  assert.equal(charsetOf(Buffer.from('<meta charset="utf-16">'), null), 'utf-8', 'a document cannot declare itself UTF-16')
  assert.equal(decodeText(Buffer.from('<meta charset="x-nonsense"><p>ok</p>'), null).unsupportedCharset, 'x-nonsense')
})

test('bare names with a file extension are files, not hostnames', () => {
  assert.equal(classifyArg('page.html').kind, 'file')
  assert.equal(classifyArg('sitemap.xml.gz').kind, 'file')
  assert.equal(classifyArg('example.com').kind, 'url')
  assert.equal(classifyArg('C:\\pages\\a.html').kind, 'file')
})

test('numeric options have a floor', () => {
  assert.throws(() => intOption('0', 'timeout', 1, 1), /at least 1/)
  assert.equal(intOption('0', 'sample', 0), 0)
  assert.equal(EXIT.UNCHECKED, 3)
})

test('a bot wall is recognised by status and by vendor header; a login is not a wall', () => {
  const h = (o) => new Headers(o)
  assert.match(botWall(403, h({ server: 'DataDome', 'x-datadome': 'protected' })), /DataDome/)
  assert.match(botWall(403, h({ server: 'AkamaiGHost' })), /Akamai/)
  assert.match(botWall(200, h({ 'cf-mitigated': 'challenge' })), /Cloudflare challenge/)
  assert.match(botWall(202, h({})), /202/)
  assert.match(botWall(405, h({ 'x-amzn-waf-action': 'captcha' })), /AWS WAF/)
  assert.equal(botWall(200, h({ 'x-datadome': 'protected' })), null, 'DataDome marks every response it passes')
  assert.equal(botWall(401, h({})), null)
  assert.equal(botWall(404, h({})), null)
})

test('comments inside scripts are text, and a script inside a comment is not a script', () => {
  const html = `<script>var a = '<!--';</script><link rel="canonical" href="https://example.com/kept"><!-- <link rel="canonical" href="https://example.com/gone"> -->`
  const clean = stripComments(html)
  assert.equal(findTags(clean, 'link').length, 1)
  assert.equal(findTags(clean, 'link')[0].attrs.get('href'), 'https://example.com/kept')
  const masked = maskRawText(`<script>document.write('<link rel="canonical" href="https://evil.example/">')</script><title>T</title>`)
  assert.equal(findTags(masked, 'link').length, 0)
})

test('the head ends at <body> when there is no </head>', () => {
  const html = '<html><head><title>T</title><body><svg><title>Not the page title</title></svg></body></html>'
  assert.ok(!/Not the page title/.test(headOf(html)))
  assert.match(bodyOf(html), /Not the page title/)
  assert.equal(headOf('<title>only</title>'), '<title>only</title>')
})

test('a > inside a quoted attribute does not end the tag, and an unquoted trailing slash is kept', () => {
  const [meta] = findTags('<meta name="description" content="Price > $5 and < $10">', 'meta')
  assert.equal(meta.attrs.get('content'), 'Price > $5 and < $10')
  assert.equal(parseAttrs('<link rel=canonical href=https://example.com/a/>').get('href'), 'https://example.com/a/')
  assert.equal(parseAttrs('<link rel="canonical" href="https://example.com/a" />').get('href'), 'https://example.com/a')
  assert.equal(findTags('<metadata x="1"><meta name="a">', 'meta').length, 1, '<metadata> is not <meta>')
})

test('joiners in Persian, Thai and emoji are spelling, not hidden text; inside an English word they are reported', () => {
  assert.deepEqual(findInvisible('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'), [], 'ZWNJ in Persian')
  assert.deepEqual(findInvisible('\u0E20\u0E32\u0E29\u0E32\u200B\u0E44\u0E17\u0E22'), [], 'ZWSP as a Thai word break')
  assert.deepEqual(findInvisible('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'), [], 'ZWJ in a family emoji')
  assert.deepEqual(findInvisible('tools\u2060 \u2013 designed'), [], 'a word joiner before a dash')
  assert.deepEqual(findInvisible('<a>\u200B</a>'), [], 'a ZWSP standing alone in an anchor')
  assert.deepEqual(findInvisible('che\u200Bap'), ['U+200B'])
  assert.deepEqual(findInvisible('dis\u200Dcount'), ['U+200D'])
  assert.deepEqual(findInvisible('\u0645\u0631\u062D\u0628\u0627 \u200F(1)'), [], 'RLM on a right-to-left page')
  assert.deepEqual(findInvisible('plain \u200F text'), ['U+200F'], 'RLM on a page with no right-to-left script')
  assert.deepEqual(findInvisible('\u0645\u0631\u062D\u0628\u0627 \u202Eevil'), ['U+202E'], 'an override is always reported')
  assert.deepEqual(findInvisible('a\u{E0041}b'), ['U+E0041'])
})
