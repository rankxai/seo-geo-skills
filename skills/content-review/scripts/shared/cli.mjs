// Generated copy of skills/seo-geo/scripts/lib/cli.mjs. Edit the original, then run: node scripts/sync-shared.mjs
/**
 * Shared plumbing for every script in this repository: argument parsing,
 * reading a URL, a local file or stdin, the report format, and exit codes.
 *
 * Node built-ins only (Node 18.17 or later, for the global fetch and
 * util.parseArgs), so the scripts run with no npm install.
 *
 * Exit codes are the same everywhere:
 *   0  clean: nothing at error level
 *   1  at least one finding at error level
 *   2  usage error (bad flag, missing argument, refused URL scheme)
 *   3  could not check (network failure, unreadable file, nothing fetched)
 *
 * Scripts set process.exitCode and return. They never call process.exit()
 * after printing, because on POSIX an immediate exit can cut off output that
 * is still being written to a pipe, and on Windows it can crash while fetch
 * still holds open sockets.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'

/** Kept equal to the plugin manifests' version; tests/validate-skills.mjs checks it. */
export const VERSION = '1.0.0'
export const USER_AGENT = `seo-geo-skills/${VERSION} (+https://github.com/rankxai/seo-geo-skills)`

export const EXIT = Object.freeze({ CLEAN: 0, FINDINGS: 1, USAGE: 2, UNCHECKED: 3 })

/** A current desktop Chrome, for the "is this a block on everyone?" control request. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

/**
 * Is this response a bot-protection wall rather than the site's own answer?
 * Returns a short description, or null.
 *
 * A wall must never be audited as if it were the page: a DataDome 403 carries
 * no title, no canonical and a noindex, and reporting those as the site's
 * defects is three false errors on a page that is fine for Googlebot. The
 * signals, each seen on real sites:
 *   cf-mitigated: challenge       Cloudflare challenge, any status
 *   x-amzn-waf-action             AWS WAF challenge or CAPTCHA
 *   x-vercel-mitigated            Vercel bot protection
 *   x-px-blocked                  HUMAN (PerimeterX)
 *   403 or 429                    refused; the vendor named from its headers
 *   202 Accepted                  how several challenge interstitials answer a
 *                                 page request (seen on a major travel site)
 * A 401 is deliberately not a wall: it is a login requirement, and a public
 * page behind one is a real defect.
 */
export function botWall(status, headers) {
  const h = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? ''
  if (/challenge/i.test(h('cf-mitigated'))) return 'a Cloudflare challenge (cf-mitigated: challenge)'
  if (h('x-amzn-waf-action')) return `an AWS WAF ${h('x-amzn-waf-action')} (x-amzn-waf-action)`
  if (h('x-vercel-mitigated')) return `Vercel bot protection (x-vercel-mitigated: ${h('x-vercel-mitigated')})`
  if (h('x-px-blocked')) return 'HUMAN (PerimeterX) bot protection (x-px-blocked)'
  if (status === 403 || status === 429) {
    const server = h('server')
    const vendor = h('x-datadome') || /datadome/i.test(server) ? 'DataDome'
      : /akamai/i.test(server) ? 'Akamai'
        : h('x-iinfo') || /imperva|incapsula/i.test(h('x-cdn')) ? 'Imperva'
          : h('x-sucuri-id') ? 'Sucuri'
            : /cloudflare/i.test(server) ? 'Cloudflare'
              : /cloudfront/i.test(server) ? 'CloudFront'
                : null
    return `HTTP ${status}${vendor ? ` from ${vendor}` : ''}`
  }
  if (status === 202) return 'HTTP 202 Accepted, which is how several bot-challenge interstitials answer a page request'
  return null
}

/** Thrown for anything the user can fix by changing the command line. */
export class UsageError extends Error {}

/**
 * Parse argv with util.parseArgs. Unknown flags are a usage error rather than
 * silently ignored, because a mistyped `--jsno` that quietly prints text is
 * worse than a refusal.
 */
export function parseCli(argv, options) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, ...options },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new UsageError(error.message)
  }
}

/** Parse a flag value as a whole number no smaller than `min`, or throw a usage error. */
export function intOption(value, name, fallback, min = 0) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be a whole number of at least ${min}, got "${value}"`)
  return n
}

/**
 * Decide what a positional argument is.
 *
 * `-` is stdin. http(s) URLs are fetched. Any other scheme (file:, ftp:,
 * javascript:, data:) is refused. A Windows drive path such as C:\x is a
 * file. A bare hostname such as example.com that is not an existing file is
 * treated as https://example.com, because that is what people type. A bare
 * name ending in a file extension (page.html, sitemap.xml.gz, robots.txt) is
 * a file that does not exist, never a hostname: "no such file" is the useful
 * answer, and a DNS error for https://page.html is not.
 */
const FILE_EXTENSION = /\.(?:html?|xhtml|xml|txt|gz|json|mdx|markdown)$/i

export function classifyArg(arg, { allowBareHost = true } = {}) {
  if (arg === '-') return { kind: 'stdin' }
  if (/^https?:\/\//i.test(arg)) return { kind: 'url', url: parseUrlArg(arg) }
  if (/^[a-z]:[\\/]/i.test(arg)) return { kind: 'file', path: arg }
  if (/^[a-z][a-z0-9+.-]*:/i.test(arg)) {
    throw new UsageError(`refusing "${arg}": only http and https URLs, local files and - (stdin) are accepted`)
  }
  if (existsSync(arg)) return { kind: 'file', path: arg }
  if (allowBareHost && !FILE_EXTENSION.test(arg) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(arg)) {
    return { kind: 'url', url: parseUrlArg(`https://${arg}`) }
  }
  return { kind: 'file', path: arg }
}

function parseUrlArg(arg) {
  try {
    return new URL(arg).href
  } catch {
    throw new UsageError(`"${arg}" is not a valid URL`)
  }
}

export async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * Response bodies are read to at most this many bytes. A page is judged
 * against Googlebot's 2 MB limit and a sitemap against the 50 MB protocol
 * limit, so nothing needs more, and a 1 GB response (or a decompression bomb
 * behind Content-Encoding: gzip) must not be read into memory to find that
 * out. Callers pass their own cap; a body cut short is marked `truncated`.
 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** Read a fetch Response body, stopping after `maxBytes`. Returns { buffer, truncated }. */
export async function readBody(res, maxBytes = DEFAULT_MAX_BYTES) {
  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    if (size + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size))
      size = maxBytes
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(chunk)
    size += chunk.length
  }
  return { buffer: Buffer.concat(chunks, size), truncated }
}

/**
 * The character encoding of a body, in the order a browser settles it: a
 * byte-order mark, then the Content-Type charset, then a <meta charset> or
 * http-equiv declaration (or an XML encoding declaration) near the top, then
 * UTF-8. Reading a Shift_JIS or windows-1252 page as UTF-8 turns every title
 * and heading into replacement characters.
 */
export function charsetOf(buffer, contentType) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8'
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le'
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be'
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')?.[1]
  if (header) return header.toLowerCase()
  const start = buffer.subarray(0, 4096).toString('latin1')
  const declared = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(start)?.[1] ?? /^\s*<\?xml\b[^>]*?encoding\s*=\s*["']([\w.:-]+)/i.exec(start)?.[1]
  // A document cannot declare itself UTF-16 from inside ASCII-compatible bytes; browsers read that as UTF-8.
  if (declared && !/^utf-?16/i.test(declared)) return declared.toLowerCase()
  return 'utf-8'
}

/**
 * Bytes 0x80 to 0x9F in windows-1252 (the WHATWG index), which is what the
 * Encoding standard decodes for "latin1", "iso-8859-1" and "windows-1252"
 * alike. Node 20's TextDecoder decodes them as C1 control codes instead
 * (measured on 20.20: 0x93 came back as U+0093, not a curly quote), so this
 * family is decoded by table, the same on every Node version.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
]
const decodeCp1252 = (buffer) => buffer.toString('latin1').replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]))

/** Decode a body by its charset. An encoding Node does not know falls back to UTF-8. */
export function decodeText(buffer, contentType) {
  const charset = charsetOf(buffer, contentType)
  try {
    const decoder = new TextDecoder(charset)
    if (decoder.encoding === 'windows-1252') return { text: decodeCp1252(buffer), charset }
    return { text: decoder.decode(buffer), charset }
  } catch {
    return { text: new TextDecoder('utf-8').decode(buffer), charset: 'utf-8', unsupportedCharset: charset }
  }
}

/**
 * GET a URL and return the body plus the facts the checks need. Never throws
 * for a network failure or a malformed URL: returns { error } instead, so a
 * caller can report "not checked" rather than crash.
 *
 * Redirects are followed by hand, at most `maxRedirects` hops, so a loop or a
 * long chain is reported as such (with `redirectLimit: true`) and the chain is
 * available to the caller. The timeout covers the whole exchange, redirects
 * and body included.
 *
 * `bytes` is the decoded body length. fetch removes gzip or brotli transfer
 * encoding, so this is the uncompressed size, which is what Googlebot's fetch
 * limit applies to. It stops at `maxBytes`, with `truncated: true`.
 */
export async function fetchPage(url, { userAgent = USER_AGENT, timeoutMs = 30_000, redirect = 'follow', maxRedirects = 10, maxBytes = DEFAULT_MAX_BYTES, accept, method = 'GET' } = {}) {
  let current
  try {
    current = new URL(url)
  } catch {
    return { url, error: `not a valid URL: ${url}` }
  }
  const chain = []
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    for (;;) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return { url, error: `refused non-http(s) URL ${current.href}`, redirectChain: chain }
      }
      const res = await fetch(current.href, {
        method,
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept: accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8' },
        signal,
      })
      const location = res.headers.get('location')
      if (redirect === 'follow' && res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
        await res.body?.cancel().catch(() => {})
        let next
        try {
          next = new URL(location, current)
        } catch {
          return { url, error: `redirect to an invalid Location "${location}"`, redirectChain: chain }
        }
        chain.push({ url: current.href, status: res.status, location: next.href })
        if (chain.some((hop) => hop.url === next.href)) {
          return { url, error: `redirect loop (${chain.map((h) => h.status).join(' > ')} back to ${next.href})`, redirectLimit: true, redirectChain: chain }
        }
        if (chain.length > maxRedirects) {
          return { url, error: `more than ${maxRedirects} redirects`, redirectLimit: true, redirectChain: chain }
        }
        current = next
        continue
      }
      const { buffer, truncated } = method === 'HEAD' ? { buffer: Buffer.alloc(0), truncated: false } : await readBody(res, maxBytes)
      const contentType = res.headers.get('content-type')
      const { text, charset } = decodeText(buffer, contentType)
      return {
        url,
        finalUrl: current.href,
        redirected: chain.length > 0,
        redirectChain: chain,
        status: res.status,
        headers: res.headers,
        contentType,
        bytes: buffer.length,
        truncated,
        buffer,
        text,
        charset,
      }
    }
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error)
    const timedOut = error?.name === 'TimeoutError' || (error?.name === 'AbortError' && signal.aborted)
    return { url, error: timedOut ? `timed out after ${timeoutMs} ms` : cause, redirectChain: chain }
  }
}

/**
 * Read a positional argument as text: a URL (fetched), a file, or stdin.
 * Returns { kind, text, bytes, url?, status?, headers?, finalUrl?, error? }.
 */
export async function readInput(arg, fetchOptions = {}, { allowBareHost = true } = {}) {
  const what = classifyArg(arg, { allowBareHost })
  if (what.kind === 'stdin') {
    const buf = await readStdin()
    return { kind: 'stdin', ...decodeText(buf, null), buffer: buf, bytes: buf.length }
  }
  if (what.kind === 'file') {
    try {
      if (statSync(what.path).isDirectory()) return { kind: 'file', path: what.path, error: `${what.path} is a directory` }
      const buf = await readFile(what.path)
      return { kind: 'file', path: what.path, ...decodeText(buf, null), buffer: buf, bytes: buf.length }
    } catch (error) {
      return { kind: 'file', path: what.path, error: error.code === 'ENOENT' ? `no such file: ${what.path}` : error.message }
    }
  }
  const page = await fetchPage(what.url, fetchOptions)
  return { kind: 'url', ...page }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---- report output ------------------------------------------------------ */

const useColour = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const COLOURS = { error: 31, warn: 33, info: 36, 'not-checked': 35 }
const LABELS = { error: 'ERROR', warn: 'WARN ', info: 'info ', 'not-checked': 'NOT CHECKED' }

export function label(level) {
  const text = LABELS[level] ?? level
  return useColour() && COLOURS[level] ? `\u001b[${COLOURS[level]}m${text}\u001b[0m` : text
}

/** One finding per line: level, rule id, message. */
export function formatFinding(f, indent = '  ') {
  return `${indent}${label(f.level)}  ${f.rule}: ${f.message}`
}

export function countLevels(findings) {
  const counts = { error: 0, warn: 0, info: 0, 'not-checked': 0 }
  for (const f of findings) counts[f.level] = (counts[f.level] ?? 0) + 1
  return counts
}

export function summaryLine(findings) {
  const c = countLevels(findings)
  const parts = [`${c.error} error(s)`, `${c.warn} warning(s)`, `${c.info} info`]
  if (c['not-checked']) parts.push(`${c['not-checked']} NOT checked`)
  return parts.join(', ')
}

export const exitFor = (findings) => (findings.some((f) => f.level === 'error') ? EXIT.FINDINGS : EXIT.CLEAN)

/**
 * Standard entry point. `main` returns an exit code; usage errors print the
 * help text to stderr and exit 2; anything unexpected prints the stack and
 * exits 3, because a crash means the input was not checked.
 */
export async function runMain(main, help) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${help}\n`)
      process.exitCode = EXIT.USAGE
    } else {
      process.stderr.write(`could not check: ${error?.stack || error}\n`)
      process.exitCode = EXIT.UNCHECKED
    }
  } finally {
    await closeConnections()
  }
}

/**
 * Close fetch's pooled keep-alive sockets before the process exits.
 *
 * On Windows, Node 23 and later can abort at exit with a libuv assertion
 * ("!(handle->flags & UV_HANDLE_CLOSING)", exit code 3221226505) when fetch
 * sockets are still closing (nodejs/node#56645, open against 24.x). The
 * September 2026 panel hit it twice in about 120 live runs, each time losing
 * the whole report. Closing the global dispatcher first, capped at a second
 * so a hung socket cannot hold the exit, is the mitigation; it cannot make
 * the Node bug impossible.
 */
async function closeConnections() {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]
  if (typeof dispatcher?.close !== 'function') return
  let timer
  await Promise.race([
    Promise.resolve(dispatcher.close()).catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 1000)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
}
