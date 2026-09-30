/**
 * The logic behind check-sitemap.mjs.
 *
 * A sitemap is a list of URLs you are asking search engines to index. Every
 * entry that is not an indexable, self-canonical 200 is a mixed signal: it
 * spends crawl on a URL you do not want indexed, and it teaches the engine
 * that your sitemap is not to be trusted. Google's guidance is to list only
 * canonical URLs you want in search results
 * (https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
 *
 * lastmod has one rule that matters: Google says it uses lastmod when the
 * value is consistently and verifiably accurate (same page, "Additional notes
 * about XML sitemaps"). A lastmod stamped with the build
 * time on every URL is the common way to lose that trust for the whole file,
 * which is why one date shared by most URLs is reported as a smell.
 */

import { gunzipSync } from 'node:zlib'
import { BROWSER_UA, botWall, decodeText, readBody } from './cli.mjs'
import { decodeEntities, findTags, headOf, maskRawText, stripComments } from './html.mjs'
import { parseIndexingDirectives, readIndexing } from './robots.mjs'

/** Sitemap protocol limits: 50,000 URLs and 50 MB (52,428,800 bytes) uncompressed per file. */
export const MAX_URLS = 50_000
export const MAX_BYTES = 50 * 1024 * 1024

/** Thrown when a sitemap is past the 50 MB limit, compressed or not. */
export class SitemapTooLarge extends Error {}

/**
 * A body as text, gunzipping when it is a .gz sitemap (by its magic bytes,
 * whatever the URL or Content-Type says). Decompression stops one byte past
 * the protocol limit, so a small file that inflates to gigabytes (a gzip
 * bomb) is reported as too large instead of exhausting memory.
 */
export function sitemapText(buffer) {
  let body = buffer
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      body = gunzipSync(buffer, { maxOutputLength: MAX_BYTES + 1 })
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength/i.test(error?.message ?? '')) {
        throw new SitemapTooLarge('decompresses to more than 50 MB; the limit is 50 MB uncompressed')
      }
      throw error
    }
  }
  return decodeText(body, null).text
}

const ONE_TAG = (inner, name) => {
  // The sitemap namespace's own <loc> first: an <image:loc> or <video:...>
  // inside the same <url> must never be read as the page's URL, whichever
  // comes first in the element.
  const plain = inner.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i'))
  if (plain) return plain[1]
  const prefixed = [...inner.matchAll(new RegExp(`<([a-z][\\w.-]*):${name}\\b[^>]*>([\\s\\S]*?)</\\1:${name}\\s*>`, 'gi'))]
  return prefixed.find((m) => !/^(?:image|video|news|xhtml|mobile)$/i.test(m[1]))?.[2]
}

/**
 * Parse a sitemap in any format Google accepts
 * (https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap):
 *   urlset / sitemapindex   the XML protocol
 *   text                    one absolute URL per line, UTF-8
 *   feed                    RSS 2.0 or Atom 1.0; the item links are the URLs
 * Returns { type, entries: [{ loc, lastmod?, news? }] }; type 'unknown' when
 * it is none of them.
 */
export function parseSitemap(xml) {
  const text = String(xml).replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  if (/<(?:[a-z]+:)?sitemapindex\b/i.test(text) || /<(?:[a-z]+:)?urlset\b/i.test(text)) {
    const type = /<(?:[a-z]+:)?sitemapindex\b/i.test(text) ? 'index' : 'urlset'
    const tag = type === 'index' ? 'sitemap' : 'url'
    const re = new RegExp(`<(?:[a-z]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${tag}\\s*>`, 'gi')
    const entries = [...text.matchAll(re)].map(([, inner]) => ({
      loc: decodeEntities(ONE_TAG(inner, 'loc') ?? '').trim(),
      lastmod: ONE_TAG(inner, 'lastmod')?.trim(),
      ...(/<news:news\b/i.test(inner) ? { news: true } : {}),
    }))
    return { type, entries }
  }
  if (/<rss\b/i.test(text) || /<feed\b[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(text)) {
    const rss = /<rss\b/i.test(text)
    const items = [...text.matchAll(rss ? /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi : /<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)]
    const entries = items.map(([, inner]) => {
      const loc = rss ? ONE_TAG(inner, 'link') : findTags(inner, 'link').find((t) => !t.attrs.get('rel') || t.attrs.get('rel') === 'alternate')?.attrs.get('href')
      const date = rss ? ONE_TAG(inner, 'pubDate') : (ONE_TAG(inner, 'updated') ?? ONE_TAG(inner, 'published'))
      const parsed = date ? Date.parse(date.trim()) : NaN
      return { loc: decodeEntities(loc ?? '').trim(), lastmod: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined }
    })
    return { type: 'feed', entries }
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) {
    return { type: 'text', entries: lines.map((loc) => ({ loc })) }
  }
  return { type: 'unknown', entries: [] }
}

/** W3C Datetime, the only lastmod format the protocol allows. */
export const W3C_DATE = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/

export const RESTAMP_SHARE = 0.8
export const RESTAMP_MIN_URLS = 10

/**
 * lastmod sanity over every entry (not only a sample).
 *   future dates      a date more than a day ahead cannot be true
 *   invalid format    not W3C Datetime, so engines may discard it
 *   one shared date   the same lastmod on more than 80% of at least 10 URLs
 *                     IN ONE SITEMAP is the fingerprint of a build step
 *                     stamping every URL. Judged per file, because a site
 *                     whose posts are dated honestly can still restamp its
 *                     pages sitemap, and pooling the two hides it. A Google
 *                     News sitemap is exempt: it lists only the last two
 *                     days of articles by design, so one shared date is
 *                     what a correct one looks like.
 *   missing           reported for information; Google does not require it
 */
export function lastmodFindings(entries, now = new Date()) {
  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  const withDate = entries.filter((e) => e.lastmod)
  const missing = entries.length - withDate.length

  const invalid = withDate.filter((e) => !W3C_DATE.test(e.lastmod))
  if (invalid.length) add('warn', 'lastmod-format', `${invalid.length} lastmod value(s) are not W3C Datetime, e.g. "${invalid[0].lastmod}" on ${invalid[0].loc}`)

  const future = withDate.filter((e) => W3C_DATE.test(e.lastmod) && Date.parse(e.lastmod) > now.getTime() + 86_400_000)
  if (future.length) add('warn', 'lastmod-future', `${future.length} lastmod value(s) are in the future, e.g. ${future[0].lastmod} on ${future[0].loc}. A date that cannot be true costs the whole file's lastmod credibility.`)

  const restamped = []
  const bySitemap = new Map()
  for (const e of withDate) {
    if (!bySitemap.has(e.sitemap)) bySitemap.set(e.sitemap, [])
    bySitemap.get(e.sitemap).push(e)
  }
  for (const [sitemap, dated] of bySitemap) {
    if (dated.length < RESTAMP_MIN_URLS) continue
    if (dated.some((e) => e.news)) continue
    const byDay = new Map()
    for (const e of dated) {
      const key = e.lastmod.slice(0, 10)
      byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
    const [day, count] = [...byDay].sort((a, b) => b[1] - a[1])[0]
    if (count / dated.length > RESTAMP_SHARE) restamped.push({ sitemap, day, count, total: dated.length })
  }
  const why = 'That is what a build stamping every URL looks like; Google uses lastmod only when it is consistently accurate.'
  const pct = (r) => Math.round((100 * r.count) / r.total)
  if (restamped.length > 3) {
    add('warn', 'lastmod-restamp', `${restamped.length} sitemaps each have more than ${RESTAMP_SHARE * 100}% of their URLs on one lastmod, e.g. ${restamped.slice(0, 3).map((r) => `${r.sitemap} (${pct(r)}% on ${r.day})`).join(', ')}. ${why}`)
  } else {
    for (const r of restamped) add('warn', 'lastmod-restamp', `${r.count} of ${r.total} URLs${r.sitemap ? ` in ${r.sitemap}` : ''} (${pct(r)}%) share lastmod ${r.day}. ${why}`)
  }

  if (entries.length && missing === entries.length) add('info', 'lastmod-missing', 'no URL carries a lastmod. Not required, but an accurate lastmod helps engines decide what to recrawl.')
  else if (missing) add('info', 'lastmod-missing', `${missing} of ${entries.length} URLs have no lastmod`)
  return findings
}

/** Pick `n` entries spread evenly across the list, so every child sitemap is represented. */
export function evenSample(list, n) {
  if (!n || n >= list.length) return list
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)])
}

const comparable = (u) => {
  const url = new URL(u)
  url.hash = ''
  return url.href
}

/** A token that reads as a language or country code: gb, en-us, pt_BR. */
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i
const LOCALE_PARAMS = ['lang', 'language', 'locale', 'hl', 'lc']

/** A URL with every locale token removed: path segments (/gb/), filename infixes (.no.html) and locale parameters. */
function withoutLocales(u) {
  const path = u.pathname
    .split('/')
    .map((seg) => seg.split('.').filter((part, i, all) => !(LOCALE.test(part) && (all.length === 1 || i > 0))).join('.'))
    .filter(Boolean)
    .join('/')
  const params = new URLSearchParams(u.search)
  for (const k of LOCALE_PARAMS) params.delete(k)
  return `${u.protocol}//${u.host}/${path}?${params}`
}

/**
 * Is `target` the same page as `loc` in another locale? /legal to /gb/legal,
 * /x.no.html to /x.en-gb.html, ?lang=de to ?lang=en. A redirect of that shape
 * is usually language or geo redirection keyed on the requester's IP or
 * headers: this machine was sent to its own locale, and Googlebot, crawling
 * mostly from the US with no Accept-Language, may be served the listed URL.
 */
export function isLocaleRedirect(loc, target) {
  try {
    const a = new URL(loc)
    const b = new URL(target, loc)
    if (a.href === b.href || a.host !== b.host || a.protocol !== b.protocol) return false
    return withoutLocales(a) === withoutLocales(b)
  } catch {
    return false
  }
}

/** How much of a page to read to find its <head>: well past any real head. */
const HEAD_READ_BYTES = 1024 * 1024

async function request(loc, userAgent, timeoutMs) {
  return fetch(loc, { redirect: 'manual', headers: { 'user-agent': userAgent, accept: 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) })
}

/**
 * Check one advertised URL. Returns { status, problems, retryable,
 * unreachable?, blocked?, browserOnly? }.
 * Redirects are not followed: a sitemap should list final URLs.
 *
 * A bot-protection wall (a 403 or 429, a challenge) is asked again as a
 * browser. If the browser is served, the checks run on its copy and the URL
 * is marked `browserOnly`; if not, the URL is `blocked`: not checked, never a
 * pass and never a failure, because a wall says nothing about the page.
 */
export async function checkLoc(loc, { timeoutMs = 30_000, userAgent }) {
  let res
  try {
    res = await request(loc, userAgent, timeoutMs)
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error?.cause?.code || error?.message || String(error)
    return { status: null, problems: [], unreachable: reason, retryable: true }
  }
  let browserOnly = false
  const wall = botWall(res.status, res.headers)
  if (wall) {
    await res.body?.cancel().catch(() => {})
    let again = null
    try {
      again = await request(loc, BROWSER_UA, timeoutMs)
    } catch {
      again = null
    }
    if (!again || botWall(again.status, again.headers)) {
      await again?.body?.cancel().catch(() => {})
      return { status: res.status, problems: [], blocked: wall, retryable: res.status === 429 }
    }
    res = again
    browserOnly = true
  }
  const problems = []
  const add = (level, rule, message) => problems.push({ level, rule, message })
  const status = res.status
  const location = res.headers.get('location')
  if (status >= 300 && status < 400) {
    let target = null
    try {
      target = location ? new URL(location, loc).href : null
    } catch {
      target = null
    }
    if (target && isLocaleRedirect(loc, target)) {
      const permanent = status === 301 || status === 308
      add('warn', 'loc-locale-redirect', `${permanent ? 'permanently ' : ''}redirects (${status}) to ${target}, the same page in another locale. That is usually language or geo redirection keyed on this machine's IP or headers, and Googlebot, crawling mostly from the US, may be served this URL itself.${permanent ? ' If every visitor, Googlebot included, is sent there, list the target instead.' : ''} Check it with Search Console's URL Inspection before changing the sitemap.`)
    } else if (location && !target) {
      add('error', 'loc-redirect', `redirects (${status}) to an invalid Location "${location}"`)
    } else {
      add('error', 'loc-redirect', `redirects (${status}) to ${target ?? 'nowhere'}; list the final URL instead`)
    }
  } else if (status !== 200) add('error', 'loc-status', `HTTP ${status}`)

  const noindexOf = (label, value, defaultAgent) => {
    for (const scope of parseIndexingDirectives(value, defaultAgent)) {
      const r = readIndexing(scope)
      if ((r.noindex || r.expired) && (r.weight === 'all' || r.weight === 'major')) {
        add('error', 'loc-noindex', `${label} (${r.expired ? `unavailable_after ${r.expired} has passed` : `noindex for ${r.who}`})`)
      }
    }
  }
  const xrt = res.headers.get('x-robots-tag') ?? ''
  if (xrt) noindexOf(`X-Robots-Tag: ${xrt}`, xrt, '*')

  if (status === 200) {
    const type = res.headers.get('content-type') ?? ''
    const linkHeader = res.headers.get('link') ?? ''
    const headerCanon = linkHeader.match(/<([^>]+)>\s*;\s*rel="?canonical"?/i)?.[1]
    let canonical = headerCanon
    const isHtml = /html/i.test(type) || !type
    if (isHtml) {
      const { buffer } = await readBody(res, HEAD_READ_BYTES)
      const head = headOf(maskRawText(stripComments(decodeText(buffer, type).text)))
      for (const meta of findTags(head, 'meta')) {
        const name = (meta.attrs.get('name') || '').toLowerCase()
        const content = meta.attrs.get('content') || ''
        if (name === 'robots' || name === 'googlebot' || name === 'bingbot') noindexOf(`<meta name="${name}" content="${content}">`, content, name === 'robots' ? '*' : name)
      }
      const link = findTags(head, 'link').find((t) => (t.attrs.get('rel') || '').toLowerCase().split(/\s+/).includes('canonical') && (t.attrs.get('href') ?? '').trim())
      canonical = canonical ?? link?.attrs.get('href')
      const baseHref = findTags(head, 'base').find((t) => t.attrs.has('href'))?.attrs.get('href')
      if (baseHref && canonical && !headerCanon) {
        try {
          canonical = new URL(canonical, new URL(baseHref, loc)).href
        } catch {
          // an invalid base is reported below as an invalid canonical
        }
      }
    } else {
      await res.body?.cancel().catch(() => {})
    }
    if (!canonical) {
      if (isHtml) add('warn', 'loc-canonical', 'no canonical')
    } else {
      let target
      try {
        target = comparable(new URL(canonical, loc).href)
      } catch {
        add('error', 'loc-canonical', `canonical "${canonical}" is not a valid URL`)
      }
      if (target && target !== comparable(loc)) {
        const slashOnly = target.replace(/\/$/, '') === comparable(loc).replace(/\/$/, '')
        add('error', 'loc-canonical', `canonical is ${target}${slashOnly ? ' (differs only by a trailing slash, which is still a different URL)' : ''}; the sitemap should list the canonical URL`)
      }
    }
  } else {
    await res.body?.cancel().catch(() => {})
  }
  return { status, problems, retryable: status === 429 || status >= 500, browserOnly }
}
