/**
 * Small, dependency-free HTML helpers. This is not a full HTML parser and does
 * not try to be one: it reads the handful of elements an SEO check needs (the
 * head's meta and link tags, headings, images, JSON-LD) and turns a page into
 * plain prose for the text rules.
 *
 * Regex-based reading is good enough here because every check works on
 * server-rendered markup as a crawler receives it, and the failure mode of an
 * unusual page is a missed finding, never a false one on an ordinary page.
 */

/** Decode the named and numeric entities that matter for text checks. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, '\u00A0')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&hellip;/gi, '...')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/**
 * Parse a tag's attributes into a Map of lower-cased name to decoded value.
 * Handles double quotes, single quotes, unquoted values and bare attributes.
 * In `href=https://example.com/a/>` the slash belongs to the unquoted value
 * (HTML spec); only a slash standing on its own before `>` is the
 * self-closing mark.
 */
export function parseAttrs(tag) {
  const attrs = new Map()
  const inner = tag.replace(/^<\s*[a-z0-9-]+/i, '').replace(/>$/, '').replace(/(^|[\s"'])\/$/, '$1')
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const m of inner.matchAll(re)) {
    const name = m[1].toLowerCase()
    if (attrs.has(name)) continue
    attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return attrs
}

/**
 * Comments, and the raw-text elements a comment marker inside of is just
 * text. Matched left to right in one pass, so `<!--` inside a script string
 * does not swallow the page up to the next `-->`, and a script inside a
 * comment is not a script. An unterminated comment or script runs to the end
 * of the document, as it does in a browser.
 */
const COMMENT_OR_RAW = /<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<(script|style|textarea|xmp|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi

/** Remove comments (not the look-alikes inside scripts and styles). */
export const stripComments = (html) => String(html).replace(COMMENT_OR_RAW, (m, raw) => (raw ? m : ' '))

/**
 * The document with the CONTENT of scripts, styles, templates, noscript and
 * textarea removed (the tags themselves stay). Structure checks run on this,
 * so a `<link rel=canonical>` written inside a script string, or a `<body>`
 * inside a document.write call, is not mistaken for markup.
 */
export const maskRawText = (html) =>
  String(html).replace(/<(script|style|template|noscript|textarea|xmp)\b([^>]*)>[\s\S]*?(?:<\/\1\s*>|$)/gi, (_, tag, attrs) => `<${tag}${attrs}></${tag}>`)

/**
 * Every opening tag of `name`, as { raw, attrs, index }. Quote-aware: a `>`
 * inside a quoted attribute value (content="a > b") does not end the tag.
 */
export function findTags(html, name) {
  const s = String(html)
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'gi')
  const out = []
  let m
  while ((m = re.exec(s))) {
    let i = m.index + m[0].length
    let quote = null
    let last = ''
    for (; i < s.length; i++) {
      const c = s[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '>') break
      if ((c === '"' || c === "'") && last === '=') {
        quote = c
        continue
      }
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f') last = c
    }
    const raw = s.slice(m.index, i + 1)
    out.push({ raw, attrs: parseAttrs(raw), index: m.index })
    re.lastIndex = i + 1
  }
  return out
}

/**
 * The <head> section. It ends at </head> or at the first <body>, whichever
 * comes first (a page with no </head> still has a body). A document with
 * neither is all head. Pass masked HTML (maskRawText) so markup inside
 * scripts cannot move the boundary.
 */
export function headOf(html) {
  const ends = [html.search(/<\/head\s*>/i), html.search(/<body[\s>]/i)].filter((i) => i !== -1)
  return ends.length ? html.slice(0, Math.min(...ends)) : html
}

/** The <body> content: from <body> (or the end of the head) to </body>. */
export function bodyOf(html) {
  const open = html.search(/<body[\s>]/i)
  const start = open !== -1 ? open : html.search(/<\/head\s*>/i)
  if (start === -1) return html
  const close = html.slice(start).search(/<\/body\s*>/i)
  return html.slice(start, close === -1 ? undefined : start + close)
}

/** Remove elements whose content is never visible page text. */
export function withoutNonText(html) {
  return stripComments(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
}

/**
 * Visible text of the body, as a crawler that does not run JavaScript sees
 * it. Used for the "is there server-rendered content at all" rule.
 */
export function visibleText(html) {
  return decodeEntities(withoutNonText(bodyOf(html)).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fold typographic variants back to plain ones before any text rule runs.
 * A curly apostrophe is not `'` and a non-breaking space is not a space; miss
 * either and every rule that looks for a contraction goes blind on exactly
 * the copy that a CMS or a designer produces. Em dashes are NOT folded: a
 * separate rule reports them, and folding would hide it.
 */
export const normalise = (t) =>
  String(t)
    .replace(/\u2011/g, '-')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A page's own PROSE, for the writing rules and the myth scan.
 *
 * Code spans, preformatted blocks and anything marked data-verbatim are
 * removed, because a literal or a quoted specimen is not the author's copy: a
 * teaching page that shows a bad example would otherwise fail for containing
 * the example it is warning about.
 *
 * Every block boundary becomes a full stop. Headings, table cells, list items
 * and buttons carry no terminal punctuation, so stripping tags naively welds
 * the end of one element onto the start of the next, and every rule that
 * reasons about a sentence then reports sentences nobody wrote.
 */
const BLOCK =
  'p|div|li|ul|ol|h[1-6]|td|th|tr|section|article|header|footer|nav|main|aside' +
  '|figure|figcaption|blockquote|dt|dd|dl|summary|details|button|label|caption' +
  '|form|fieldset|legend|hr|br|table|thead|tbody'

export function proseFromHtml(html) {
  const text = withoutNonText(html)
    .replace(/<(pre|code)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z]+)\b[^>]*\sdata-verbatim\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), ' . ')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
}

/**
 * Invisible and direction-changing characters.
 *
 * Not a style issue: there is no legitimate use for these inside ENGLISH (or
 * any Latin, Greek or Cyrillic) copy. Zero-width characters break the word
 * boundaries every text rule depends on (a U+200B inside a word hides it from
 * any word list), bidirectional overrides can make displayed text differ from
 * stored text, and the Unicode TAG block (U+E0000 to U+E007F) is a known
 * carrier for hidden instructions aimed at a model reading the page.
 *
 * But several of them are ordinary spelling elsewhere, and a rule that fires
 * on correct text gets switched off:
 *   U+200C ZWNJ   required in Persian, Urdu, and the Indic scripts
 *                 (measured: 551 on one BBC Persian front page)
 *   U+200D ZWJ    Indic conjuncts and every multi-person or flag emoji
 *   U+200B ZWSP   the word-break hint in Thai, Lao, Khmer and Burmese text
 *   U+2060 WJ     the no-break glue typographers put before a dash
 *   U+200E/F, U+202A-C, U+2066-9
 *                 LRM, RLM, embeddings and isolates, routine in any page
 *                 that mixes right-to-left and left-to-right text
 * So the four joiners are reported only BETWEEN two Latin, Greek, Cyrillic
 * or Armenian letters or digits, which is where they hide a word, and the soft
 * bidi marks only on a page with no right-to-left script at all. The
 * overrides U+202D and U+202E (the Trojan Source characters), a U+FEFF that is
 * not the first character, U+2061-2064 and the TAG block are always reported.
 *
 * Deliberately excluded: U+00A0 and U+202F (no-break spaces). Both are used
 * on purpose to keep a number with its unit.
 */
export const INVISIBLE_CHARS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu

const JOINERS = new Set([0x200b, 0x200c, 0x200d, 0x2060])
const SOFT_BIDI = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x2066, 0x2067, 0x2068, 0x2069])
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Nd}]/u
const RTL_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u

const charAt = (s, i) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)) : undefined)
function charBefore(s, i) {
  if (i <= 0) return undefined
  const low = s.charCodeAt(i - 1)
  return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1]
}

/** Each reportable invisible character in `text`, as a readable code point. */
export function findInvisible(text) {
  const s = String(text)
  const rtl = RTL_SCRIPT.test(s)
  const out = []
  for (const m of s.matchAll(INVISIBLE_CHARS)) {
    const cp = m[0].codePointAt(0)
    if (JOINERS.has(cp)) {
      const before = charBefore(s, m.index)
      const after = charAt(s, m.index + m[0].length)
      if (!(before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after))) continue
    }
    if (SOFT_BIDI.has(cp) && rtl) continue
    out.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  return out
}

/** Count of each code point, e.g. "U+200B x3, U+FEFF". */
export function summariseCodePoints(list) {
  const counts = new Map()
  for (const c of list) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(', ')
}

export const wordCount = (s) => String(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
