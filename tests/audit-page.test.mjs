/**
 * audit-page.mjs and lib/audit.mjs.
 *
 * Every rule has a case that fires and a case that stays quiet, because a
 * rule is easy to widen until it catches everything, and a check that fires
 * on correct pages gets switched off.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/audit.mjs: `bytes > HTML_ERROR_BYTES` changed to
 *     `bytes > HTML_ERROR_BYTES * 10`. Caught by "a page over 2 MB is an error".
 *   - lib/html.mjs: U+200B removed from INVISIBLE_CHARS. Caught by
 *     "invisible characters are an error, no-break spaces are not".
 *   - lib/audit.mjs: the self-canonical comparison made to always pass
 *     (`if (true)`). Caught by "a canonical pointing elsewhere warns".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { auditHtml, openingKind, HTML_ERROR_BYTES, HTML_WARN_BYTES } from '../skills/seo-geo/scripts/lib/audit.mjs'
import { SEO, fixture, readFixture, run, runJson, rules, send, serve } from './helpers.mjs'

const AUDIT = join(SEO, 'audit-page.mjs')
const good = readFixture('page-good.html')
const bad = readFixture('page-bad.html')

/** A minimal valid page with `body` inside <main>, long enough for the text rule. */
const page = (body, head = '') => `<!doctype html><html lang="en"><head><title>T</title>
<meta name="description" content="A description that is long enough to avoid the short note here.">
<link rel="canonical" href="https://example.com/p"><meta property="og:image" content="https://example.com/i.png">${head}</head>
<body><main><h1>Title</h1><p>${'Plain words for the text length rule. '.repeat(20)}</p>${body}</main></body></html>`

const audit = (html, ctx = { url: 'https://example.com/p', source: 'file' }) => auditHtml(html, ctx).findings

test('a clean page has no errors and no warnings', async () => {
  const r = await runJson(AUDIT, [fixture('page-good.html'), '--url', 'https://example.com/guide'])
  assert.equal(r.code, 0, r.stdout)
  const serious = r.json.findings.filter((f) => f.level === 'error' || f.level === 'warn')
  assert.deepEqual(serious, [])
  assert.deepEqual(r.json.facts.types, ['Article', 'Person'])
})

test('the broken page reports each of its defects and exits 1', async () => {
  const r = await runJson(AUDIT, [fixture('page-bad.html'), '--url', 'https://example.com/one'])
  assert.equal(r.code, 1)
  const errors = rules(r.json.findings, 'error')
  const warns = rules(r.json.findings, 'warn')
  for (const rule of ['title', 'canonical', 'robots-meta', 'json-ld-parse', 'json-ld-placeholder']) assert.ok(errors.includes(rule), `missing error ${rule}`)
  for (const rule of ['one-h1', 'heading-levels', 'html-lang', 'main-landmark', 'meta-description', 'og-image', 'img-alt', 'img-dimensions', 'lcp-lazy', 'json-ld-retired']) assert.ok(warns.includes(rule), `missing warning ${rule}`)
  assert.ok(warns.includes('myth:no-ai-crawler-renders-javascript'))
  assert.ok(warns.includes('myth:llms-txt-helps-google'))
})

test('a client-rendered shell fails the server-text rule; real content passes it', () => {
  const shell = audit(readFixture('page-shell.html'))
  assert.ok(shell.some((f) => f.rule === 'server-text' && f.level === 'error'))
  assert.ok(audit(good).some((f) => f.rule === 'server-text' && f.level === 'info'))
})

test('one h1 is quiet, none or two warn', () => {
  assert.ok(!rules(audit(page(''))).includes('one-h1'))
  assert.ok(rules(audit(page('<h1>Again</h1>'))).includes('one-h1'))
  assert.ok(rules(audit(page('').replace('<h1>Title</h1>', ''))).includes('one-h1'))
})

test('a skipped heading level warns; stepping down one level and back up does not', () => {
  assert.ok(rules(audit(page('<h3>Skipped</h3>'))).includes('heading-levels'))
  assert.ok(!rules(audit(page('<h2>A</h2><h3>B</h3><h2>C</h2>'))).includes('heading-levels'))
})

test('a missing title is an error; a long one is information, because Google sets no length limit', () => {
  assert.ok(rules(audit(page('').replace('<title>T</title>', '')), 'error').includes('title'))
  const long = audit(page('').replace('<title>T</title>', `<title>${'x'.repeat(61)}</title>`))
  assert.ok(rules(long, 'info').includes('title-length'))
  assert.ok(!rules(long, 'warn').includes('title-length'), 'Google: no limit on title length, the link is truncated to the device width')
  assert.ok(!rules(audit(page(''))).includes('title-length'))
})

test('the meta description is checked for presence and length', () => {
  assert.ok(rules(audit(page('').replace(/<meta name="description"[^>]*>/, '')), 'warn').includes('meta-description'))
  assert.ok(rules(audit(page('').replace(/content="A description[^"]*"/, `content="${'d'.repeat(161)}"`)), 'info').includes('meta-description-length'))
  assert.ok(!rules(audit(page(''))).some((r) => r.startsWith('meta-description')))
})

test('a self-referencing canonical is recognised', () => {
  const f = audit(page(''))
  assert.ok(f.some((x) => x.rule === 'canonical' && x.level === 'info' && /points at this URL/.test(x.message)))
  assert.ok(!f.some((x) => x.rule === 'canonical' && x.level !== 'info'))
})

test('a canonical pointing elsewhere warns', () => {
  const f = audit(page(''), { url: 'https://example.com/other', source: 'file' })
  assert.ok(f.some((x) => x.rule === 'canonical' && x.level === 'warn' && /not at this URL/.test(x.message)))
})

test('a trailing-slash difference is called out; a dropped tracking query is not a fault', () => {
  const slash = audit(page(''), { url: 'https://example.com/p/', source: 'file' })
  assert.ok(slash.some((x) => x.rule === 'canonical' && /trailing slash/.test(x.message)))
  const query = audit(page(''), { url: 'https://example.com/p?utm_source=x', source: 'file' })
  assert.ok(query.some((x) => x.rule === 'canonical' && x.level === 'info' && /query string/.test(x.message)))
})

test('two different canonicals are an error; a relative or body canonical warns', () => {
  const two = page('', '<link rel="canonical" href="https://example.com/q">')
  assert.ok(rules(audit(two), 'error').includes('canonical'))
  const relative = page('').replace('href="https://example.com/p"', 'href="/p"')
  assert.ok(audit(relative).some((x) => x.rule === 'canonical' && /not an absolute URL/.test(x.message)))
  const inBody = page('<link rel="canonical" href="https://example.com/p">')
  assert.ok(audit(inBody).some((x) => x.rule === 'canonical' && /<body>/.test(x.message)))
})

test('without a URL the self-canonical check says it was not checked', () => {
  const f = auditHtml(page(''), { source: 'stdin' }).findings
  assert.ok(f.some((x) => x.rule === 'canonical-self' && x.level === 'not-checked'))
})

test('robots meta: noindex is an error, nosnippet warns, index,follow is quiet', () => {
  assert.ok(rules(audit(page('', '<meta name="robots" content="noindex">')), 'error').includes('robots-meta'))
  assert.ok(rules(audit(page('', '<meta name="googlebot" content="nosnippet">')), 'warn').includes('robots-meta'))
  assert.ok(rules(audit(page('', '<meta name="robots" content="max-snippet:0">')), 'warn').includes('robots-meta'))
  assert.ok(!rules(audit(page('', '<meta name="robots" content="index, follow">'))).includes('robots-meta'))
})

test('og:image missing or relative warns; absolute is quiet', () => {
  assert.ok(rules(audit(page('').replace(/<meta property="og:image"[^>]*>/, ''))).includes('og-image'))
  assert.ok(rules(audit(page('').replace('content="https://example.com/i.png"', 'content="/i.png"'))).includes('og-image'))
  assert.ok(!rules(audit(page(''))).includes('og-image'))
})

test('images: missing alt and missing dimensions warn; alt="" with dimensions is fine', () => {
  const f = rules(audit(page('<img src="a.png">')))
  assert.ok(f.includes('img-alt') && f.includes('img-dimensions'))
  const ok = rules(audit(page('<img src="a.png" alt="" width="10" height="10">')))
  assert.ok(!ok.includes('img-alt') && !ok.includes('img-dimensions'))
})

test('a lazy-loaded first image warns; lazy loading a later image does not', () => {
  assert.ok(rules(audit(page('<img src="hero.png" alt="h" width="1" height="1" loading="lazy">'))).includes('lcp-lazy'))
  assert.ok(!rules(audit(page('<img src="hero.png" alt="h" width="1" height="1"><img src="b.png" alt="b" width="1" height="1" loading="lazy">'))).includes('lcp-lazy'))
})

test('JSON-LD that does not parse is an error; valid JSON-LD lists its types', () => {
  const broken = audit(page('', '<script type="application/ld+json">{"@type": "Article",}</script>'))
  assert.ok(rules(broken, 'error').includes('json-ld-parse'))
  const fine = audit(page('', '<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["WebPage","AboutPage"]}]}</script>'))
  assert.ok(!rules(fine, 'error').includes('json-ld-parse'))
  assert.ok(fine.some((x) => x.rule === 'json-ld-types' && /AboutPage, Organization, WebPage/.test(x.message)))
})

test('placeholders in JSON-LD are an error; real values are not', () => {
  for (const v of ['TODO', 'lorem ipsum dolor', 'undefined', '{{ page.title }}', '%%title%%']) {
    assert.ok(rules(audit(page('', `<script type="application/ld+json">{"@type":"Article","headline":"${v}"}</script>`)), 'error').includes('json-ld-placeholder'), v)
  }
  assert.ok(!rules(audit(page('', '<script type="application/ld+json">{"@type":"Article","headline":"A real headline about todos"}</script>'))).includes('json-ld-placeholder'))
})

test('retired schema types warn; FAQPage is information only; ordinary types are quiet', () => {
  for (const t of ['HowTo', 'SpecialAnnouncement', 'OccupationAggregationByEmployer']) {
    const f = audit(page('', `<script type="application/ld+json">{"@type":"${t}"}</script>`))
    assert.ok(f.some((x) => x.rule === 'json-ld-retired' && x.level === 'warn'), t)
  }
  const faq = audit(page('', '<script type="application/ld+json">{"@type":"FAQPage"}</script>'))
  assert.ok(faq.some((x) => x.rule === 'json-ld-retired' && x.level === 'info' && /7 May 2026/.test(x.message)))
  assert.ok(!faq.some((x) => x.rule === 'json-ld-retired' && x.level === 'warn'))
  assert.ok(!rules(audit(page('', '<script type="application/ld+json">{"@type":"Article"}</script>'))).includes('json-ld-retired'))
})

test('a page over 2 MB is an error, over 1 MB warns, a normal page is quiet', () => {
  const padding = (n) => `<!--${'x'.repeat(n)}-->`
  const big = page(padding(HTML_ERROR_BYTES + 50_000))
  assert.ok(Buffer.byteLength(big) > HTML_ERROR_BYTES)
  assert.ok(rules(audit(big), 'error').includes('html-size'))
  const mid = page(padding(HTML_WARN_BYTES + 50_000))
  assert.ok(rules(audit(mid), 'warn').includes('html-size'))
  assert.ok(!rules(audit(page(''))).includes('html-size'))
})

test('invisible characters are an error, no-break spaces are not', () => {
  assert.ok(rules(audit(page('<p>zero\u200Bwidth</p>')), 'error').includes('invisible-chars'))
  assert.ok(rules(audit(page('', '<meta name="keywords" content="hidden\u{E0041}tag">')), 'error').includes('invisible-chars'))
  assert.ok(!rules(audit(page('<p>10\u00A0km and 5\u202Fkg</p>'))).includes('invisible-chars'))
  assert.ok(!rules(audit('\uFEFF' + page(''))).includes('invisible-chars'), 'a leading BOM is file encoding, not content')
})

test('the answer-first note reports a direct opening and a vague one', () => {
  const direct = audit(page('').replace(/<p>[\s\S]*?<\/p>/, '<p>A canonical URL is the address search engines treat as the main copy of a page.</p>'))
  assert.ok(direct.some((x) => x.rule === 'answer-first' && /opens with a definition/.test(x.message)))
  const vague = audit(page('').replace(/<p>[\s\S]*?<\/p>/, '<p>Welcome to our blog, where we write about many different things for many readers.</p>'))
  assert.ok(vague.some((x) => x.rule === 'answer-first' && /preamble/.test(x.message)))
  assert.equal(openingKind('The tool tracks citations across five assistants every day.'), 'statement')
  assert.equal(openingKind('Have you ever wondered why rankings move? Here is why.'), 'question')
  assert.equal(openingKind('In this article we look at crawlers and how they work.'), 'preamble')
})

test('known myths in the visible text warn; correct statements and script content do not', () => {
  assert.ok(rules(audit(page('<p>No AI crawler renders JavaScript.</p>')), 'warn').includes('myth:no-ai-crawler-renders-javascript'))
  assert.ok(!rules(audit(page('<p>GPTBot does not render JavaScript, while Googlebot does.</p>'))).some((r) => r.startsWith('myth:')))
  assert.ok(!rules(audit(page('<script>var s = "No AI crawler renders JavaScript."</script>'))).some((r) => r.startsWith('myth:')))
})

test('URL mode: X-Robots-Tag and HTTP status come from the response', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/noindex') return send(res, 200, good, { 'x-robots-tag': 'noindex' })
    if (req.url === '/gone') return send(res, 404, good)
    if (req.url === '/moved') return send(res, 301, '', { location: '/guide' })
    return send(res, 200, good)
  })
  try {
    const noindex = await runJson(AUDIT, [`${srv.origin}/noindex`])
    assert.equal(noindex.code, 1)
    assert.ok(rules(noindex.json.findings, 'error').includes('x-robots-tag'))

    const plain = await runJson(AUDIT, [`${srv.origin}/guide`])
    assert.ok(!rules(plain.json.findings).includes('x-robots-tag'))
    assert.ok(!rules(plain.json.findings).includes('http-status'))

    const gone = await runJson(AUDIT, [`${srv.origin}/gone`])
    assert.ok(rules(gone.json.findings, 'error').includes('http-status'))

    const moved = await runJson(AUDIT, [`${srv.origin}/moved`])
    assert.ok(rules(moved.json.findings, 'info').includes('redirect'))
  } finally {
    await srv.close()
  }
})

test('file mode says X-Robots-Tag was not checked rather than passing it', async () => {
  const r = await runJson(AUDIT, [fixture('page-good.html')])
  assert.ok(r.json.findings.some((f) => f.rule === 'x-robots-tag' && f.level === 'not-checked'))
})

test('stdin works, and exit codes follow the contract', async () => {
  const fromStdin = await run(AUDIT, ['-', '--url', 'https://example.com/guide'], { stdin: good })
  assert.equal(fromStdin.code, 0, fromStdin.stdout)
  assert.match(fromStdin.stdout, /audit-page {2}stdin/)
  assert.equal((await run(AUDIT, [fixture('page-bad.html')])).code, 1)
  assert.equal((await run(AUDIT, ['--nope'])).code, 2)
  assert.equal((await run(AUDIT, ['ftp://example.com/'])).code, 2)
  assert.equal((await run(AUDIT, [])).code, 2)
  const missing = await run(AUDIT, [fixture('does-not-exist.html')])
  assert.equal(missing.code, 3)
  assert.match(missing.stdout, /NOT CHECKED/)
  const help = await run(AUDIT, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /usage:/)
})

test('an unreachable URL is not checked (exit 3), never a pass', async () => {
  const srv = await serve((req, res) => send(res, 200, ''))
  const origin = srv.origin
  await srv.close()
  const r = await run(AUDIT, [`${origin}/`, '--timeout', '3000'])
  assert.equal(r.code, 3)
  assert.match(r.stdout, /NOT CHECKED/)
})
