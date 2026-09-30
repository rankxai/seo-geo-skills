/**
 * llms.txt validator, following the format proposed at https://llmstxt.org:
 *
 *   - an optional byte-order mark
 *   - ONE H1 naming the site, the only required element
 *   - then, in order: an optional blockquote summary; any markdown except
 *     headings; then H2-delimited sections whose entries are markdown links,
 *     "- [name](url)", each with an optional ": notes" suffix
 *   - an H2 named "Optional" marks links a reader may skip for short context
 *
 * Why the checker never scores a missing file as a failure: no major AI
 * search engine documents reading llms.txt, and Google says the files "aren't
 * needed for Google Search (and won't negatively or positively impact your
 * visibility or rankings)". A file that exists should be well formed; a site
 * without one has lost nothing anyone has measured.
 */

const LINK_ITEM = /^[-*]\s+\[[^\]]+\]\([^)\s]+\)(?::\s*.+)?$/

export function validateLlmsTxt(body) {
  const issues = []
  const sections = []
  let h1 = null
  let hasSummary = false
  let totalLinks = 0

  const lines = String(body).replace(/^\uFEFF/, '').split(/\r?\n/)
  let position = 'pre-h1'
  let currentSection = null
  let sawProse = false

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd()
    const lineNo = index + 1
    if (!line.trim()) return

    const h1Match = line.match(/^#\s+(.+)$/)
    const h2Match = line.match(/^##\s+(.+)$/)
    const deep = line.match(/^(###+)\s+/)

    if (deep) {
      issues.push({ line: lineNo, rule: 'no-deep-headings', message: `H${deep[1].length} headings are not part of the format; only one H1 and H2 section headers are defined` })
      return
    }
    if (h1Match) {
      if (h1 !== null) issues.push({ line: lineNo, rule: 'single-h1', message: 'more than one H1; the file should have exactly one, naming the site' })
      else if (position !== 'pre-h1') issues.push({ line: lineNo, rule: 'h1-first', message: 'the H1 must come first' })
      h1 = h1 ?? h1Match[1].trim()
      if (position === 'pre-h1') position = 'post-h1'
      return
    }
    if (position === 'pre-h1') {
      issues.push({ line: lineNo, rule: 'h1-first', message: 'content before the H1; the file should open with a single H1 naming the site' })
      return
    }
    if (h2Match) {
      position = 'in-sections'
      currentSection = { name: h2Match[1].trim(), links: 0, badLines: [] }
      sections.push(currentSection)
      return
    }
    if (position === 'in-sections') {
      if (/^[-*]\s/.test(line)) {
        if (LINK_ITEM.test(line.trim())) {
          currentSection.links += 1
          totalLinks += 1
        } else {
          currentSection.badLines.push(lineNo)
        }
      }
      return
    }
    if (line.startsWith('>')) {
      if (!sawProse) hasSummary = true
      return
    }
    sawProse = true
  })

  // One issue per section, not per line: a section of prose bullets would
  // otherwise print the same sentence twenty times.
  for (const s of sections) {
    if (!s.badLines.length) continue
    const n = s.badLines.length
    const where = n === 1 ? `line ${s.badLines[0]}` : `lines ${s.badLines[0]} to ${s.badLines[n - 1]}`
    issues.push({ line: s.badLines[0], rule: 'link-item', message: `section "${s.name}" has ${n} list entr${n === 1 ? 'y' : 'ies'} (${where}) that ${n === 1 ? 'is not a "- [name](url)" link' : 'are not "- [name](url)" links'}; llmstxt.org defines an H2 section as a list of links, with an optional ": notes" suffix` })
    delete s.badLines
  }
  for (const s of sections) delete s.badLines
  issues.sort((a, b) => a.line - b.line)
  if (h1 === null) issues.push({ line: 1, rule: 'h1-required', message: 'no H1; a single H1 naming the site is the only required element' })
  return { valid: issues.length === 0, issues, h1, hasSummary, sections, totalLinks }
}

/** Does a body look like HTML (a soft 404 or an app shell) rather than text? */
export const looksLikeHtml = (body) => /^\s*(?:<!doctype html|<html\b|<head\b|<body\b)/i.test(String(body))
