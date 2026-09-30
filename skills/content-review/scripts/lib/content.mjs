/**
 * Shared helpers for the content-review scripts: a small document model for
 * Markdown and HTML drafts, and the decision rules the scripts apply. The
 * rules live here rather than inside each script so the tests pin the shipped
 * logic, not a copy of it that agrees with itself.
 */

import { decodeEntities, stripComments } from '../shared/html.mjs'

/* ---- reading a document -------------------------------------------------- */

/** Markdown or HTML, by extension first and content second. */
export function detectFormat(name, text) {
  if (/\.html?$/i.test(name ?? '')) return 'html'
  if (/\.(?:md|mdx|markdown|txt)$/i.test(name ?? '')) return 'markdown'
  return /^\s*(?:<!doctype html|<html\b|<body\b|<article\b|<main\b|<p\b|<h[1-6]\b)/i.test(text) ? 'html' : 'markdown'
}

/**
 * HTML to a Markdown-like text, so both formats go through one parser. Links
 * become [text](url), headings become #, blocks become blank lines. Scripts,
 * styles, code, preformatted text and anything marked data-verbatim are
 * dropped, because a literal or a quoted specimen is not the author's prose.
 */
export function htmlToMarkdownish(html) {
  // Comments go first, but not the look-alikes inside a script string: a
  // '<!--' in inline JavaScript would otherwise swallow the prose after it.
  let s = stripComments(html)
    .replace(/<(script|style|template|noscript|svg|pre|code)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z]+)\b[^>]*\sdata-verbatim\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const bodyStart = s.search(/<body\b/i)
  if (bodyStart !== -1) s = s.slice(bodyStart)
  s = s
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, a, b, c, inner) => `[${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}](${decodeEntities(a ?? b ?? c)})`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n\n- ')
    .replace(/<\/?(?:p|div|ul|ol|li|section|article|header|footer|nav|main|aside|figure|figcaption|blockquote|table|thead|tbody|tr|td|th|dl|dt|dd|details|summary|br|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(s)
}

const SOURCES_HEADING = /^(?:sources?|references?|bibliography|citations?|further reading|notes and sources|works cited)\b/i

/**
 * Parse a Markdown (or converted HTML) document into sections, paragraphs and
 * links. Front matter and fenced code are removed first.
 */
export function parseDocument(text, format = 'markdown') {
  let md = format === 'html' ? htmlToMarkdownish(text) : String(text)
  md = md.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  // Fenced code, including a fence indented inside a list item, and an
  // unclosed fence, which CommonMark runs to the end of the document.
  md = md.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, '\n')

  // Reference-style link definitions: [ref]: https://...
  const refs = new Map()
  md = md.replace(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(].*["')])?[ \t]*$/gm, (_, ref, url) => {
    refs.set(ref.toLowerCase(), url)
    return `[${ref}](${url})`
  })

  const sections = []
  let current = { heading: null, level: 0, blocks: [] }
  sections.push(current)
  for (const rawBlock of md.split(/\r?\n\s*\r?\n/)) {
    const block = rawBlock.replace(/\s+$/g, '')
    if (!block.trim()) continue
    const lines = block.split(/\r?\n/)
    let buffer = []
    const flush = () => {
      if (buffer.length) current.blocks.push(buffer.join(' ').replace(/\s+/g, ' ').trim())
      buffer = []
    }
    for (const line of lines) {
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (h) {
        flush()
        current = { heading: stripInline(h[2]).trim(), level: h[1].length, blocks: [] }
        sections.push(current)
      } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        flush()
        buffer.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
      } else if (/^\s*\|/.test(line)) {
        flush()
        current.blocks.push(line.replace(/\|/g, ' ').replace(/:?-{3,}:?/g, ' ').replace(/\s+/g, ' ').trim())
      } else {
        buffer.push(line.replace(/^\s*>\s?/, ''))
      }
    }
    flush()
  }

  const doc = { format, sections: sections.filter((s) => s.heading !== null || s.blocks.length) }
  for (const s of doc.sections) {
    s.isSources = Boolean(s.heading && SOURCES_HEADING.test(s.heading))
    s.paragraphs = s.blocks.filter((b) => b.trim()).map((b) => ({ raw: b, text: stripInline(b), links: linksIn(b, refs) }))
  }
  // A sources section runs until the next heading at the same or a higher level.
  let sourcesLevel = null
  for (const s of doc.sections) {
    if (s.isSources) sourcesLevel = s.level
    else if (sourcesLevel !== null && s.heading && s.level > sourcesLevel) s.isSources = true
    else sourcesLevel = null
  }
  doc.links = doc.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.links))
  return doc
}

/** Inline Markdown to plain text: links keep their text, emphasis and code marks go. */
export const stripInline = (s) =>
  String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')

/** A bare URL. A backtick never belongs to one, any more than a closing bracket does. */
const BARE_URL = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/gi

/**
 * Inline code spans blanked to spaces (same length, so positions hold). A
 * URL in a code span is an example or a literal, `https://example.com/de/`,
 * not a citation, and reading it as one fetched "https://example.com/de/%60"
 * with the closing backtick glued on.
 */
const withoutCodeSpans = (s) => s.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length))

/** Links in one block: inline, reference-style, autolinks and bare URLs, never inside inline code. */
export function linksIn(block, refs = new Map()) {
  const out = []
  const s = withoutCodeSpans(String(block))
  for (const m of s.matchAll(/(?<!!)\[([^\]]*)\]\(\s*<?((?:[^()\s]|\([^)]*\))+?)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ text: stripInline(m[1]), url: m[2], index: m.index })
  for (const m of s.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const url = refs.get((m[2] || m[1]).toLowerCase())
    if (url) out.push({ text: m[1], url, index: m.index })
  }
  const covered = out.map((l) => l.url)
  for (const m of s.matchAll(BARE_URL)) if (!covered.some((u) => u.includes(m[0]))) out.push({ text: '', url: m[0], index: m.index })
  return out.sort((a, b) => a.index - b.index).map(({ text, url }) => ({ text, url }))
}

/** Every external http(s) URL in a document, de-duplicated, in order. */
export function externalUrls(doc) {
  const seen = new Set()
  const out = []
  for (const l of doc.links) {
    let u
    try {
      u = new URL(l.url)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    u.hash = ''
    if (seen.has(u.href)) continue
    seen.add(u.href)
    out.push({ url: u.href, text: l.text })
  }
  return out
}

/** Sentences in a paragraph. Approximate, and good enough for the rules here. */
export const sentences = (text) =>
  String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean)

export const countWords = (s) => String(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/* ---- figures ---------------------------------------------------------------- */

/**
 * A figure a reader would expect to be sourced: a percentage in any of the
 * spellings in use ("%", "per cent", "percent"), a multiplier ("3x",
 * "3 times") or a million or billion count. A check that matched "percent"
 * alone would report zero figures in a draft written with "per cent", however
 * many it had.
 */
export const FIGURE_RE = /\b\d[\d,]*(?:\.\d+)?\s?(?:%|per\s?cent\b|percent\b|x\b|times\b|million\b|billion\b)/gi

/** The numeric core of a figure ("44.2 per cent" gives "44.2", "1,885 times" gives "1885"). */
export const figureCore = (figure) => figure.match(/\d[\d,]*(?:\.\d+)?/)[0].replace(/,/g, '')

/**
 * Figures that nothing on the page accounts for.
 *
 * A figure counts as sourced when (a) the sentence it sits in carries a link,
 * (b) its number appears in the text or URL of any link on the page, or (c)
 * its number appears in a "Sources" or "References" section. That is
 * deliberately generous: the check exists to find the number nobody can trace,
 * and it cannot judge whether a link supports the claim. That half is the
 * content-review skill's section 1, and a person does it.
 */
export function unsourcedFigures(doc) {
  const linkHaystack = doc.links.map((l) => `${l.text} ${l.url}`).join(' ')
  const sourcesHaystack = doc.sections.filter((s) => s.isSources).flatMap((s) => s.paragraphs.map((p) => p.raw)).join(' ')
  const haystack = `${linkHaystack} ${sourcesHaystack}`.replace(/(\d),(\d)/g, '$1$2')
  const seen = new Set()
  const out = []
  for (const section of doc.sections) {
    if (section.isSources) continue
    for (const p of section.paragraphs) {
      for (const sentence of sentences(p.raw)) {
        const sentenceHasLink = linksIn(sentence).length > 0
        for (const m of stripInline(sentence).matchAll(FIGURE_RE)) {
          const core = figureCore(m[0])
          if (seen.has(core)) continue
          seen.add(core)
          if (sentenceHasLink) continue
          if (new RegExp(`(?<![\\d.])${core.replace(/\./g, '\\.')}(?![\\d])`).test(haystack)) continue
          out.push({ figure: m[0].trim(), sentence: stripInline(sentence).slice(0, 140), section: section.heading })
        }
      }
    }
  }
  return out
}

/* ---- readability -------------------------------------------------------------- */

/**
 * Flesch-Kincaid grade level. Approximate by design (syllables are counted by
 * vowel groups), so compare sections with each other and drafts with earlier
 * drafts rather than reading the number as exact.
 */
export function fkGrade(text) {
  const t = stripInline(text)
  const sentenceCount = t.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().split(/\s+/).length > 2).length || 1
  const words = t.split(/\s+/).filter((w) => /[a-z]/i.test(w))
  if (words.length === 0) return 0
  const syllables = words.reduce((total, word) => {
    const w = word.toLowerCase().replace(/[^a-z]/g, '')
    if (w.length <= 3) return total + 1
    const groups = w.replace(/(?:es|ed|[^l]e)$/, '').match(/[aeiouy]{1,2}/g)
    return total + (groups ? groups.length : 1)
  }, 0)
  return 0.39 * (words.length / sentenceCount) + 11.8 * (syllables / words.length) - 15.59
}

/* ---- source status ---------------------------------------------------------------- */

/**
 * What an HTTP status means for a citation. Narrower than "not 200" on
 * purpose: a 404 or 410 is a dead citation. A 401, 403, 429 or 5xx is bot
 * protection or a bad afternoon at the origin, and many publishers serve
 * exactly that to a script while being alive in a browser. Those are "could
 * not be checked", never a pass and never a failure. A status of 0 (no
 * answer, timeout) is the same.
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 400) return 'ok'
  if (status === 404 || status === 410) return 'dead'
  return 'unknown'
}

/* ---- passage overlap ------------------------------------------------------------------ */

/**
 * Default thresholds, derived on one corpus of 18 long-form articles (154
 * sections, 11,163 cross-article pairs): median 0.0000, p90 0.0000, p99
 * 0.0063, max 0.0758. The distribution was a floor of zero with a handful of
 * pairs standing off it, and those were real restatements. WARN sits at about
 * 8x p99 and FAIL above every pair that corpus contained. Your corpus is not
 * that one: run with --report and set your own.
 */
export const OVERLAP_WARN_AT = 0.05
export const OVERLAP_FAIL_AT = 0.1

/**
 * Five-word shingles. On the same corpus, three-word runs lifted the baseline
 * off zero (ordinary English repeats them) and seven-word runs compressed the
 * signal; five gave a zero floor and the widest gap to the real overlaps.
 */
export const OVERLAP_SHINGLE = 5

export function shingles(text, n = OVERLAP_SHINGLE) {
  const words = stripInline(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const out = new Set()
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '))
  return out
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const s of small) if (large.has(s)) shared++
  return shared / (a.size + b.size - shared)
}
