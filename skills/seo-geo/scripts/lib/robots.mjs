/**
 * robots.txt parsing and group selection per RFC 9309 (the Robots Exclusion
 * Protocol, https://www.rfc-editor.org/rfc/rfc9309).
 *
 * The rules implementations most often get wrong, all implemented here:
 *
 *  1. GROUP SELECTION IS BY EXACT PRODUCT TOKEN, case-insensitive (section
 *     2.2.1: "Crawlers MUST use case-insensitive matching to find the group
 *     that matches the product token"). It is NOT a prefix match. A group for
 *     "Google" does not apply to Google-Extended, and a group for "Googlebot"
 *     does not apply to Googlebot-Image. A prefix match silently hands one
 *     crawler's rules to another. The value on the User-agent line is reduced
 *     to its leading product token first (letters, "_" and "-"), so
 *     "Googlebot/2.1" names Googlebot, which is what Google's own open-source
 *     parser does.
 *  2. ALL MATCHING GROUPS MERGE ("the matching groups' rules MUST be combined
 *     into one group"), and a named group REPLACES "*" rather than adding to
 *     it. "*" applies only when no group names the crawler.
 *  3. RULE PRECEDENCE IS LONGEST MATCH, with Allow winning a tie (section
 *     2.2.2). "Disallow: /" plus "Allow: /blog" allows /blog.
 *  4. DOCUMENTED FALLBACKS. Some vendors say what their crawler does when no
 *     group names it. Apple: "If robots instructions don't mention Applebot
 *     but mention Googlebot, the Apple robot will follow Googlebot
 *     instructions." Amazon says Amzn-SearchBot follows "the robots.txt
 *     directives given to other search bots". Those fallbacks are data (the
 *     `fallback` field in data/crawlers.json) and are tried before "*".
 *
 * Fetch semantics (section 2.3.1), used by check-crawlers.mjs:
 *   2xx     parse the file.
 *   3xx     follow at least five redirects.
 *   4xx     "unavailable": crawlers MAY access any resource. No file, no rules.
 *   5xx     "unreachable": crawlers MUST assume complete disallow. Google also
 *           treats 429 this way, and a network failure is the same case.
 */

/** The product token at the start of a User-agent value, lower-cased. */
export function productToken(value) {
  const v = String(value).trim()
  if (v.startsWith('*')) return '*'
  const m = v.match(/^[A-Za-z_-]+/)
  return m ? m[0].toLowerCase() : v.toLowerCase()
}

/**
 * Google's parser (github.com/google/robotstxt, robots.cc) accepts a few
 * frequent misspellings of the field names and a line with the colon left
 * out, as long as it has exactly two words. Reading the file the way Google
 * does means honouring those lines; a site owner still wants to hear about
 * them, because other crawlers may not be as forgiving. Each misspelling is
 * mapped to the field Google reads it as.
 */
const FIELD_TYPOS = [
  ['user-agent', /^(?:useragent|user agent)/],
  ['disallow', /^(?:dissallow|dissalow|disalow|diasllow|disallaw)/],
  ['sitemap', /^site-map/],
]

/** The field a key names, Google's way: a key that STARTS with the field name counts. */
function canonicalField(key) {
  for (const f of ['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay']) if (key.startsWith(f)) return { field: f, typo: key !== f }
  for (const [f, re] of FIELD_TYPOS) if (re.test(key)) return { field: f, typo: true }
  return { field: key, typo: false }
}

/**
 * Parse robots.txt into groups. Consecutive User-agent lines share the group
 * that follows them; a rule line closes the run, so the next User-agent line
 * starts a new group. Sitemap lines and unknown fields neither open nor close
 * a group. `typos` lists lines Google reads only because it forgives them.
 */
export function parseRobots(body) {
  const groups = []
  const sitemaps = []
  const unknownFields = new Set()
  const typos = []
  let current = null
  let agentRunOpen = false

  const lines = String(body).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/#.*$/, '').trim()
    if (!line) continue
    let colon = line.indexOf(':')
    let key
    let value
    if (colon === -1) {
      // "Disallow /private": Google accepts whitespace for the missing colon
      // when the line is exactly two words.
      const words = line.split(/[ \t]+/)
      if (words.length !== 2) continue
      ;[key, value] = words
      typos.push({ line: index + 1, text: lines[index].trim(), reads: `${key.toLowerCase()}: ${value}`, why: 'no colon' })
    } else {
      key = line.slice(0, colon).trim()
      value = line.slice(colon + 1).trim()
    }
    const { field, typo } = canonicalField(key.toLowerCase())
    if (typo && colon !== -1) typos.push({ line: index + 1, text: lines[index].trim(), reads: field, why: 'misspelt field' })

    switch (field) {
      case 'user-agent': {
        const token = productToken(value)
        if (agentRunOpen && current) current.agents.push(token)
        else {
          current = { agents: [token], raw: [value], rules: [] }
          groups.push(current)
          agentRunOpen = true
          break
        }
        current.raw.push(value)
        break
      }
      case 'allow':
      case 'disallow': {
        agentRunOpen = false
        if (!current) break // a rule before any User-agent line belongs to no group
        if (value === '') break // an empty Disallow matches nothing
        current.rules.push({ type: field, pattern: value })
        break
      }
      case 'crawl-delay': {
        agentRunOpen = false
        if (!current) break
        const delay = Number(value)
        if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay
        break
      }
      case 'sitemap':
        if (value) sitemaps.push(value)
        break
      default:
        unknownFields.add(field)
    }
  }
  return { groups, sitemaps, unknownFields: [...unknownFields], typos }
}

/** Groups naming `token` exactly (case-insensitive). */
function groupsNaming(robots, token) {
  const t = token.toLowerCase()
  return robots.groups.filter((g) => g.agents.includes(t))
}

/**
 * The merged rule set that applies to a crawler.
 *
 * Order: the crawler's own groups; then, if the vendor documents one, the
 * fallback tokens in order; then "*"; then no rules at all.
 * Returns { rules, crawlDelay, matchedAgent, via } where `via` is 'own',
 * 'fallback', 'star' or 'none'.
 */
export function rulesForAgent(robots, token, fallbackTokens = []) {
  let selected = groupsNaming(robots, token)
  let via = 'own'
  let matchedAgent = token
  if (selected.length === 0) {
    for (const fb of fallbackTokens) {
      const found = groupsNaming(robots, fb)
      if (found.length) {
        selected = found
        via = 'fallback'
        matchedAgent = fb
        break
      }
    }
  }
  if (selected.length === 0) {
    selected = groupsNaming(robots, '*')
    via = selected.length ? 'star' : 'none'
    matchedAgent = selected.length ? '*' : null
  }
  const rules = selected.flatMap((g) => g.rules)
  const crawlDelay = selected.map((g) => g.crawlDelay).find((d) => d !== undefined)
  return { rules, crawlDelay, matchedAgent, via }
}

/**
 * RFC 9309 pattern match: "*" matches any run of characters and "$" anchors
 * the end (only as the last character; elsewhere it is literal). Returns the
 * pattern's length (its specificity) or null. Percent-encoding is normalised
 * on both sides so /caf%C3%A9 and /café match.
 *
 * The algorithm is Google's (robots.cc, Matches): a set of candidate
 * positions in the path, advanced one pattern character at a time. It runs in
 * O(pattern x path) whatever the pattern. A regular expression built from
 * the pattern does not: "/*a*a*a*a*a*a*a*a*b" backtracks exponentially, and
 * the pattern comes from someone else's server.
 */
export function matchLength(pattern, path) {
  const pat = safeDecode(pattern)
  const p = safeDecode(path)
  let positions = [0]
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '$' && i === pat.length - 1) return positions.includes(p.length) ? pattern.length : null
    if (c === '*') {
      const from = positions[0]
      positions = []
      for (let j = from; j <= p.length; j++) positions.push(j)
    } else {
      const next = []
      for (const pos of positions) if (pos < p.length && p[pos] === c) next.push(pos + 1)
      if (next.length === 0) return null
      positions = next
    }
  }
  return pattern.length
}

function safeDecode(s) {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/** Longest-match evaluation of `path` against a merged rule set. */
export function isPathAllowed(rules, path) {
  let winner = null
  for (const rule of rules) {
    const length = matchLength(rule.pattern, path)
    if (length === null) continue
    if (!winner || length > winner.length || (length === winner.length && rule.type === 'allow' && winner.type === 'disallow')) {
      winner = { type: rule.type, length, pattern: rule.pattern }
    }
  }
  return { allowed: !winner || winner.type === 'allow', rule: winner }
}

/**
 * What a robots.txt fetch status means, per RFC 9309 section 2.3.1.
 * `status` is a number, or null for a network failure or timeout.
 */
export function fetchSemantics(status) {
  if (status === null || status === undefined || status === 0) {
    return { state: 'unreachable', allowAll: false, disallowAll: true, note: 'robots.txt could not be fetched: RFC 9309 section 2.3.1.4 says crawlers MUST then assume complete disallow' }
  }
  if (status >= 200 && status < 300) return { state: 'ok', allowAll: false, disallowAll: false, note: null }
  if (status === 429) {
    return { state: 'unreachable', allowAll: false, disallowAll: true, note: 'robots.txt answered 429; Google treats 429 like a server error, which means complete disallow until it recovers' }
  }
  if (status >= 500) {
    return { state: 'unreachable', allowAll: false, disallowAll: true, note: `robots.txt answered ${status}: RFC 9309 section 2.3.1.4 says crawlers MUST assume complete disallow (Google falls back to a cached copy, and after 30 days of errors may treat the site as unrestricted)` }
  }
  if (status >= 400) {
    return { state: 'unavailable', allowAll: true, disallowAll: false, note: `robots.txt answered ${status}: RFC 9309 section 2.3.1.3 says crawlers MAY access any resource, so every crawler is allowed everywhere` }
  }
  return { state: 'unreachable', allowAll: false, disallowAll: true, note: `robots.txt answered ${status} after redirects were followed; treated as unreachable` }
}

/**
 * The full verdict for one crawler token and path, combining the fetch state
 * with group selection. `robots` may be null when the file was not parsed.
 */
export function policyFor(robots, token, { path = '/', fallbackTokens = [], status = 200 } = {}) {
  const sem = fetchSemantics(status)
  if (sem.disallowAll) return { allowed: false, via: 'fetch-state', matchedAgent: null, rule: null, note: sem.note }
  if (sem.allowAll || !robots) return { allowed: true, via: 'fetch-state', matchedAgent: null, rule: null, note: sem.note }
  const { rules, crawlDelay, matchedAgent, via } = rulesForAgent(robots, token, fallbackTokens)
  const { allowed, rule } = isPathAllowed(rules, path)
  return { allowed, via, matchedAgent, rule, crawlDelay, note: null }
}

/**
 * User-agent values that look like an attempt to name a known crawler but
 * name nothing, because matching is exact: "Claude" is not ClaudeBot and
 * "Google" is not Google-Extended.
 */
export function nearMissAgents(robots, knownTokens) {
  const known = knownTokens.map((t) => t.toLowerCase())
  const out = []
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === '*' || known.includes(a)) continue
      const extends_ = known.filter((k) => k.startsWith(a) && k !== a)
      if (extends_.length) out.push({ agent: a, wouldMatch: extends_ })
    }
  }
  return out
}

/* ---- page-level indexing directives (robots meta and X-Robots-Tag) -------- */

/**
 * Directive names Google documents for the robots meta tag and X-Robots-Tag
 * (Google, "Robots meta tag, data-nosnippet, and X-Robots-Tag
 * specifications"). Anything else before a colon is a crawler name:
 * "googlebot: noindex" scopes the directives after it to Googlebot.
 */
const DIRECTIVES = new Set([
  'all', 'index', 'follow', 'noindex', 'nofollow', 'none', 'noarchive', 'nocache', 'nosnippet', 'notranslate',
  'noimageindex', 'indexifembedded', 'max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after',
  'noodp', 'noydir',
])

/**
 * Parse a robots meta content or an X-Robots-Tag value into one entry per
 * crawler it addresses: [{ agent, directives: [...] }], `agent` lower-cased,
 * '*' when the value names none. Several headers arrive joined with ", ", and
 * "otherbot: noindex" switches the scope for what follows, so a header that
 * noindexes one minor crawler is not read as noindexing the page.
 *
 * Matching is by whole directive: "max-image-preview:none" is an image
 * preview setting, not the "none" directive, and a substring match on "none"
 * reported it as a noindex.
 */
export function parseIndexingDirectives(value, defaultAgent = '*') {
  const scopes = new Map()
  let agent = defaultAgent
  for (const raw of String(value ?? '').split(',')) {
    let part = raw.trim()
    if (!part) continue
    const scoped = part.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (scoped && !DIRECTIVES.has(scoped[1].toLowerCase())) {
      agent = scoped[1].toLowerCase()
      part = scoped[2].trim()
      if (!part) continue
    }
    if (!scopes.has(agent)) scopes.set(agent, [])
    scopes.get(agent).push(part.toLowerCase().replace(/\s*:\s*/, ':'))
  }
  return [...scopes].map(([a, directives]) => ({ agent: a, directives }))
}

/** Who a scope speaks to, in words, and how much it matters for search. */
function audienceOf(agent) {
  if (agent === '*' || agent === 'robots') return { who: 'search engines', weight: 'all' }
  if (agent === 'googlebot') return { who: 'Google', weight: 'major' }
  if (agent === 'bingbot') return { who: 'Bing', weight: 'major' }
  if (agent === 'googlebot-news') return { who: 'Google News only', weight: 'minor' }
  return { who: `${agent} only`, weight: 'minor' }
}

/**
 * What a set of directives means, as { noindex, snippetOff, nofollow,
 * noarchive, nocache, expired, who, weight }.
 * `unavailable_after` with a date in the past is a noindex from that date
 * (Google). A date that does not parse is ignored, as Google ignores it.
 */
export function readIndexing({ agent, directives }, now = new Date()) {
  const has = (d) => directives.includes(d)
  let expired = null
  for (const d of directives) {
    const m = d.match(/^unavailable_after:(.+)$/)
    if (!m) continue
    const t = Date.parse(m[1].trim())
    if (Number.isFinite(t) && t < now.getTime()) expired = m[1].trim()
  }
  return {
    ...audienceOf(agent),
    agent,
    noindex: has('noindex') || has('none'),
    snippetOff: has('nosnippet') || directives.some((d) => /^max-snippet:0$/.test(d)),
    nofollow: has('nofollow') || has('none'),
    noarchive: has('noarchive'),
    nocache: has('nocache'),
    expired,
  }
}
