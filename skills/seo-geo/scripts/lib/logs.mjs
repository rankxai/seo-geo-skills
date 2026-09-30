/**
 * The logic behind check-logs.mjs: read access log lines, attribute them to
 * the crawlers in data/crawlers.json, and check a claimed crawler's IP address
 * against the ranges its vendor publishes.
 *
 * Formats read, one line at a time:
 *   combined   nginx and Apache: ip - user [time] "request" status bytes "referer" "user agent"
 *              (anything after the user agent is ignored, and an Apache
 *              vhost_combined "host:port " prefix is accepted)
 *   common     the same without referer and user agent: counted, but no line
 *              can be attributed to a crawler without a user agent
 *   JSON lines Cloudflare Logpush (ClientIP, ClientRequestUserAgent,
 *              EdgeResponseStatus, ClientRequestURI, EdgeStartTimestamp), Vercel
 *              log drains (proxy.clientIp, proxy.userAgent, proxy.statusCode,
 *              proxy.path, timestamp) and the obvious names (ip, userAgent, ua,
 *              status, path, timestamp)
 *
 * A user agent is a claim. Anyone can send Googlebot's, so a count of
 * "Googlebot" requests means nothing about Google until the IP is checked. The
 * vendors publish their ranges (the verify URLs in data/crawlers.json), and
 * CIDR matching is implemented here for IPv4 and IPv6 with BigInt, so no
 * dependency is needed.
 */

/* ---- IP addresses and CIDR ranges ---------------------------------------------- */

/** An IPv4 dotted quad as a BigInt, or null. */
export function parseIPv4(s) {
  const parts = String(s).split('.')
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8n) | BigInt(v)
  }
  return n
}

/** An IPv6 address (with ::, an embedded IPv4 tail or a %zone) as a BigInt, or null. */
export function parseIPv6(s) {
  let str = String(s).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (!str.includes(':')) return null
  let tail = []
  const lastColon = str.lastIndexOf(':')
  const maybeV4 = str.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4)
    if (v4 === null) return null
    tail = [Number((v4 >> 16n) & 0xffffn).toString(16), Number(v4 & 0xffffn).toString(16)]
    str = str.slice(0, lastColon + 1) + tail.join(':')
  }
  const halves = str.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

/**
 * An address as { version, n }. An IPv4-mapped IPv6 address (::ffff:192.0.2.1,
 * which dual-stack servers log) is read as the IPv4 address it carries, so it
 * matches IPv4 ranges.
 */
export function parseIp(s) {
  const t = String(s ?? '').trim()
  const v4 = parseIPv4(t)
  if (v4 !== null) return { version: 4, n: v4 }
  const v6 = parseIPv6(t)
  if (v6 === null) return null
  if (v6 >> 32n === 0xffffn) return { version: 4, n: v6 & 0xffffffffn }
  return { version: 6, n: v6 }
}

/** "192.0.2.0/24" or "2001:db8::/32" (or a bare address, a /32 or /128) as { version, n, bits }. */
export function parseCidr(s) {
  const [addr, len] = String(s).trim().split('/')
  const ip = parseIp(addr)
  if (!ip) return null
  const width = ip.version === 4 ? 32 : 128
  const bits = len === undefined ? width : Number(len)
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null
  return { ...ip, bits, text: String(s).trim() }
}

export function inCidr(ip, cidr) {
  if (!ip || !cidr || ip.version !== cidr.version) return false
  const shift = BigInt((ip.version === 4 ? 32 : 128) - cidr.bits)
  return ip.n >> shift === cidr.n >> shift
}

/**
 * Every CIDR range in a vendor's published JSON, whatever its shape: Google,
 * Bing, OpenAI and Perplexity publish { prefixes: [{ ipv4Prefix }, { ipv6Prefix }] },
 * others a plain list or { prefixes: ["..."] }. Any string value that parses as
 * a range or an address counts.
 */
export function rangesFromJson(json) {
  const out = []
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/^[0-9a-f:.]+(?:\/\d{1,3})?$/i.test(v.trim()) && /[.:]/.test(v)) {
        const c = parseCidr(v)
        if (c) out.push(c)
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(json)
  return out
}

export const ipInRanges = (ip, ranges) => ranges.some((c) => inCidr(ip, c))

/* ---- log lines ------------------------------------------------------------------ */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** "10/Oct/2026:13:55:36 +0100" as epoch milliseconds, or null. */
export function parseClfTime(s) {
  const m = String(s).match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?/)
  if (!m) return null
  const month = MONTHS[m[2].toLowerCase()]
  if (month === undefined) return null
  let t = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  if (m[7]) t -= (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000
  return t
}

/** A timestamp in any common shape (ISO string, epoch s, ms, microseconds or nanoseconds) as epoch ms. */
export function parseAnyTime(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' || /^\d+(?:\.\d+)?$/.test(String(v))) {
    const n = Number(v)
    if (n > 1e17) return Math.floor(n / 1e6)
    if (n > 1e14) return Math.floor(n / 1e3)
    if (n > 1e11) return Math.floor(n)
    return Math.floor(n * 1000)
  }
  const clf = parseClfTime(v)
  if (clf !== null) return clf
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

const Q = '"((?:[^"\\\\]|\\\\.)*)"'
const COMBINED = new RegExp(`^(\\S+) \\S+ (?:\\S+|"[^"]*") \\[([^\\]]+)\\] ${Q} (\\d{3}|-) (\\S+)(?: ${Q} ${Q})?`)
const VHOST_COMBINED = new RegExp(`^\\S+ (\\S+) \\S+ (?:\\S+|"[^"]*") \\[([^\\]]+)\\] ${Q} (\\d{3}|-) (\\S+)(?: ${Q} ${Q})?`)

const unescape = (s) => (s ?? '').replace(/\\(["\\])/g, '$1').replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))

/** "GET /path HTTP/1.1" as { method, path }; a full URL in the request line is reduced to its path. */
export function parseRequestLine(r) {
  const m = String(r).match(/^([A-Z]+) (\S+)(?: HTTP\/[\d.]+)?$/)
  if (!m) return { method: null, path: null }
  return { method: m[1], path: pathOnly(m[2]) }
}

function pathOnly(p) {
  if (!p) return null
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p)
      return `${u.pathname}${u.search}`
    } catch {
      return p
    }
  }
  return p
}

const FIELDS = {
  ip: ['clientip', 'ip', 'client_ip', 'clientipaddress', 'remote_addr', 'remoteaddr', 'remote_ip', 'remoteip', 'c-ip', 'client_address', 'clientaddress'],
  ua: ['clientrequestuseragent', 'useragent', 'user_agent', 'ua', 'http_user_agent', 'user-agent', 'cs(user-agent)', 'requestuseragent'],
  status: ['edgeresponsestatus', 'status', 'statuscode', 'status_code', 'response_status', 'responsestatus', 'sc-status', 'http_status', 'originresponsestatus'],
  path: ['clientrequesturi', 'clientrequestpath', 'path', 'uri', 'request_uri', 'requesturi', 'requestpath', 'url', 'cs-uri-stem'],
  time: ['edgestarttimestamp', 'timestamp', 'time', '@timestamp', 'datetime', 'date', 'time_local', 'time_iso8601', 'start_time', 'requesttime'],
  method: ['clientrequestmethod', 'method', 'request_method', 'requestmethod'],
  request: ['request'],
}

/** Lower-cased keys of an object and of the objects nested in it (two levels), first occurrence wins. */
function flatten(obj, out = new Map(), depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase()
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (depth < 2) flatten(v, out, depth + 1)
      continue
    }
    if (!out.has(key)) out.set(key, v)
  }
  return out
}

function parseJsonLine(line) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const flat = flatten(obj)
  const get = (names) => {
    for (const n of names) if (flat.has(n) && flat.get(n) !== null && flat.get(n) !== '') return flat.get(n)
    return undefined
  }
  let ua = get(FIELDS.ua)
  if (Array.isArray(ua)) ua = ua[0]
  let path = get(FIELDS.path)
  let method = get(FIELDS.method) ?? null
  const request = get(FIELDS.request)
  if (!path && typeof request === 'string') ({ method, path } = parseRequestLine(request))
  const status = Number(get(FIELDS.status))
  const ip = get(FIELDS.ip)
  if (ip === undefined && ua === undefined && !path) return null
  return {
    format: 'json',
    ip: ip === undefined ? null : String(ip).split(',')[0].trim(),
    time: parseAnyTime(get(FIELDS.time)),
    method: method ? String(method) : null,
    path: path ? pathOnly(String(path)) : null,
    status: Number.isInteger(status) && status > 0 ? status : null,
    ua: ua === undefined ? null : String(ua),
  }
}

/** One log line as { format, ip, time, method, path, status, ua }, or null when it is not a format this reads. */
export function parseLogLine(line) {
  const s = String(line).trim()
  if (!s) return null
  if (s.startsWith('{')) return parseJsonLine(s)
  const m = s.match(COMBINED) ?? s.match(VHOST_COMBINED)
  if (!m) return null
  const { method, path } = parseRequestLine(unescape(m[3]))
  const hasUa = m[7] !== undefined
  return {
    format: hasUa ? 'combined' : 'common',
    ip: m[1],
    time: parseClfTime(m[2]),
    method,
    path,
    status: m[4] === '-' ? null : Number(m[4]),
    ua: hasUa ? unescape(m[7]) : null,
  }
}

/* ---- crawlers ---------------------------------------------------------------------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Matchers for every roster crawler that sends a user agent: its product token,
 * case-insensitive, standing alone. "Googlebot" must not match
 * "Googlebot-Image" or "AdsBot-Google", so the characters either side may not
 * be a letter, digit, hyphen or underscore. Control tokens (Google-Extended,
 * Applebot-Extended) are skipped: no crawler sends them.
 */
export function botMatchers(roster) {
  return roster
    .filter((b) => b.token && b.purpose !== 'control-token')
    .map((b) => ({ bot: b, re: new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRe(b.token)}(?![A-Za-z0-9_-])`, 'i') }))
    .sort((a, b) => b.bot.token.length - a.bot.token.length)
}

/** The roster crawler a user agent names, or null. The longest matching token wins. */
export function matchBot(ua, matchers) {
  if (!ua) return null
  for (const m of matchers) if (m.re.test(ua)) return m.bot
  return null
}

/* ---- aggregation --------------------------------------------------------------------- */

export const statusClass = (s) => (s === null || s === undefined ? 'unknown' : s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : s >= 200 ? '2xx' : 'other')

/** Requests a crawler was turned away from: 403, 429 and every 5xx. */
export const isRefusal = (s) => s === 403 || s === 429 || (s !== null && s >= 500)

/** Running totals for a whole log, kept small: per crawler, per URL and per IP, never per line. */
export class LogStats {
  constructor(matchers) {
    this.matchers = matchers
    this.lines = 0
    this.parsed = 0
    this.unparsed = 0
    this.noUa = 0
    this.formats = {}
    this.first = null
    this.last = null
    this.other = 0
    this.bots = new Map()
    this.unparsedSample = null
  }

  addLine(line) {
    if (!String(line).trim()) return
    this.lines++
    const e = parseLogLine(line)
    if (!e) {
      this.unparsed++
      this.unparsedSample ??= String(line).slice(0, 160)
      return
    }
    this.add(e)
  }

  add(e) {
    this.parsed++
    this.formats[e.format] = (this.formats[e.format] ?? 0) + 1
    if (e.time !== null) {
      if (this.first === null || e.time < this.first) this.first = e.time
      if (this.last === null || e.time > this.last) this.last = e.time
    }
    if (!e.ua) {
      this.noUa++
      return
    }
    const bot = matchBot(e.ua, this.matchers)
    if (!bot) {
      this.other++
      return
    }
    if (!this.bots.has(bot.token)) {
      this.bots.set(bot.token, { bot, requests: 0, urls: new Map(), status: {}, robots: { count: 0, status: {} }, ips: new Map(), first: null, last: null })
    }
    const b = this.bots.get(bot.token)
    b.requests++
    const code = e.status ?? 'unknown'
    b.status[code] = (b.status[code] ?? 0) + 1
    const path = e.path ?? '(no path)'
    if (path.replace(/\?.*$/, '') === '/robots.txt') {
      b.robots.count++
      b.robots.status[code] = (b.robots.status[code] ?? 0) + 1
    } else {
      b.urls.set(path, (b.urls.get(path) ?? 0) + 1)
    }
    const ip = e.ip ?? '(no ip)'
    if (!b.ips.has(ip)) b.ips.set(ip, { count: 0, status: {} })
    const i = b.ips.get(ip)
    i.count++
    i.status[code] = (i.status[code] ?? 0) + 1
    if (e.time !== null) {
      if (b.first === null || e.time < b.first) b.first = e.time
      if (b.last === null || e.time > b.last) b.last = e.time
    }
  }
}

/** Share of each status class in a { code: count } map. */
export function statusMix(status) {
  const mix = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 }
  let total = 0
  let refused = 0
  for (const [code, n] of Object.entries(status)) {
    const c = code === 'unknown' ? null : Number(code)
    const k = statusClass(c)
    mix[k === 'unknown' ? 'other' : k] += n
    total += n
    if (isRefusal(c)) refused += n
  }
  return { counts: mix, total, refused, refusedShare: total ? refused / total : 0 }
}

/** Merge several { code: count } maps. */
export function mergeStatus(maps) {
  const out = {}
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v
  return out
}
