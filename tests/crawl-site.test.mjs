/**
 * crawl-site.mjs and lib/crawl.mjs, against a local HTTP server that plays a
 * small site with one of every defect the crawl must name. No test touches the
 * internet.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - lib/crawl.mjs analyseCrawl(): the `!state.linkCrawlComplete` guard on the
 *     orphan check removed, so a capped crawl reports orphans it cannot know
 *     about. Caught by "a capped crawl does not guess at orphans".
 *   - lib/crawl.mjs checkableFragment(): the "top" exemption removed. Caught by
 *     "fragments: a missing id is reported, #top and text fragments are not".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { analyseCrawl, checkableFragment, clickDepths, extractPage } from '../skills/seo-geo/scripts/lib/crawl.mjs'
import { SEO, run, runJson, rules, send, serve } from './helpers.mjs'

const CRAWL = join(SEO, 'crawl-site.mjs')

const page = ({ title = 'Page', description = 'A description of this page.', h1 = true, links = [], head = '', body = '' } = {}) =>
  `<!doctype html><html lang="en"><head>${title === null ? '' : `<title>${title}</title>`}${description === null ? '' : `<meta name="description" content="${description}">`}${head}</head>` +
  `<body><main>${h1 ? '<h1>Heading</h1>' : ''}${body}${links.map((l) => `<a href="${l}">link</a>`).join(' ')}</main></body></html>`

/**
 * The site:
 *   /            links to /a, /b, /broken, /old, /hop1, /a#present, /a#missing, /a#top, /noindex, /dup1, /dup2, /canon-other, off-site
 *   /a           has id="present"; links to /deep1
 *   /deep1..5    a chain of pages, so /deep4 is 5 clicks from the start and /deep5 is 6
 *   /old         301 to /a
 *   /hop1        302 to /hop2, 301 to /a
 *   /broken      404
 *   /noindex     noindex, and listed in the sitemap
 *   /dup1, /dup2 the same title and description
 *   /canon-other canonical to /a
 *   /b           no title, no description, no h1
 *   /orphan      in the sitemap, linked from nowhere
 *   /private/x   disallowed by robots.txt, linked from /b
 */
function site({ requests } = {}) {
  return serve((req, res, origin) => {
    requests?.push(req.url)
    const u = req.url
    if (u === '/robots.txt') return send(res, 200, `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`, { 'content-type': 'text/plain' })
    if (u === '/sitemap.xml') {
      const locs = ['/', '/a', '/b', '/noindex', '/orphan', '/dup1', '/dup2'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')
      return send(res, 200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`, { 'content-type': 'application/xml' })
    }
    switch (u) {
      case '/':
        return send(res, 200, page({ title: 'Home', links: ['/a', '/b', '/broken', '/old', '/hop1', '/a#present', '/a#missing', '/a#top', '/noindex', '/dup1', '/dup2', '/canon-other', 'https://example.org/elsewhere', 'mailto:someone@example.com'] }))
      case '/a':
        return send(res, 200, page({ title: 'A', body: '<h2 id="present">Present</h2>', links: ['/deep1', '/'] }))
      case '/b':
        return send(res, 200, page({ title: null, description: null, h1: false, links: ['/private/x'] }))
      case '/old':
        return send(res, 301, '', { location: '/a' })
      case '/hop1':
        return send(res, 302, '', { location: '/hop2' })
      case '/hop2':
        return send(res, 301, '', { location: '/a' })
      case '/noindex':
        return send(res, 200, page({ title: 'Hidden', head: '<meta name="robots" content="noindex">' }))
      case '/dup1':
      case '/dup2':
        return send(res, 200, page({ title: 'Same title', description: 'Same description for both.' }))
      case '/canon-other':
        return send(res, 200, page({ title: 'Canon', head: `<link rel="canonical" href="${origin}/a">` }))
      case '/orphan':
        return send(res, 200, page({ title: 'Orphan' }))
      case '/private/x':
        return send(res, 200, page({ title: 'Private' }))
      default: {
        const deep = u.match(/^\/deep(\d)$/)
        if (deep) {
          const n = Number(deep[1])
          return send(res, 200, page({ title: `Deep ${n}`, links: n < 5 ? [`/deep${n + 1}`] : [] }))
        }
        return send(res, 404, 'not found')
      }
    }
  })
}

const byRule = (json, rule) => json.findings.filter((f) => f.rule === rule)

test('a full crawl names every planted defect and exits 1', async () => {
  const requests = []
  const srv = await site({ requests })
  try {
    const r = await runJson(CRAWL, [srv.origin, '--retry-delay', '0'])
    assert.equal(r.code, 1, r.stdout)
    assert.equal(r.json.capped, false)
    const o = srv.origin

    const broken = byRule(r.json, 'broken-link')
    assert.equal(broken.length, 1)
    assert.match(broken[0].message, new RegExp(`${o}/broken answered HTTP 404`))
    assert.equal(broken[0].level, 'error')

    assert.ok(byRule(r.json, 'internal-redirect').some((f) => f.message.startsWith(`${o}/old redirects (301) to ${o}/a`)))
    assert.ok(byRule(r.json, 'redirect-chain').some((f) => f.message.startsWith(`${o}/hop1 redirects 2 times (302 > 301)`)))

    const frag = byRule(r.json, 'fragment-missing')
    assert.equal(frag.length, 1, 'only #missing; #present exists and #top is not an id')
    assert.match(frag[0].message, /#missing/)

    assert.ok(byRule(r.json, 'duplicate-title').some((f) => f.affects === 2 && /Same title/.test(f.message)))
    assert.ok(byRule(r.json, 'duplicate-description').some((f) => f.affects === 2))
    assert.ok(byRule(r.json, 'missing-title').some((f) => f.message.includes(`${o}/b`)))
    assert.ok(byRule(r.json, 'missing-description').some((f) => f.message.includes(`${o}/b`)))
    assert.ok(byRule(r.json, 'missing-h1').some((f) => f.message.includes(`${o}/b`)))

    assert.equal(byRule(r.json, 'noindex-in-sitemap')[0]?.level, 'error')
    assert.ok(byRule(r.json, 'noindex-linked').length === 1)
    assert.ok(byRule(r.json, 'canonical-elsewhere')[0].message.includes(`${o}/canon-other -> ${o}/a`))

    const orphan = byRule(r.json, 'sitemap-orphan')
    assert.equal(orphan[0]?.level, 'warn')
    assert.deepEqual(orphan[0].urls, [`${o}/orphan`])

    const notIn = byRule(r.json, 'not-in-sitemap')[0]
    assert.ok(notIn.urls.includes(`${o}/deep1`))
    assert.ok(!notIn.urls.includes(`${o}/canon-other`), 'a page canonicalised elsewhere does not belong in the sitemap')
    assert.ok(!notIn.urls.includes(`${o}/noindex`))

    const deep = byRule(r.json, 'deep-pages')[0]
    assert.deepEqual(deep.urls.sort(), [`${o}/deep4`, `${o}/deep5`])
    assert.equal(r.json.depth.distribution['0'], 1)

    assert.ok(byRule(r.json, 'robots-blocked').length === 1)
    assert.ok(!requests.includes('/private/x'), 'a disallowed URL is never fetched')
    assert.ok(!requests.some((x) => x.includes('elsewhere')), 'off-site links are not followed')

    // Ranked: within a level, the finding touching most URLs comes first.
    const warns = r.json.findings.filter((f) => f.level === 'warn')
    for (let i = 1; i < warns.length; i++) assert.ok(warns[i - 1].affects >= warns[i].affects)
  } finally {
    await srv.close()
  }
})

test('a capped crawl does not guess at orphans, and says what it did not fetch', async () => {
  const srv = await site()
  try {
    const r = await runJson(CRAWL, [srv.origin, '--max', '3', '--retry-delay', '0'])
    assert.equal(r.json.capped, true)
    assert.ok(r.json.fetched <= 3 + 2, 'the cap holds (a redirect can add its target page)')
    const orphan = byRule(r.json, 'sitemap-orphan')
    assert.equal(orphan.length, 1)
    assert.equal(orphan[0].level, 'not-checked')
    assert.equal(byRule(r.json, 'capped')[0].level, 'not-checked')
  } finally {
    await srv.close()
  }
})

test('the text report ranks findings and names the cap; --help and bad input', async () => {
  const srv = await site()
  try {
    const r = await run(CRAWL, [srv.origin, '--retry-delay', '0'])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /every internal link followed/)
    assert.match(r.stdout, /ERROR {2}broken-link/)
    assert.match(r.stdout, /click depth {2}0: 1/)
    assert.doesNotMatch(r.stdout, /\u2014/)
  } finally {
    await srv.close()
  }
  const help = await run(CRAWL, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--max <n>/)
  assert.equal((await run(CRAWL, [])).code, 2)
  assert.equal((await run(CRAWL, ['https://example.com', '--max', 'lots'])).code, 2)
  assert.equal((await run(CRAWL, ['https://example.com', '--nope'])).code, 2)
})

test('a start URL that does not answer is not checked, exit 3', async () => {
  const srv = await serve((req, res) => send(res, 200, '', {}))
  const origin = srv.origin
  await srv.close()
  const r = await runJson(CRAWL, [origin, '--timeout', '2000', '--retry-delay', '0'])
  assert.equal(r.code, 3)
  assert.equal(r.json.checked, false)
})

test('robots.txt that disallows the start URL stops the crawl before any page is fetched', async () => {
  const requests = []
  const srv = await serve((req, res) => {
    requests.push(req.url)
    if (req.url === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' })
    return send(res, 200, page())
  })
  try {
    const r = await runJson(CRAWL, [srv.origin])
    assert.equal(r.code, 3)
    assert.match(r.json.reason, /disallows/)
    assert.deepEqual(requests, ['/robots.txt'])
    const own = await runJson(CRAWL, [srv.origin, '--ignore-robots', '--retry-delay', '0'])
    assert.equal(own.json.checked, true)
  } finally {
    await srv.close()
  }
})

test('extractPage reads the fields, links, ids and noindex a crawl needs', () => {
  const html = `<!doctype html><html><head><title> A  &amp; B </title><base href="https://example.com/docs/">
    <meta name="description" content="Desc"><link rel="canonical" href="page">
    <meta name="robots" content="max-image-preview:large"><meta name="googlebot" content="noindex"></head>
    <body><h1>T</h1><p id="one">x</p><a name="two"></a>
    <a href="other#Sec%20tion">o</a><a href="mailto:a@example.com">m</a><a href="javascript:void(0)">j</a>
    <script>document.write('<a href="/from-script">s</a>')</script></body></html>`
  const f = extractPage(html, 'https://example.com/docs/page')
  assert.equal(f.title, 'A & B')
  assert.equal(f.description, 'Desc')
  assert.equal(f.h1Count, 1)
  assert.equal(f.canonical, 'https://example.com/docs/page')
  assert.match(f.noindex, /googlebot/)
  assert.ok(f.ids.has('one') && f.ids.has('two'))
  assert.deepEqual(f.links, [{ url: 'https://example.com/docs/other', fragment: 'Sec tion' }])
})

test('fragments: a missing id is reported, #top and text fragments are not', () => {
  assert.equal(checkableFragment('top'), false)
  assert.equal(checkableFragment(''), false)
  assert.equal(checkableFragment(':~:text=hello'), false)
  assert.equal(checkableFragment('!/route'), false)
  assert.equal(checkableFragment('section-2'), true)
})

test('click depth is the fewest clicks, and a redirect counts as a hop', () => {
  const edges = new Map([
    ['s', new Set(['a', 'b'])],
    ['a', new Set(['c'])],
    ['b', new Set(['c', 'r'])],
    ['r', new Set(['d'])],
  ])
  const d = clickDepths(['s'], edges)
  assert.equal(d.get('c'), 2)
  assert.equal(d.get('d'), 3)
  assert.equal(d.has('z'), false)
})

test('analyseCrawl: duplicates ignore noindex and canonicalised pages', () => {
  const p = (key, facts) => ({ key, status: 200, chain: [], finalKey: key, facts: { title: 'T', description: 'D', h1Count: 1, canonical: null, noindex: null, ids: new Set(), links: 0, ...facts } })
  const pages = new Map([
    ['https://example.com/', p('https://example.com/')],
    ['https://example.com/x', p('https://example.com/x', { noindex: 'meta robots (search engines)' })],
    ['https://example.com/y', p('https://example.com/y', { canonical: 'https://example.com/' })],
  ])
  const state = { pages, inlinks: new Map(), fragments: new Map(), edges: new Map(), startKeys: ['https://example.com/'], sitemap: null, sitemapRead: false, capped: false, linkCrawlComplete: true, max: 200 }
  const f = analyseCrawl(state)
  assert.ok(!rules(f).includes('duplicate-title'))
  assert.ok(rules(f, 'not-checked').includes('sitemap-coverage'))
})
