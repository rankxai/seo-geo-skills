/**
 * The logic behind crawl-site.mjs: what one fetched page contributes to the
 * crawl (links, ids, title, description, h1, canonical, noindex), and the
 * site-wide findings built from every page once the crawl stops.
 *
 * Kept apart from the fetching so the rules can be tested on plain data. Only
 * the facts are kept per page, never the HTML, so a 200-page crawl holds a few
 * hundred kilobytes rather than the pages themselves.
 *
 * Why each rule matters, briefly:
 *   broken-link          a 4xx or 5xx behind an internal link wastes crawl and
 *                        strands the visitor; the linking pages are what to fix.
 *   fragment-missing     a link to #section whose id is not in the served HTML
 *                        lands at the top of the page. Passage links and "jump
 *                        to" menus depend on the id existing.
 *   internal-redirect    Google: link to the final URL, and "avoid chaining
 *                        redirects" (site move documentation).
 *   not-in-sitemap, sitemap-orphan
 *                        Google asks for every canonical URL you want indexed
 *                        in the sitemap, and discovers most pages by links. A
 *                        sitemap URL that no page links to is found only through
 *                        the sitemap and inherits no internal link signals.
 *   duplicate-title, duplicate-description
 *                        Titles and descriptions that do not tell pages apart
 *                        make the search result and the AI citation ambiguous.
 *   noindex-linked, noindex-in-sitemap
 *                        Linking to, or listing, a page you ask engines not to
 *                        index is a mixed signal and spends crawl on it.
 *   canonical-elsewhere  internal links should point at the canonical URL.
 *   deep-pages           pages many clicks from the start are crawled less and
 *                        receive less internal link equity. The threshold (more
 *                        than 4) is a convention, not a documented limit.
 */

import { decodeEntities, findTags, headOf, bodyOf, maskRawText, stripComments } from './html.mjs'
import { parseIndexingDirectives, readIndexing } from './robots.mjs'

/** A URL as a crawl key: no fragment. Returns null for anything that is not http(s). */
export function crawlKey(u, base) {
  try {
    const url = base ? new URL(u, base) : new URL(u)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/**
 * Fragments that are not element ids, so a missing id is not a defect:
 * "" and "top" (the HTML standard scrolls to the top for both), hashbang
 * routes ("#!/...") and text fragments ("#:~:text=").
 */
export function checkableFragment(fragment) {
  if (!fragment) return false
  if (/^top$/i.test(fragment)) return false
  if (fragment.startsWith('!') || fragment.startsWith('/') || fragment.includes(':~:')) return false
  return true
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const ID_ATTR = /\s(?:id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/** Every id in the document, plus the name of every <a name>, which also acts as a fragment target. */
export function idsOf(masked) {
  const ids = new Set()
  for (const m of masked.matchAll(ID_ATTR)) ids.add(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ''))
  for (const a of findTags(masked, 'a')) if (a.attrs.has('name')) ids.add(a.attrs.get('name'))
  ids.delete('')
  return ids
}

/**
 * The facts one HTML page contributes. `url` is the page's final URL,
 * `headers` the response headers (for X-Robots-Tag and a Link canonical).
 */
export function extractPage(html, url, headers = null) {
  const h = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? ''
  const masked = maskRawText(stripComments(String(html).replace(/^\uFEFF/, '')))
  const head = headOf(masked)
  const body = bodyOf(masked)

  const baseHref = findTags(head, 'base').find((t) => t.attrs.has('href'))?.attrs.get('href')
  let base = url
  if (baseHref) {
    try {
      base = new URL(baseHref, url).href
    } catch {
      base = url
    }
  }

  const titleMatch = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''
  const description = (findTags(head, 'meta').find((t) => (t.attrs.get('name') || '').toLowerCase() === 'description')?.attrs.get('content') ?? '').replace(/\s+/g, ' ').trim()
  const h1Count = findTags(body, 'h1').length

  let canonical = null
  const headerCanon = h('link').match(/<([^>]+)>\s*;\s*rel="?canonical"?/i)?.[1]
  const tagCanon = findTags(head, 'link').find((t) => (t.attrs.get('rel') || '').toLowerCase().split(/\s+/).includes('canonical') && (t.attrs.get('href') ?? '').trim())
  if (tagCanon) canonical = crawlKey(tagCanon.attrs.get('href').trim(), base)
  else if (headerCanon) canonical = crawlKey(headerCanon, url)

  // noindex for everyone, Google or Bing: a directive scoped to a minor crawler is not a site defect.
  let noindex = null
  const readScopes = (value, defaultAgent, label) => {
    for (const scope of parseIndexingDirectives(value, defaultAgent)) {
      const r = readIndexing(scope)
      if ((r.noindex || r.expired) && (r.weight === 'all' || r.weight === 'major') && !noindex) noindex = `${label} (${r.who})`
    }
  }
  for (const m of findTags(head, 'meta')) {
    const name = (m.attrs.get('name') || '').toLowerCase()
    if (name === 'robots' || name === 'googlebot' || name === 'bingbot') readScopes(m.attrs.get('content') || '', name === 'robots' ? '*' : name, `<meta name="${name}">`)
  }
  if (h('x-robots-tag')) readScopes(h('x-robots-tag'), '*', 'X-Robots-Tag')

  const links = []
  for (const tag of [...findTags(body, 'a'), ...findTags(body, 'area')]) {
    const href = (tag.attrs.get('href') ?? '').trim()
    if (!href || /^(?:javascript|mailto|tel|data|sms|ftp):/i.test(href)) continue
    let resolved
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    const fragment = resolved.hash ? safeDecode(resolved.hash.slice(1)) : ''
    resolved.hash = ''
    links.push({ url: resolved.href, fragment })
  }

  return { title, description, h1Count, canonical, noindex, ids: idsOf(masked), links }
}

/* ---- site-wide analysis -------------------------------------------------- */

/**
 * Click depth from the start URL over the recorded link graph (breadth-first,
 * so the depth is the fewest clicks). `edges` maps a source key to a Set of
 * target keys; a redirect is an edge from the redirecting URL to its target.
 */
export function clickDepths(startKeys, edges) {
  const depth = new Map()
  let frontier = []
  for (const k of startKeys) {
    if (k && !depth.has(k)) {
      depth.set(k, 0)
      frontier.push(k)
    }
  }
  while (frontier.length) {
    const next = []
    for (const k of frontier) {
      for (const t of edges.get(k) ?? []) {
        if (depth.has(t)) continue
        depth.set(t, depth.get(k) + 1)
        next.push(t)
      }
    }
    frontier = next
  }
  return depth
}

export const DEEP_THRESHOLD = 4
const SAMPLE = 5

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const sample = (list, n = SAMPLE) => (list.length > n ? `${list.slice(0, n).join(', ')} and ${list.length - n} more` : list.join(', '))

/**
 * Build every site-wide finding from the crawl state.
 *
 * state = {
 *   pages: Map key -> { key, status, finalKey, chain, blocked, error, robotsBlocked,
 *                       html (bool), facts (from extractPage) | null, browserOnly }
 *   inlinks: Map key -> Set of source keys (the pages that link to it)
 *   fragments: Map key -> Map fragment -> Set of source keys
 *   edges: Map key -> Set of target keys
 *   startKeys: [key, ...]
 *   sitemap: Set of keys | null (null when no sitemap was read)
 *   sitemapRead: boolean
 *   sitemapComplete: boolean (false when only part of a large sitemap was read:
 *                    a URL found in it is in it, but one not found may be too)
 *   capped: boolean, linkCrawlComplete: boolean, max: number
 * }
 *
 * Each finding carries `affects`, the number of URLs it touches, so the report
 * can rank a template defect on 150 pages above a one-off.
 */
export function analyseCrawl(state) {
  const { pages, inlinks, fragments, edges, startKeys, sitemap } = state
  const findings = []
  const add = (level, rule, message, affects = 1, urls = []) => findings.push({ level, rule, message, affects, urls })
  const linkers = (key) => [...(inlinks.get(key) ?? [])]
  const htmlPages = [...pages.values()].filter((p) => p.status === 200 && p.facts)

  // ---- broken internal links, redirects and chains --------------------------
  for (const p of pages.values()) {
    const from = linkers(p.key)
    if (!from.length) continue
    const finalStatus = p.status
    if (p.chain.length && p.redirectError) {
      add('error', 'redirect-loop', `${p.key}: ${p.redirectError}; linked from ${plural(from.length, 'page')}: ${sample(from)}`, from.length, [p.key, ...from])
      continue
    }
    if (finalStatus >= 400 && !p.blocked) {
      const via = p.chain.length ? ` after redirecting to ${p.finalKey}` : ''
      add('error', 'broken-link', `${p.key} answered HTTP ${finalStatus}${via}; linked from ${plural(from.length, 'page')}: ${sample(from)}`, from.length, [p.key, ...from])
    }
    if (p.chain.length >= 2) {
      add('warn', 'redirect-chain', `${p.key} redirects ${p.chain.length} times (${p.chain.map((h) => h.status).join(' > ')}) to ${p.finalKey}; linked from ${plural(from.length, 'page')}: ${sample(from)}. Link to the final URL, and redirect straight to it.`, from.length, [p.key, ...from])
    } else if (p.chain.length === 1 && p.offsite) {
      // A path on this site that forwards to another site is usually a deliberate short link.
      add('info', 'internal-redirect', `${p.key} redirects (${p.chain[0].status}) off this site to ${p.finalKey}; linked from ${plural(from.length, 'page')}. Fine as a deliberate short link; otherwise link to the destination.`, from.length, [p.key, ...from])
    } else if (p.chain.length === 1 && !(finalStatus >= 400)) {
      add('warn', 'internal-redirect', `${p.key} redirects (${p.chain[0].status}) to ${p.finalKey}; linked from ${plural(from.length, 'page')}: ${sample(from)}. Link to the final URL.`, from.length, [p.key, ...from])
    }
  }

  // ---- fragments --------------------------------------------------------------
  for (const [key, byFragment] of fragments) {
    const target = pages.get(key)
    const facts = target && target.status === 200 ? (target.facts ?? pages.get(target.finalKey)?.facts) : null
    if (!facts) continue
    for (const [fragment, sources] of byFragment) {
      if (!checkableFragment(fragment) || facts.ids.has(fragment)) continue
      const from = [...sources]
      add('warn', 'fragment-missing', `${key}#${fragment}: no element with id "${fragment}" in the served HTML (it may be added by JavaScript, which most AI crawlers do not run); linked from ${plural(from.length, 'page')}: ${sample(from)}`, from.length, [key, ...from])
    }
  }

  // ---- page fields ---------------------------------------------------------------
  const indexable = htmlPages.filter((p) => !p.facts.noindex && (!p.facts.canonical || p.facts.canonical === p.key))
  const aggregate = (level, rule, list, text) => {
    if (!list.length) return
    const keys = list.map((p) => p.key)
    add(level, rule, `${plural(keys.length, 'indexable page')} ${keys.length === 1 ? 'has' : 'have'} ${text}: ${sample(keys)}`, keys.length, keys)
  }
  aggregate('error', 'missing-title', indexable.filter((p) => !p.facts.title), 'no <title>')
  aggregate('warn', 'missing-description', indexable.filter((p) => !p.facts.description), 'no meta description')
  aggregate('warn', 'missing-h1', indexable.filter((p) => p.facts.h1Count === 0), 'no <h1> in the served HTML')

  const groupBy = (field) => {
    const groups = new Map()
    for (const p of indexable) {
      const v = p.facts[field]
      if (!v) continue
      const k = v.toLowerCase()
      if (!groups.has(k)) groups.set(k, { value: v, keys: [] })
      groups.get(k).keys.push(p.key)
    }
    return [...groups.values()].filter((g) => g.keys.length > 1)
  }
  for (const g of groupBy('title')) add('warn', 'duplicate-title', `${plural(g.keys.length, 'indexable page')} share the title "${g.value}": ${sample(g.keys)}`, g.keys.length, g.keys)
  for (const g of groupBy('description')) add('warn', 'duplicate-description', `${plural(g.keys.length, 'indexable page')} share the description "${g.value.length > 90 ? `${g.value.slice(0, 90)}...` : g.value}": ${sample(g.keys)}`, g.keys.length, g.keys)

  // ---- noindex and canonical -------------------------------------------------------
  for (const p of htmlPages.filter((x) => x.facts.noindex)) {
    const from = linkers(p.key).filter((k) => k !== p.key)
    if (sitemap?.has(p.key)) add('error', 'noindex-in-sitemap', `${p.key} is in the sitemap but asks not to be indexed: ${p.facts.noindex}`, 1, [p.key])
    if (from.length) add('warn', 'noindex-linked', `${p.key} asks not to be indexed (${p.facts.noindex}) but ${plural(from.length, 'page')} ${from.length === 1 ? 'links' : 'link'} to it: ${sample(from)}`, from.length, [p.key, ...from])
  }
  const elsewhere = htmlPages.filter((p) => p.facts.canonical && p.facts.canonical !== p.key)
  if (elsewhere.length) {
    const lines = elsewhere.map((p) => `${p.key} -> ${p.facts.canonical}`)
    add('warn', 'canonical-elsewhere', `${plural(elsewhere.length, 'crawled page')} ${elsewhere.length === 1 ? 'declares' : 'declare'} a canonical pointing at another URL, so engines index that URL instead; internal links should point at the canonical: ${sample(lines, 3)}`, elsewhere.length, elsewhere.map((p) => p.key))
    for (const p of elsewhere) {
      const target = pages.get(p.facts.canonical)
      if (target && target.status >= 400 && !target.blocked) add('error', 'canonical-broken', `${p.key} names ${p.facts.canonical} as its canonical, which answered HTTP ${target.status}`, 1, [p.key])
    }
  }

  // ---- sitemap coverage ---------------------------------------------------------------
  if (!state.sitemapRead) {
    add('not-checked', 'sitemap-coverage', 'no sitemap was read, so pages missing from it and sitemap URLs nothing links to were not checked', 0)
  } else {
    const missing = indexable.filter((p) => !sitemap.has(p.key) && linkers(p.key).length)
    if (missing.length && state.sitemapComplete === false) {
      add('not-checked', 'not-in-sitemap', `${plural(missing.length, 'indexable page')} linked internally were not found in the part of the sitemap that was read; the sitemap is larger than this tool reads, so whether they are in the rest was not checked. check-sitemap.mjs reads more of it (raise --max-sitemaps to read it all).`, 0)
    } else if (missing.length) {
      const keys = missing.map((p) => p.key)
      add('warn', 'not-in-sitemap', `${plural(keys.length, 'indexable page')} linked internally ${keys.length === 1 ? 'is' : 'are'} not in the sitemap: ${sample(keys)}. List every canonical URL you want indexed.`, keys.length, keys)
    }
    const depth = clickDepths(startKeys, edges)
    const orphans = [...sitemap].filter((k) => !depth.has(k))
    if (state.sitemapComplete === false) {
      add('not-checked', 'sitemap-orphan', 'only part of the sitemap was read, so sitemap URLs that no page links to were not checked', 0)
    } else if (!state.linkCrawlComplete) {
      add('not-checked', 'sitemap-orphan', `the crawl stopped at ${state.max} URLs before following every internal link, so sitemap URLs that no page links to could not be told apart from pages not reached yet. Raise --max to check.`, 0)
    } else if (orphans.length) {
      add('warn', 'sitemap-orphan', `${plural(orphans.length, 'sitemap URL')} ${orphans.length === 1 ? 'is' : 'are'} not linked from any page reachable from the start URL: ${sample(orphans)}. A page found only through the sitemap gets no internal link signals.`, orphans.length, orphans)
    }
  }

  // ---- click depth ------------------------------------------------------------------------
  const depth = clickDepths(startKeys, edges)
  const deep = indexable.filter((p) => (depth.get(p.key) ?? -1) > DEEP_THRESHOLD)
  if (deep.length) {
    const keys = deep.map((p) => p.key)
    add('warn', 'deep-pages', `${plural(keys.length, 'indexable page')} ${keys.length === 1 ? 'is' : 'are'} more than ${DEEP_THRESHOLD} clicks from the start URL: ${sample(keys)}`, keys.length, keys)
  }

  return findings
}

/** Click depth distribution over the HTML pages that answered 200, as { depth: count }, plus the unreached count. */
export function depthDistribution(state) {
  const depth = clickDepths(state.startKeys, state.edges)
  const dist = {}
  let unreached = 0
  for (const p of state.pages.values()) {
    if (p.status !== 200 || !p.facts) continue
    const d = depth.get(p.key)
    if (d === undefined) unreached++
    else dist[d] = (dist[d] ?? 0) + 1
  }
  return { dist, unreached }
}
