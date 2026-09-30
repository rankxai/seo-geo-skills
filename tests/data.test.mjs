/**
 * The data files and the myth scan.
 *
 * Every myth has sentences it must catch and correct sentences it must leave
 * alone, because a pattern that fires on correct copy teaches people to
 * ignore the check. A correct sentence must fire no myth at all, not only
 * its own.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - myths.json geo-paper-cite-sources-top-40: the lookbehind that excludes
 *     "30-40%" removed. Caught by the correct sentence "In the GEO paper,
 *     citing sources was one of three methods that gained 30-40%".
 *   - lib/myths.mjs findMyths(): normalise() dropped, so curly apostrophes
 *     reach the patterns raw. Caught by "patterns see through typographic
 *     apostrophes".
 *   - myths.json: the negation lookbehind written as \b(?:n't|not...), where
 *     \b can never sit inside "don't". Caught by the correct sentences
 *     "You don't need an llms.txt file to appear in AI Overviews" and
 *     "You don't need to rank on the first page to be cited in AI Overviews".
 *   - myths.json google-penalises-ai-content: the trailing lookahead that
 *     spares qualified claims ("... that exist only to manipulate rankings")
 *     removed. Caught by that correct sentence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findMyths, loadMyths, staleMyths } from '../skills/seo-geo/scripts/lib/myths.mjs'
import { ROOT } from './helpers.mjs'

const DATA = join(ROOT, 'skills', 'seo-geo', 'data')
const readJson = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'))
const ids = (text) => [...new Set(findMyths(text).map((h) => h.id))]
const DATE = /^\d{4}-\d{2}-\d{2}$/
const sortedByDate = (rows) => rows.every((u, i) => i === 0 || rows[i - 1].date <= u.date)

const CASES = {
  'aio-opt-out-only-snippet-controls': {
    catch: ['To stay out of AI Overviews, use only snippet controls.'],
    pass: ['Snippet controls and noindex work per page; the Search Console setting works per site.'],
  },
  'google-extended-outside-search': {
    catch: ['Google-Extended only controls training for Gemini apps outside Google Search.'],
    pass: ['Google-Extended governs training, not whether a page appears in AI Overviews.'],
  },
  'no-ai-crawler-renders-javascript': {
    catch: ['No AI crawler executes JavaScript.', 'AI crawlers don’t execute JavaScript.'],
    pass: ['GPTBot and ClaudeBot do not execute JavaScript; Googlebot and Applebot do.'],
  },
  'gen-ai-report-subset-of-sites': {
    catch: ['The Generative AI performance report is only available to a subset of sites.'],
    pass: ['The Generative AI performance report is available to every site.'],
  },
  'schema-citation-lift': {
    catch: ['Schema gives a 22% citation lift.', 'Adding schema markup boosts your AI citations.', 'Structured data increases citations in ChatGPT.'],
    pass: [
      'Schema had no measurable effect on citations in a matched study.',
      'Schema markup did not increase AI citations in a matched study.',
      'Structured data helps with rich results; citations are a separate question.',
    ],
  },
  'faq-rich-results-restricted-not-retired': {
    catch: ['FAQ rich results are only shown to government and health sites.'],
    pass: ['FAQ rich results were retired in May 2026.'],
  },
  'overlap-11-percent-misattributed': {
    catch: ['Only 11% of domains cited by ChatGPT also appear in AI Overviews.'],
    pass: ['Only 11% of cited domains overlap between ChatGPT and Perplexity.'],
  },
  'geo-paper-cite-sources-top-40': {
    catch: ['The GEO paper found that citing sources boosts visibility by 40%.'],
    pass: [
      'Cite Sources, Quotation Addition and Statistics Addition achieved 30-40% in the GEO paper.',
      'In the GEO paper, citing sources was one of three methods that gained 30-40%.',
    ],
  },
  'geo-paper-134-167-words': {
    catch: ['The ideal passage is 134-167 words long.'],
    pass: ['We checked 134 pages over 167 days.'],
  },
  'llms-txt-helps-google': {
    catch: [
      'Adding llms.txt improves your Google rankings.',
      'An llms.txt file is now required to appear in AI Overviews.',
      'You need an llms.txt file to show up in Google AI Mode.',
    ],
    pass: [
      'llms.txt does not improve Google rankings.',
      'You don’t need an llms.txt file to appear in AI Overviews.',
      'An llms.txt file is not required for Google Search, though other tools may read it.',
    ],
  },
  'chunking-required-for-google': {
    catch: [
      'You must break your content into small chunks so Google AI Overviews can use it.',
      'AI Overviews only understand chunked content.',
    ],
    pass: [
      'There is no requirement to break content into tiny pieces for Google.',
      'You don’t need to split pages into small chunks for AI Overviews.',
      'Short sections can help readers scan a long page.',
    ],
  },
  'schema-required-for-ai-overviews': {
    catch: ['Add FAQ schema to get into AI Overviews.', 'Structured data is required for AI Overviews.', 'FAQPage markup helps you win AI Mode citations.'],
    pass: [
      'Structured data isn’t required for AI Overviews.',
      'FAQ schema no longer earns a rich result and is not needed for AI Overviews.',
      'Structured data is required for rich results such as Product snippets.',
    ],
  },
  'ai-overviews-only-top-10': {
    catch: [
      'AI Overviews only cite pages from the top 10 organic results.',
      'Only pages that rank in the top 10 can appear in AI Overviews.',
      'You need to rank on the first page to be cited in AI Overviews.',
    ],
    pass: [
      'Pages outside the top 10 can still be cited in AI Overviews.',
      'AI Overviews often cite pages that also rank in the top 10.',
      'You don’t need to rank on the first page to be cited in AI Overviews.',
    ],
  },
  'eeat-ranking-factor-score': {
    catch: ['E-E-A-T is a direct ranking factor.', 'Google assigns every page an E-E-A-T score.'],
    pass: [
      'E-E-A-T itself isn’t a specific ranking factor.',
      'Google does not assign an E-E-A-T score.',
      'Raters use E-E-A-T to judge quality, and Google uses a mix of signals that align with it.',
    ],
  },
  'google-penalises-ai-content': {
    catch: ['Google penalises AI-generated content.', 'AI-written articles are automatically penalized by Google.', 'AI-generated content is against Google’s guidelines.'],
    pass: [
      'Google does not penalise AI-generated content as such.',
      'Google penalises scaled content abuse, whether AI-generated or not.',
      'Google demotes AI-generated pages that exist only to manipulate rankings.',
      'AI-generated content is penalised when it is mass-produced without adding value.',
    ],
  },
  'core-web-vitals-major-factor': {
    catch: ['Core Web Vitals are a major ranking factor.', 'Passing Core Web Vitals will boost your rankings.'],
    pass: [
      'Core Web Vitals are used by Google’s ranking systems, but relevance comes first.',
      'Good Core Web Vitals don’t guarantee top rankings.',
      'Core Web Vitals are a minor ranking signal.',
    ],
  },
  'google-extended-removes-ai-overviews': {
    catch: [
      'Blocking Google-Extended removes your site from AI Overviews.',
      'Google-Extended controls whether your site appears in AI Overviews.',
    ],
    pass: [
      'Blocking Google-Extended does not remove a site from AI Overviews.',
      'Google-Extended governs training, not whether a page appears in AI Overviews.',
      'Disallowing Google-Extended limits training; the Search Console setting removes a site from AI Overviews.',
    ],
  },
}

test('every myth catches its wrong sentences and leaves correct copy alone', () => {
  const { myths } = loadMyths()
  assert.deepEqual(myths.map((m) => m.id).sort(), Object.keys(CASES).sort(), 'add a CASES row for every myth')
  for (const [id, { catch: wrong, pass }] of Object.entries(CASES)) {
    assert.ok(wrong.length > 0 && pass.length > 0, id)
    for (const s of wrong) assert.ok(ids(s).includes(id), `${id} missed: ${s}`)
    for (const s of pass) assert.deepEqual(ids(s), [], `fired on correct copy: ${s}`)
  }
})

test('patterns see through typographic apostrophes', () => {
  assert.ok(ids('AI crawlers don\u2019t execute JavaScript.').includes('no-ai-crawler-renders-javascript'))
})

test('every myth carries its evidence and compiles', () => {
  const data = readJson('myths.json')
  for (const m of data.myths) {
    assert.match(m.id, /^[a-z0-9-]+$/)
    assert.ok(['wrong-claim', 'measured-not-to-work'].includes(m.kind), m.id)
    assert.ok(m.why.length > 40, m.id)
    assert.match(m.source, /^https:\/\//, m.id)
    assert.match(m.checked, /^\d{4}-\d{2}-\d{2}$/, m.id)
    assert.ok(m.patterns.length > 0, m.id)
    for (const p of m.patterns) assert.doesNotThrow(() => new RegExp(p.source, p.flags), m.id)
    assert.ok(!('allow' in m), 'allow lists are site-specific and do not belong in the public data')
  }
})

test('a stale checked date is reported, not fatal', () => {
  const far = new Date(Date.now() + 400 * 86_400_000)
  assert.ok(staleMyths(far).length > 0)
  assert.equal(staleMyths(new Date('2026-09-30T00:00:00Z')).length, 0)
})

test('crawlers.json rows are complete and tokens are unique', () => {
  const data = readJson('crawlers.json')
  const tokens = data.bots.filter((b) => b.token).map((b) => b.token.toLowerCase())
  assert.equal(new Set(tokens).size, tokens.length)
  for (const b of data.bots) {
    for (const k of ['vendor', 'token', 'ua', 'constructed', 'purpose', 'purposeLine', 'robots', 'robotsNote', 'verify', 'docsUrl']) assert.ok(k in b, `${b.token ?? b.label} lacks ${k}`)
    assert.ok(Object.keys(data.purposes).includes(b.purpose))
    assert.ok(Object.keys(data.robotsValues).includes(b.robots))
    if (b.purpose === 'control-token') assert.equal(b.ua, null, `${b.token} is a control token and must not be probed`)
    if (b.docsUrl) assert.match(b.docsUrl, /^https:\/\//)
    if (!b.token) assert.ok(b.label, 'a row with no token needs a label')
    if (b.constructed) assert.ok(b.ua, `${b.token}: constructed says the ua was assembled, so there must be one`)
    if (b.verify) assert.match(b.verify.url, /^https:\/\//, `${b.token ?? b.label} verify url`)
    for (const t of b.fallback?.tokens ?? []) assert.ok(tokens.includes(t.toLowerCase()), `${b.token} falls back to ${t}, which is not on the roster`)
  }
  assert.match(data.last_verified, DATE)
})

test('crawlers.json carries the search bots that AI answers are grounded on', () => {
  const data = readJson('crawlers.json')
  const row = (t) => data.bots.find((b) => b.token === t)
  for (const t of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot']) assert.equal(row(t)?.purpose, 'search', t)
  assert.match(row('Bingbot').purposeLine, /Copilot/)
  assert.deepEqual(row('Google-CloudVertexBot').fallback.tokens, ['Googlebot'])
  for (const t of ['OAI-AdsBot', 'meta-externalads', 'GoogleOther']) assert.equal(row(t), undefined, `${t} is out of scope by the notes`)
})

test('google-changes.json entries cite a Google-owned page with a verbatim quote, in date order', () => {
  const data = readJson('google-changes.json')
  assert.match(data.provenance, /AgriciDaniel\/claude-seo/)
  assert.match(data.last_verified, DATE)
  assert.ok(sortedByDate(data.updates), 'keep updates sorted by date')
  const kinds = new Set(['core', 'spam', 'policy', 'schema', 'documentation', 'product', 'crawling'])
  for (const u of data.updates) {
    assert.match(u.date, DATE)
    assert.ok(kinds.has(u.kind), `${u.name}: kind ${u.kind}`)
    assert.match(new URL(u.source).host, /(?:^|\.)google\.com$/, u.name)
    assert.ok(u.verified && u.verified.length > 10, u.name)
    if ('ended' in u) assert.ok(u.ended === 'ongoing' || (DATE.test(u.ended) && u.ended >= u.date), `${u.name}: ended ${u.ended}`)
    assert.ok(u.date <= data.last_verified, `${u.name} is dated after last_verified`)
  }
})

test('ai-platform-changes.json entries cite the vendor\'s own domain with a verbatim quote, in date order', () => {
  const data = readJson('ai-platform-changes.json')
  for (const k of ['about', 'policy', 'last_verified', 'updates']) assert.ok(k in data, `lacks ${k}`)
  assert.match(data.last_verified, DATE)
  assert.ok(data.updates.length > 0)
  assert.ok(sortedByDate(data.updates), 'keep updates sorted by date')
  const owned = {
    OpenAI: /(?:^|\.)(?:openai\.com|chatgpt\.com)$/,
    Anthropic: /(?:^|\.)(?:anthropic\.com|claude\.com|claude\.ai)$/,
    Perplexity: /(?:^|\.)(?:perplexity\.ai|perplexity\.com)$/,
    Microsoft: /(?:^|\.)(?:microsoft\.com|bing\.com|indexnow\.org)$/,
    Apple: /(?:^|\.)apple\.com$/,
    Meta: /(?:^|\.)(?:meta\.com|facebook\.com|fb\.com)$/,
    Cloudflare: /(?:^|\.)cloudflare\.com$/,
  }
  for (const u of data.updates) {
    for (const k of ['date', 'vendor', 'name', 'kind', 'source', 'notes', 'verified']) assert.ok(u[k], `${u.name ?? u.date} lacks ${k}`)
    assert.match(u.date, DATE)
    assert.ok(u.date <= data.last_verified, `${u.name} is dated after last_verified`)
    assert.ok(owned[u.vendor], `${u.name}: unknown vendor ${u.vendor}`)
    assert.match(new URL(u.source).host, owned[u.vendor], `${u.name}: source is not on ${u.vendor}'s own domain`)
    assert.ok(u.verified.length > 10 && u.verified.length < 400, `${u.name}: quote length`)
  }
})

test('shipped scripts and data carry no site-specific names, em dashes or hidden characters', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  const files = [
    ...walk(join(ROOT, 'skills', 'seo-geo', 'scripts')),
    ...walk(join(ROOT, 'skills', 'seo-geo', 'data')),
    ...walk(join(ROOT, 'skills', 'content-review', 'scripts')),
    ...walk(join(ROOT, 'tests')),
  ]
  const banned = [/rankxai\.com/i, /\bRankX\b/]
  const bad = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (/[\u2014\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(text)) bad.push(`${f}: literal em dash or hidden character`)
    if (f.endsWith('data.test.mjs')) continue
    for (const re of banned) if (re.test(text)) bad.push(`${f}: ${re}`)
  }
  assert.deepEqual(bad, [])
})
