/**
 * The page rules behind audit-page.mjs, as a pure function over HTML so the
 * tests can pin the shipped logic rather than a copy of it.
 *
 * Levels follow one principle: ERROR only where the page is measurably broken
 * for search or AI retrieval whatever the author intended (no text in the
 * HTML, no title, asking not to be indexed, JSON-LD that does not parse,
 * conflicting canonicals, past Googlebot's fetch limit, hidden characters).
 * WARN where the rule has good evidence but the author may have a reason.
 * INFO for facts worth seeing that are not problems. The evidence for each
 * rule is next to it.
 */

import {
  bodyOf,
  findInvisible,
  findTags,
  headOf,
  maskRawText,
  proseFromHtml,
  stripComments,
  summariseCodePoints,
  visibleText,
  withoutNonText,
  wordCount,
  decodeEntities,
} from './html.mjs'
import { mythFindings } from './myths.mjs'
import { parseIndexingDirectives, readIndexing } from './robots.mjs'

/**
 * Googlebot "crawls the first 2MB of a supported file type" and the limit
 * applies to uncompressed data (Google, "Googlebot", last updated 3 Feb 2026:
 * https://developers.google.com/search/docs/crawling-indexing/googlebot).
 * Content past the cut is not indexed. 2 MB is read as 2,000,000 bytes, the
 * smaller of the two readings, so the check errs early rather than late.
 * The warning at half the limit leaves room for a page that grows.
 */
export const HTML_WARN_BYTES = 1_000_000
export const HTML_ERROR_BYTES = 2_000_000

/**
 * A page whose raw HTML carries almost no text was rendered in the browser.
 * GPTBot, ClaudeBot and PerplexityBot do not run JavaScript, so for them the
 * page is empty. Googlebot, Bingbot and Applebot do render, but later and not always.
 * 500 characters is well under any real article and well over an app shell.
 */
export const MIN_TEXT_CHARS = 500

/**
 * Schema types Google no longer shows any rich result for. Harmless to other
 * consumers, but a page that carries them for Google is carrying dead weight.
 *   HowTo                             rich result removed September 2023
 *   SpecialAnnouncement               removed 2025
 *   OccupationAggregationByEmployer   estimated salary, removed 2025
 * Source: https://developers.google.com/search/updates and Google's June 2025
 * post on simplifying search results.
 */
export const RETIRED_TYPES = new Map([
  ['HowTo', 'Google removed HowTo rich results in September 2023'],
  ['SpecialAnnouncement', 'Google retired the SpecialAnnouncement rich result in 2025'],
  ['OccupationAggregationByEmployer', 'Google retired the estimated salary rich result in 2025'],
])

/**
 * FAQPage: Google stopped showing FAQ rich results on 7 May 2026
 * (https://developers.google.com/search/updates). The markup is harmless and
 * other consumers may read it, so this is information, not a fault.
 */
export const NO_RICH_RESULT_TYPES = new Map([
  ['FAQPage', 'no Google rich result since 7 May 2026; harmless, and other consumers may still read it'],
  ['ClaimReview', 'Google is phasing ClaimReview out of Search; Fact Check Explorer still reads it'],
  ['Dataset', 'used by Google Dataset Search, not by Google Search results'],
])

/** Values in structured data that mean a template shipped unfilled. */
const PLACEHOLDER = /\b(?:lorem ipsum|TODO|TBD|FIXME)\b|^(?:undefined|null|NaN)$|\[object Object\]|\{\{[^}]*\}\}|%%[a-z_]+%%/i

/** Every @type in a parsed JSON-LD value, through arrays and @graph. */
export function ldTypes(node, acc = new Set()) {
  if (Array.isArray(node)) for (const n of node) ldTypes(n, acc)
  else if (node && typeof node === 'object') {
    const t = node['@type']
    for (const one of Array.isArray(t) ? t : t ? [t] : []) acc.add(String(one).replace(/^https?:\/\/schema\.org\//, ''))
    for (const v of Object.values(node)) ldTypes(v, acc)
  }
  return acc
}

function ldStrings(node, acc = []) {
  if (typeof node === 'string') acc.push(node)
  else if (Array.isArray(node)) for (const n of node) ldStrings(n, acc)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) ldStrings(v, acc)
  return acc
}

/** A URL in comparable form: lower-case host, no default port, no fragment. */
export function normaliseUrl(u) {
  const url = new URL(u)
  url.hash = ''
  return url.href
}

/** Read a header from a fetch Headers object or a plain object. */
function header(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v.join(', ') : (v ?? null)
}

/** The first sentence-bearing paragraph: skips bylines and empty wrappers. */
function firstParagraph(html) {
  const scope = html.match(/<main\b[\s\S]*?<\/main\s*>/i)?.[0] ?? html.match(/<article\b[\s\S]*?<\/article\s*>/i)?.[0] ?? html
  for (const m of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim()
    if (wordCount(text) >= 8) return text
  }
  return null
}

/**
 * How the first paragraph opens, as one of four kinds:
 *   definition  "X is ...", "X means ...", "X refers to ..."
 *   statement   any other plain declarative sentence
 *   question    the first sentence is a question
 *   preamble    a throat-clearing opener ("Welcome to", "Have you ever",
 *               "In this article", "Imagine")
 * A heuristic, reported for information only. The evidence for answering
 * first is about retrieval (engines extract passages, and model accuracy
 * falls for information buried mid-context), not about this regex.
 */
const DEFINITIONAL = /^[^.?!]{0,140}?\b(?:is|are|means|refers to|describes|is defined as)\b/i
const PREAMBLE = /^(?:welcome\b|have you\b|ever wondered|imagine\b|are you\b|do you\b|in this (?:article|post|guide)\b|in today's\b|let's\b|when it comes to\b|if you've ever\b|we've all\b|picture this\b)/i

export function openingKind(paragraph) {
  const first = String(paragraph).trim().split(/(?<=[.!?])\s+/)[0] ?? ''
  if (/\?$/.test(first)) return 'question'
  if (PREAMBLE.test(first)) return 'preamble'
  if (DEFINITIONAL.test(first)) return 'definition'
  return 'statement'
}
const OPENING_TEXT = {
  definition: 'opens with a definition',
  statement: 'opens with a plain statement, not a question or preamble',
  question: 'opens with a question rather than an answer',
  preamble: 'opens with a preamble rather than an answer',
}

/**
 * Elements the HTML parser allows inside <head>. Anything else (an <img>, a
 * <div>, an <iframe>, a custom element) makes a browser, and Google, close the
 * head right there: every <meta> and <link> after it is read as body. Google
 * accepts rel=canonical only in the head and asks for "at least the <head>
 * section" to be valid HTML
 * (https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls).
 */
const HEAD_ELEMENTS = new Set(['html', 'head', 'title', 'meta', 'link', 'script', 'style', 'base', 'noscript', 'template'])

/** The first element in `head` that cannot be there, as { tag, index }, or null. */
export function firstInvalidHeadElement(head) {
  for (const m of head.matchAll(/<([a-z][a-z0-9-]*)\b/gi)) {
    const tag = m[1].toLowerCase()
    if (!HEAD_ELEMENTS.has(tag)) return { tag, index: m.index }
  }
  return null
}

/** Every URL a Link header marks rel=canonical. */
export function linkHeaderCanonicals(value) {
  const out = []
  for (const m of String(value ?? '').matchAll(/<([^>]*)>((?:\s*;\s*[a-z*-]+\s*=\s*(?:"[^"]*"|[^;,]*))*)/gi)) {
    const rel = m[2].match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]*))/i)
    if (rel && (rel[1] ?? rel[2]).toLowerCase().split(/\s+/).includes('canonical')) out.push(m[1].trim())
  }
  return out
}

/** A meta refresh's delay and target, or null. */
export function metaRefresh(content) {
  const m = String(content ?? '').match(/^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(['"]?)(.*?)\2\s*$/i)
  if (!m) return null
  return { seconds: m[1] === undefined ? 0 : Number(m[1]), url: m[3] || null }
}

const resolveUrl = (href, base) => {
  try {
    return new URL(href, base ?? undefined).href
  } catch {
    return null
  }
}

/**
 * Run every page rule over `html`.
 * ctx: { url?, finalUrl?, headers?, bytes?, truncated?, source: 'url'|'file'|'stdin', now? }
 */
export function auditHtml(rawHtml, ctx = {}) {
  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  const html = String(rawHtml).replace(/^\uFEFF/, '')
  const clean = stripComments(html)
  // Structure is read from a copy with script, style, template and noscript
  // CONTENT removed, so markup written inside a script string is not markup.
  const masked = maskRawText(clean)
  const head = headOf(masked)
  const body = bodyOf(masked)
  const bodyText = withoutNonText(body)
  const pageUrl = ctx.finalUrl || ctx.url || null
  const now = ctx.now ?? new Date()
  const facts = { url: pageUrl }

  // <base href> changes what every relative URL on the page resolves against.
  const baseHref = findTags(head, 'base').find((t) => t.attrs.has('href'))?.attrs.get('href')
  const base = baseHref ? (resolveUrl(baseHref, pageUrl) ?? pageUrl) : pageUrl
  if (baseHref) facts.base = base

  // ---- Server-rendered text --------------------------------------------
  const text = visibleText(masked)
  facts.textChars = text.length
  facts.words = wordCount(text)
  const frames = /<frameset\b/i.test(masked) ? findTags(masked, 'frame').map((t) => t.attrs.get('src')).filter(Boolean) : []
  if (text.length < MIN_TEXT_CHARS && frames.length) {
    add('error', 'server-text', `this URL is a frameset with ${text.length} characters of its own text; the content lives in the framed documents (${frames.slice(0, 3).join(', ')}). A crawler that fetches this URL, and an AI assistant that cites it, gets no content. Serve the content at this URL.`)
  } else if (text.length < MIN_TEXT_CHARS) {
    add('error', 'server-text', `only ${text.length} characters of visible text in the HTML. Crawlers that do not run JavaScript (GPTBot, ClaudeBot, PerplexityBot) see an almost empty page. Render the content on the server.`)
  } else {
    add('info', 'server-text', `${text.length} characters (${facts.words} words) of visible text in the raw HTML`)
  }

  // ---- Size ---------------------------------------------------------------
  const bytes = ctx.bytes ?? Buffer.byteLength(html, 'utf8')
  facts.bytes = bytes
  const mb = (bytes / 1e6).toFixed(2)
  const atLeast = ctx.truncated ? 'at least ' : ''
  if (bytes > HTML_ERROR_BYTES) add('error', 'html-size', `HTML is ${atLeast}${mb} MB uncompressed; Googlebot indexes only the first 2 MB of an HTML file`)
  else if (bytes > HTML_WARN_BYTES) add('warn', 'html-size', `HTML is ${mb} MB uncompressed, over half of Googlebot's 2 MB fetch limit`)

  // ---- Language and landmarks ----------------------------------------------
  const htmlTag = findTags(masked, 'html')[0]
  facts.lang = htmlTag?.attrs.get('lang') || null
  if (!facts.lang) add('warn', 'html-lang', '<html> has no lang attribute. Screen readers and search engines use it to identify the language.')
  if (!/<main\b/i.test(bodyText) && !/role\s*=\s*["']?main\b/i.test(bodyText)) {
    add('warn', 'main-landmark', 'no <main> landmark. It tells assistive technology, and extractors that look for the primary content, where the content starts.')
  }

  // ---- Headings -------------------------------------------------------------
  const headings = [...bodyText.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]))
  facts.headings = headings.length
  const h1s = headings.filter((h) => h === 1).length
  facts.h1Count = h1s
  if (h1s === 0) add('warn', 'one-h1', 'no <h1>. One h1 naming the page topic is the clearest signal of what the page is about.')
  else if (h1s > 1) add('warn', 'one-h1', `${h1s} <h1> elements. Google copes with several, but one h1 keeps the page's topic unambiguous for extractors and screen readers.`)
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i] - headings[i - 1] > 1) {
      add('warn', 'heading-levels', `heading level skipped: h${headings[i - 1]} then h${headings[i]}. Skipped levels break the outline that screen readers and passage extractors rely on.`)
      break
    }
  }

  // ---- Title ------------------------------------------------------------------
  // Length is information, not a fault: Google says there is no limit on how
  // long a title element can be, and truncates the title link to the device
  // width (Google, "Influencing your title links").
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].map((m) => decodeEntities(m[1]).replace(/\s+/g, ' ').trim())
  facts.title = titles[0] ?? null
  if (!titles.length && /<title\b/i.test(head)) add('error', 'title', '<title> is never closed. Browsers read everything after it as the title text, so the page has no usable title; add </title>.')
  else if (!titles.length || !titles[0]) add('error', 'title', 'no <title>. Search results and AI citations show it as the page name.')
  else {
    if (titles.length > 1) add('warn', 'title', `${titles.length} <title> elements; browsers and crawlers use the first`)
    if (titles[0].length > 60) add('info', 'title-length', `title is ${titles[0].length} characters; around 60 fits most desktop results (Google sets no limit and truncates the title link by width), so put the words that matter first`)
  }

  // ---- Meta description ---------------------------------------------------------
  const descs = findTags(head, 'meta').filter((t) => (t.attrs.get('name') || '').toLowerCase() === 'description')
  const desc = descs[0]?.attrs.get('content')?.trim() ?? null
  facts.description = desc
  if (!desc) add('warn', 'meta-description', 'no meta description. Google writes its own snippet more often than not, but without one it always does.')
  else {
    if (descs.length > 1) add('warn', 'meta-description', `${descs.length} meta descriptions; only one is used`)
    if (desc.length > 160) add('info', 'meta-description-length', `description is ${desc.length} characters; around 150 to 160 fits most desktop results (Google sets no limit and truncates by width)`)
    else if (desc.length < 50) add('info', 'meta-description-length', `description is only ${desc.length} characters`)
  }

  // ---- A <head> that ends early ---------------------------------------------------
  const invalid = firstInvalidHeadElement(head)
  if (invalid) {
    const after = head.slice(invalid.index)
    const lost = []
    if (findTags(after, 'link').some((t) => /(?:^|\s)canonical(?:\s|$)/i.test(t.attrs.get('rel') || ''))) lost.push('rel=canonical')
    if (findTags(after, 'meta').some((t) => /^(?:robots|googlebot|bingbot)$/i.test(t.attrs.get('name') || ''))) lost.push('robots meta')
    if (findTags(after, 'link').some((t) => t.attrs.has('hreflang'))) lost.push('hreflang')
    if (/<title\b/i.test(after)) lost.push('<title>')
    if (lost.length) add('warn', 'head-invalid', `<${invalid.tag}> inside <head> ends the head for browsers and Google's parser, so the ${lost.join(', ')} after it ${lost.length > 1 ? 'are' : 'is'} read as part of the body, where Google ignores a canonical. Move <${invalid.tag}> into the <body> or below them.`)
    else add('info', 'head-invalid', `<${invalid.tag}> inside <head> ends the head early; nothing that matters for search comes after it, but it is invalid HTML`)
  }

  // ---- Canonical --------------------------------------------------------------------
  // Google accepts rel=canonical only in the <head> or a Link header, treats
  // several conflicting ones as no signal at all, and recommends absolute URLs.
  // https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
  const isCanonical = (t) => (t.attrs.get('rel') || '').toLowerCase().split(/\s+/).includes('canonical')
  const headCanonTags = findTags(head, 'link').filter(isCanonical)
  const emptyCanon = headCanonTags.filter((t) => !(t.attrs.get('href') ?? '').trim())
  const headCanon = headCanonTags.map((t) => (t.attrs.get('href') ?? '').trim()).filter(Boolean)
  const bodyCanon = findTags(body, 'link').filter(isCanonical)
  const headerCanon = ctx.source === 'url' ? linkHeaderCanonicals(header(ctx.headers, 'link')) : []
  const declared = [...headCanon.map((href) => ({ href, from: 'head' })), ...headerCanon.map((href) => ({ href, from: 'Link header' }))]
  facts.canonical = declared[0]?.href ?? null
  if (headerCanon.length) facts.canonicalHeader = headerCanon[0]
  if (emptyCanon.length) add('warn', 'canonical', `${emptyCanon.length} rel=canonical with an empty href; Google ignores it`)
  if (bodyCanon.length) add('warn', 'canonical', `${bodyCanon.length} rel=canonical link(s) in the <body>; Google ignores a canonical outside the <head>`)
  // Compare what each one POINTS AT, so "/p" and "https://example.com/p" on the same page agree.
  const resolvedCanon = [...new Set(declared.map((c) => (base ? resolveUrl(c.href, base) : c.href) ?? c.href).map((u) => (/^https?:/i.test(u) ? normaliseUrl(u) : u)))]
  if (declared.length === 0) {
    if (!emptyCanon.length) add('warn', 'canonical', 'no rel=canonical. Search engines then pick the canonical URL themselves.')
  } else if (resolvedCanon.length > 1) {
    add('error', 'canonical', `${declared.length} canonical declarations point at ${resolvedCanon.length} different URLs (${declared.map((c) => `${c.href} in the ${c.from}`).join(', ')}). Google may ignore all of them.`)
  } else {
    if (declared.length > 1) add('info', 'canonical', `${declared.length} canonical declarations, all pointing at the same URL; one is enough`)
    const href = declared[0].href
    if (!/^https?:\/\//i.test(href)) add('warn', 'canonical', `canonical "${href}" is not an absolute URL; Google recommends absolute URLs${baseHref ? `, and this one resolves against <base href="${baseHref}">, not the page URL` : ''}`)
    if (pageUrl) {
      const target = resolveUrl(href, base)
      if (!target || !/^https?:/i.test(target)) add('error', 'canonical', `canonical "${href}" is not a valid http(s) URL`)
      else {
        const t = normaliseUrl(target)
        const self = normaliseUrl(pageUrl)
        const selfNoQuery = self.replace(/\?.*$/, '')
        if (t === self) add('info', 'canonical', 'canonical points at this URL')
        else if (t.replace(/\/$/, '') === self.replace(/\/$/, '')) add('warn', 'canonical', `canonical ${t} differs from this URL (${self}) only by a trailing slash; those are two different URLs`)
        else if (t.replace(/^http:/, 'https:') === self.replace(/^http:/, 'https:')) add('warn', 'canonical', `canonical ${t} differs from this URL (${self}) only by protocol; point it at the version you serve`)
        else if (t === selfNoQuery) add('info', 'canonical', `canonical drops this URL's query string (${t}), which is the usual handling of tracking parameters`)
        else add('warn', 'canonical', `canonical points at ${t}, not at this URL (${self}). Search engines will index that URL instead of this one. Correct only if this page is a duplicate.`)
      }
    } else {
      add('not-checked', 'canonical-self', 'no page URL, so whether the canonical points at this page was not checked (pass a URL, or --url with a file)')
    }
  }

  // ---- Robots directives ------------------------------------------------------------------
  // noindex removes the page from results; nosnippet and max-snippet:0 also
  // keep its text out of AI Overviews and AI Mode (Google, "Robots meta tag
  // specifications"). A directive can be scoped to one crawler, by the meta
  // name or by "otherbot:" in the header, and then speaks for that crawler only.
  const robotsMetas = findTags(head, 'meta')
    .filter((t) => /^(?:robots|googlebot|googlebot-news|bingbot)$/i.test(t.attrs.get('name') || ''))
    .map((t) => ({ name: t.attrs.get('name').toLowerCase(), content: (t.attrs.get('content') || '').toLowerCase() }))
  facts.robotsMeta = robotsMetas
  const reportIndexing = (rule, label, scope) => {
    const r = readIndexing(scope, now)
    const serious = r.weight === 'all' || r.weight === 'major'
    if (r.noindex) add(serious ? 'error' : 'warn', rule, `${label} asks ${r.who} not to index this page`)
    else if (r.expired) add(serious ? 'error' : 'warn', rule, `${label}: the unavailable_after date (${r.expired}) has passed, so ${r.who} ${serious ? 'no longer show' : 'no longer shows'} this page`)
    else if (r.snippetOff) add(serious ? 'warn' : 'info', rule, `${label} blocks snippets for ${r.who}${r.weight === 'all' || r.agent === 'googlebot' ? ", which also keeps the page's text out of Google's AI Overviews and AI Mode" : ''}`)
    else if (r.nofollow) add('info', rule, `${label}: links on this page are not followed by ${r.who}`)
    // Bing reads noarchive and nocache as AI-answer controls: NOARCHIVE keeps
    // a page out of its chat answers, NOCACHE limits them to title, URL and
    // snippet, and a page carrying both is treated as NOCACHE (Bing Webmaster
    // Blog, September 2023; restated for Copilot and grounding in Bing's
    // Webmaster Guidelines, re-read 30 September 2026).
    // Google no longer uses noarchive and never used nocache.
    if (!r.noindex && !r.expired && (r.noarchive || r.nocache) && (scope.agent === '*' || scope.agent === 'bingbot')) {
      const applies = scope.agent === '*' ? 'it applies to every crawler that reads it, Bing included' : 'it applies to bingbot only'
      add('warn', 'bing-noarchive', r.noarchive && !r.nocache
        ? `${label}: noarchive keeps this page out of Microsoft Copilot answers (Bing uses it to exclude the page from AI answers; nocache limits it to title, URL and snippet). Google ignores both. As written, ${applies}.`
        : `${label}: nocache limits Microsoft Copilot answers to this page's title, URL and snippet (Bing${r.noarchive ? ' treats noarchive plus nocache as nocache' : '; noarchive alone would exclude the page from AI answers entirely'}). Google ignores both. As written, ${applies}.`)
    }
  }
  for (const m of robotsMetas) {
    for (const scope of parseIndexingDirectives(m.content, m.name === 'robots' ? '*' : m.name)) reportIndexing('robots-meta', `<meta name="${m.name}" content="${m.content}">`, scope)
  }
  if (/\bdata-nosnippet\b/i.test(body)) add('info', 'robots-meta', 'the page uses data-nosnippet on some elements; that text is kept out of snippets and AI features')

  if (ctx.source === 'url') {
    const xrt = header(ctx.headers, 'x-robots-tag')
    facts.xRobotsTag = xrt
    if (xrt) {
      const before = findings.length
      const scopes = parseIndexingDirectives(xrt)
      for (const scope of scopes) reportIndexing('x-robots-tag', `X-Robots-Tag "${xrt}"${scopes.length > 1 ? ` (the ${scope.agent === '*' ? 'unscoped' : scope.agent} part)` : ''}`, scope)
      if (findings.length === before) add('info', 'x-robots-tag', `X-Robots-Tag: ${xrt}`)
    }
  } else {
    add('not-checked', 'x-robots-tag', 'X-Robots-Tag is an HTTP response header, so it was not checked for a file or stdin. Pass the URL to check it.')
  }

  // ---- Meta refresh --------------------------------------------------------------------------
  // Google reads an instant meta refresh as a permanent redirect and a delayed
  // one as a temporary redirect (Google, "Redirects and Google Search"), so the
  // page that carries it is usually not the one indexed.
  const refreshTag = findTags(masked, 'meta').find((t) => (t.attrs.get('http-equiv') || '').toLowerCase() === 'refresh')
  if (refreshTag) {
    const r = metaRefresh(refreshTag.attrs.get('content'))
    const target = r?.url ? resolveUrl(r.url, base) : null
    facts.metaRefresh = r ? { seconds: r.seconds, url: target ?? r.url } : null
    if (target && target !== (pageUrl && normaliseUrl(pageUrl))) {
      add('warn', 'meta-refresh', `<meta http-equiv="refresh"> sends visitors to ${target} after ${r.seconds} s. Google treats ${r.seconds === 0 ? 'an instant refresh as a permanent' : 'a delayed refresh as a temporary'} redirect, so this page is unlikely to be the one indexed; a server-side 301 is the clearer signal. These checks ran on the page that redirects.`)
    } else if (r) {
      add('info', 'meta-refresh', `<meta http-equiv="refresh"> reloads this page every ${r.seconds} s`)
    }
  }

  // ---- Open Graph image ------------------------------------------------------------------
  const ogImage = findTags(head, 'meta').find((t) => (t.attrs.get('property') || t.attrs.get('name') || '').toLowerCase() === 'og:image')
  facts.ogImage = ogImage?.attrs.get('content') ?? null
  if (!facts.ogImage) add('warn', 'og-image', 'no og:image. Links shared in chat apps and social feeds will show no picture.')
  else if (!/^https?:\/\//i.test(facts.ogImage)) add('warn', 'og-image', `og:image "${facts.ogImage}" is not an absolute URL; the Open Graph protocol requires one`)

  // ---- Images ------------------------------------------------------------------------------
  const imgs = findTags(bodyText, 'img')
  facts.images = imgs.length
  const noAlt = imgs.filter((t) => !t.attrs.has('alt'))
  if (noAlt.length) add('warn', 'img-alt', `${noAlt.length} of ${imgs.length} <img> without an alt attribute (use alt="" for decorative images). e.g. ${noAlt[0].attrs.get('src') ?? noAlt[0].raw.slice(0, 80)}`)
  const noSize = imgs.filter((t) => !(t.attrs.has('width') && t.attrs.has('height')))
  if (noSize.length) add('warn', 'img-dimensions', `${noSize.length} of ${imgs.length} <img> without both width and height. The browser cannot reserve space for them, which causes layout shift (CLS). CSS aspect-ratio also works; this check cannot see stylesheets.`)
  const first = imgs[0]
  if (first && (first.attrs.get('loading') || '').toLowerCase() === 'lazy') {
    add('warn', 'lcp-lazy', `the first <img> in the page (${first.attrs.get('src') ?? 'no src'}) has loading="lazy". If it is the largest element above the fold, lazy loading delays Largest Contentful Paint (web.dev).`)
  }

  // ---- JSON-LD ---------------------------------------------------------------------------------
  const ldBlocks = [...clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter((m) => /type\s*=\s*["']?application\/ld\+json/i.test(m[1]))
  const types = new Set()
  facts.jsonLdBlocks = ldBlocks.length
  if (ldBlocks.length === 0) {
    add('info', 'json-ld', 'no JSON-LD. Not required: a matched study of 1,885 already-cited pages found adding schema did not raise AI citations, but Google still uses it for rich results.')
  }
  ldBlocks.forEach((m, i) => {
    const raw = m[2].trim()
    if (!raw) {
      add('warn', 'json-ld', `JSON-LD block ${i + 1} is empty`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      add('error', 'json-ld-parse', `JSON-LD block ${i + 1} does not parse: ${error.message}. JSON allows no comments and no trailing commas, and a consumer that cannot parse a block ignores all of it.`)
      return
    }
    ldTypes(parsed, types)
    const strings = ldStrings(parsed).map((s) => s.trim())
    const placeholders = strings.filter((s) => PLACEHOLDER.test(s))
    if (placeholders.length) add('error', 'json-ld-placeholder', `JSON-LD block ${i + 1} carries ${placeholders.length} placeholder value(s), e.g. "${placeholders[0].slice(0, 60)}". A template shipped unfilled.`)
    const empty = strings.filter((s) => s === '').length
    if (empty) add('warn', 'json-ld-placeholder', `JSON-LD block ${i + 1} has ${empty} empty string value(s)`)
  })
  facts.types = [...types].sort()
  if (types.size) add('info', 'json-ld-types', `@type: ${facts.types.join(', ')}`)
  for (const t of types) {
    if (RETIRED_TYPES.has(t)) add('warn', 'json-ld-retired', `@type ${t}: ${RETIRED_TYPES.get(t)}; it earns no Google rich result`)
    if (NO_RICH_RESULT_TYPES.has(t)) add('info', 'json-ld-retired', `@type ${t}: ${NO_RICH_RESULT_TYPES.get(t)}`)
  }

  // ---- Invisible characters -------------------------------------------------------------------
  // Over the page's text, its attributes and its JSON-LD: a zero-width
  // character is as harmful in a meta description as in a paragraph. Script
  // and style bodies are code, not copy, and are left out. A single leading
  // BOM is a file encoding marker and was removed above.
  const copy = clean
    .replace(/<script\b([^>]*)>[\s\S]*?(?:<\/script\s*>|$)/gi, (m, attrs) => (/ld\+json/i.test(attrs) ? m : ' '))
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
  const invisible = findInvisible(copy)
  if (invisible.length) add('error', 'invisible-chars', `${invisible.length} invisible or direction-changing character(s): ${summariseCodePoints(invisible)}`)

  // ---- Answer first (information only) -------------------------------------------------------------
  const para = firstParagraph(bodyText)
  if (para) {
    const words = wordCount(para)
    const kind = openingKind(para)
    facts.firstParagraph = { words, opening: kind, sample: para.slice(0, 160) }
    add('info', 'answer-first', `first paragraph has ${words} words and ${OPENING_TEXT[kind]}: "${para.slice(0, 110)}${para.length > 110 ? '...' : ''}"`)
  } else {
    add('info', 'answer-first', 'no paragraph of 8 or more words found to judge the opening')
  }

  // ---- Known myths in the visible prose ---------------------------------------------------------------
  findings.push(...mythFindings(proseFromHtml(body), 'warn'))

  return { findings, facts }
}
