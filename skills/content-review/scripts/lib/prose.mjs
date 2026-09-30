/**
 * The rules behind check-prose.mjs, as a pure function so the tests pin the
 * shipped logic. See check-prose.mjs for what each rule checks and why.
 *
 * Two modes:
 *   default  a draft for publication. Phrases and shapes are errors, words
 *            and myths warn, figures and readability are reported.
 *   docs     a repository's own documentation. Em dashes, invisible
 *            characters, phrases, the non-informative shapes and known myths
 *            are errors; words and the contrast reframes warn; figures,
 *            readability and length are skipped, because documentation cites
 *            with links and is read differently from an article.
 *
 * In both modes fenced code, inline code and any region between
 * <!-- prose-check: off --> and <!-- prose-check: on --> are ignored, so a
 * style guide can list the words it bans and a skill can quote a false claim
 * in order to warn against it.
 */

import { findInvisible, summariseCodePoints, findTags } from '../shared/html.mjs'
import { mythFindings } from '../shared/myths.mjs'
import { findTells } from './tells.mjs'
import { countWords, fkGrade, parseDocument, sentences, stripInline, unsourcedFigures } from './content.mjs'

export const PARAGRAPH_WARN_WORDS = 90
export const SENTENCE_INFO_WORDS = 40
const ORDER = { error: 0, warn: 1, 'not-checked': 2, info: 3 }

/**
 * Remove regions an author has marked as quoted material. An "off" marker
 * with no matching "on" runs to the end of the file. The older spelling
 * check-prose: off is accepted too.
 */
export const withoutQuotedRegions = (text) =>
  String(text).replace(/<!--\s*(?:prose-check|check-prose)\s*:\s*off\s*-->[\s\S]*?(?:<!--\s*(?:prose-check|check-prose)\s*:\s*on\s*-->|$)/gi, '\n\n')

/** Inline code spans removed: a literal is not copy. */
const withoutInlineCode = (s) => String(s).replace(/(`+)[\s\S]*?\1/g, ' ')

/** The YAML front matter block, if any, as plain text lines. */
function frontMatterText(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  return m ? m[1] : ''
}

export function checkProse(rawText, { format = 'markdown', strict = false, docs = false } = {}) {
  const findings = []
  const add = (level, rule, message) => findings.push({ level, rule, message })
  const raw = String(rawText).replace(/^\uFEFF/, '')
  const text = withoutQuotedRegions(raw)
  const doc = parseDocument(text, format)
  const bodySections = doc.sections.filter((s) => !s.isSources)
  // In docs mode the front matter is copy too: a skill's description is shown
  // to every user who browses for it.
  const front = docs && format === 'markdown' ? frontMatterText(text) : ''

  // Prose for the writing rules: headings and paragraphs, block by block, with
  // inline code removed and a full stop between blocks so two elements never
  // weld into one sentence.
  const prose = [front, ...bodySections.flatMap((s) => [s.heading, ...s.paragraphs.map((p) => stripInline(withoutInlineCode(p.raw)))])]
    .filter(Boolean)
    .join(' . ')

  // ---- tells ------------------------------------------------------------------
  const tells = findTells(prose)
  if (tells.words.length) {
    const list = tells.words.map((w) => `${w.word}${w.count > 1 ? ` x${w.count}` : ''}`).join(', ')
    if (tells.words.length >= 4) add('warn', 'tell-words', `${tells.words.length} different tell words, which is a cluster: ${list}. Replace each with the plainest accurate word.`)
    else add('warn', 'tell-words', `${list}. Keep each only if it is the most accurate word available.`)
  }
  for (const p of tells.phrases) add('error', 'tell-phrases', `"${p}"`)
  for (const s of tells.shapes) {
    const level = docs && s.hasInformativeUse ? 'warn' : 'error'
    add(level, 'tell-shapes', `${s.label}: "${s.sample}"${s.hasInformativeUse ? '. If the second half draws a distinction the reader needs, state that distinction plainly instead.' : ''}`)
  }
  for (const c of tells.compounds) add('warn', 'stacked-compounds', `${c.count} hyphenated compounds in one sentence: ${c.sample}`)

  // ---- em dashes ----------------------------------------------------------------
  const allText = [front, ...doc.sections.flatMap((s) => [s.heading, ...s.paragraphs.map((p) => withoutInlineCode(p.raw))])].filter(Boolean).join('\n')
  const dashes = (allText.match(/\u2014/g) ?? []).length
  if (dashes) {
    const sample = allText.match(/[^\n.!?]{0,40}\u2014[^\n.!?]{0,40}/)?.[0].trim()
    add('error', 'em-dash', `${dashes} em dash(es). Use a comma, colon, full stop or brackets. e.g. "${sample}"`)
  }
  if (format === 'html') {
    const attrs = []
    for (const tagName of ['img', 'a', 'meta', 'button', 'input', 'area', 'svg', 'div', 'span', 'link']) {
      for (const t of findTags(text, tagName)) {
        for (const name of ['alt', 'title', 'aria-label', 'content', 'placeholder']) {
          const v = t.attrs.get(name)
          if (v && v.includes('\u2014')) attrs.push(`${name}="${v.slice(0, 60)}"`)
        }
      }
    }
    if (attrs.length) add('error', 'em-dash', `${attrs.length} em dash(es) in attributes, e.g. ${attrs[0]}`)
  }

  // ---- invisible characters ----------------------------------------------------------
  // Checked over everything outside a marked region, code included: a hidden
  // character in a code sample is copied into someone's terminal.
  const invisible = findInvisible(text)
  if (invisible.length) add('error', 'invisible-chars', `${invisible.length} invisible or direction-changing character(s): ${summariseCodePoints(invisible)}`)

  // ---- myths ---------------------------------------------------------------------------
  findings.push(...mythFindings(prose, docs ? 'error' : 'warn'))

  let words = countWords(bodySections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' '))
  let grade = 0
  if (!docs) {
    // ---- unsourced figures ------------------------------------------------------------------
    for (const f of unsourcedFigures(doc)) {
      add(strict ? 'error' : 'warn', 'unsourced-figure', `"${f.figure}" has no link in its sentence and its number appears in no link or Sources section: "${f.sentence}"`)
    }

    // ---- readability and length -----------------------------------------------------------
    const bodyText = bodySections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' ')
    words = countWords(bodyText)
    grade = words ? fkGrade(bodyText) : 0
    const graded = bodySections
      .map((s) => ({ heading: s.heading ?? '(before the first heading)', text: s.paragraphs.map((p) => p.text).join(' ') }))
      .filter((s) => countWords(s.text) >= 60)
      .map((s) => ({ ...s, grade: fkGrade(s.text) }))
      .sort((a, b) => b.grade - a.grade)
    if (words) {
      add('info', 'readability', `${words} words, Flesch-Kincaid grade ${grade.toFixed(1)}${graded.length > 1 ? `; hardest section "${graded[0].heading}" at grade ${graded[0].grade.toFixed(1)}` : ''}`)
    }
    let longSentences = 0
    for (const s of bodySections) {
      for (const p of s.paragraphs) {
        const n = countWords(p.text)
        if (n > PARAGRAPH_WARN_WORDS) add('warn', 'paragraph-length', `${n}-word paragraph${s.heading ? ` in "${s.heading}"` : ''}: "${p.text.slice(0, 70)}..." Split it, or cut the idea it does not need.`)
        longSentences += sentences(p.text).filter((x) => countWords(x) > SENTENCE_INFO_WORDS).length
      }
    }
    if (longSentences) add('info', 'sentence-length', `${longSentences} sentence(s) over ${SENTENCE_INFO_WORDS} words; check whether each is really two`)
  }

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level])
  return { findings, stats: { words, fkGrade: Number(grade.toFixed(1)), sections: bodySections.length } }
}
