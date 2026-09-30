#!/usr/bin/env node
/**
 * check-prose.mjs: the mechanical half of a prose review, for a Markdown or
 * HTML draft.
 *
 *   node skills/content-review/scripts/check-prose.mjs draft.md
 *   node skills/content-review/scripts/check-prose.mjs page.html --strict
 *   cat draft.md | node skills/content-review/scripts/check-prose.mjs -
 *
 * What it checks, and why:
 *
 *   tell-words       Words that read as machine-made (lib/tells.mjs). WARN with a
 *                    count: one proves nothing, a cluster of four or more is a
 *                    signal. Proper nouns such as "Core Web Vitals" are masked
 *                    first, because an entity name is not a style choice.
 *   tell-phrases     Stock phrases with no use a plainer sentence does not serve
 *                    better ("it's worth noting", "in today's fast-paced").
 *                    ERROR.
 *   tell-shapes      The contrast reframe ("it's not X, it's Y"), the
 *                    "Whether you're X or Y" opener and stacked hedges. ERROR.
 *                    A parallel negation ("it is not a pass, it is not a
 *                    failure") is not a reframe and does not fire.
 *   stacked-compounds  Five or more hyphenated modifiers in one sentence. WARN.
 *   em-dash          The em dash is one of the most noticed tells in current
 *                    general-audience prose. ERROR, including alt, title,
 *                    aria-label and meta content in HTML, because those are
 *                    copy too.
 *   invisible-chars  Zero-width, bidirectional and Unicode tag characters. No
 *                    legitimate use in published copy. ERROR.
 *   myth:*           Known-wrong claims from seo-geo/data/myths.json. WARN,
 *                    because quoting a claim to correct it is legitimate.
 *   unsourced-figure A percentage (%, per cent, percent), multiplier or
 *                    million/billion figure whose sentence has no link and whose
 *                    number appears in no link and no Sources or References
 *                    section. WARN, or ERROR with --strict.
 *   readability      Flesch-Kincaid grade for the whole draft and its hardest
 *                    section. INFO: it is a comparison tool, not a target.
 *   paragraph-length Paragraphs over 90 words, which usually carry two ideas and
 *                    extract badly as a single passage. WARN. Sentences over 40
 *                    words are counted as INFO.
 *
 * Fenced code, inline code and anything between <!-- prose-check: off --> and
 * <!-- prose-check: on --> are skipped, so a style guide can list the phrases
 * it bans and a document can quote a false claim in order to correct it. The
 * Sources or References section is skipped for the writing rules.
 *
 * --docs is for a repository's own Markdown (README, SKILL.md files and their
 * references). Em dashes, invisible characters, stock phrases, the
 * non-informative shapes and known myths are errors; tell words and the
 * contrast reframes warn; figures, readability and length are skipped, because
 * documentation cites with links. With --docs and no files, it reads this
 * repository's README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md,
 * skills/*\/SKILL.md and skills/*\/references/*.md.
 *
 * Exit codes: 0 no errors, 1 errors found, 2 usage error, 3 could not check.
 */

import { readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, UsageError, classifyArg, formatFinding, parseCli, readInput, runMain, summaryLine, VERSION } from './shared/cli.mjs'
import { detectFormat } from './lib/content.mjs'
import { checkProse } from './lib/prose.mjs'

const HELP = `usage: node check-prose.mjs <file.md | file.html | -> [more files] [options]

Machine tells, em dashes, invisible characters, known myths, unsourced
figures, readability and paragraph length for one or more drafts.

options:
  --strict            unsourced figures are errors, not warnings
  --docs              documentation mode: stricter on style and myths, no
                      figure or readability checks; with no files, checks
                      this repository's README, SKILL.md and reference files
  --format <fmt>      markdown or html (default: from the extension or content)
  --json              machine-readable output
  -h, --help          this text

Skip a region with <!-- prose-check: off --> ... <!-- prose-check: on -->.

exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check`

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The repository's own documentation, for --docs with no file arguments. */
export function defaultDocs(root = REPO) {
  const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].map((f) => join(root, f))
  const skills = join(root, 'skills')
  if (existsSync(skills)) {
    for (const skill of readdirSync(skills, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      files.push(join(skills, skill.name, 'SKILL.md'))
      const refs = join(skills, skill.name, 'references')
      if (existsSync(refs)) for (const f of readdirSync(refs).filter((x) => x.endsWith('.md')).sort()) files.push(join(refs, f))
    }
  }
  return files
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    strict: { type: 'boolean' },
    docs: { type: 'boolean' },
    format: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (values.format && !['markdown', 'md', 'html'].includes(values.format)) throw new UsageError('--format must be markdown or html')
  const docs = Boolean(values.docs)
  let targets = positionals
  let defaults = false
  if (targets.length === 0) {
    if (!docs) throw new UsageError('give a file, several files, or - (stdin)')
    targets = defaultDocs()
    defaults = true
  }
  for (const t of targets) {
    if (classifyArg(t, { allowBareHost: false }).kind === 'url') throw new UsageError(`check-prose reads files or stdin, not URLs (${t}); use seo-geo/scripts/audit-page.mjs for a page`)
  }

  const reports = []
  for (const target of targets) {
    const input = await readInput(target, {}, { allowBareHost: false })
    const name = input.kind === 'stdin' ? 'stdin' : relative(process.cwd(), target) || target
    if (input.error) {
      // With the default document list, a file that does not exist yet is
      // reported and skipped; a file the user named that cannot be read is
      // "could not check".
      reports.push({ file: name, checked: false, reason: input.error, optional: defaults })
      continue
    }
    const format = values.format ? (values.format === 'html' ? 'html' : 'markdown') : detectFormat(input.path, input.text)
    const { findings, stats } = checkProse(input.text, { format, strict: Boolean(values.strict), docs })
    reports.push({ file: name, checked: true, format, stats, findings })
  }

  const all = reports.flatMap((r) => (r.checked ? r.findings : []))
  const checkedCount = reports.filter((r) => r.checked).length
  const failedReads = reports.filter((r) => !r.checked && !r.optional)

  if (values.json) {
    console.log(JSON.stringify({ tool: 'check-prose', version: VERSION, mode: docs ? 'docs' : 'draft', files: reports, summary: summaryLine(all) }, null, 2))
  } else {
    const lines = []
    for (const r of reports) {
      if (!r.checked) {
        lines.push(`check-prose  ${r.file}`, `  NOT CHECKED  ${r.reason}`, '')
        continue
      }
      lines.push(`check-prose  ${r.file}  (${r.format}${docs ? ', docs mode' : ''}, ${r.stats.words} words)`)
      for (const f of r.findings) lines.push(formatFinding(f))
      if (!r.findings.length) lines.push('  nothing found')
      lines.push('')
    }
    lines.push(`  ${checkedCount} file(s) checked: ${summaryLine(all)}`)
    if (!docs) lines.push('  A clean run means the mechanical problems are gone. Whether the draft is worth publishing is the rest of the review.')
    lines.push('')
    console.log(lines.join('\n'))
  }
  if (all.some((f) => f.level === 'error')) return EXIT.FINDINGS
  if (failedReads.length || checkedCount === 0) return EXIT.UNCHECKED
  return EXIT.CLEAN
}

await runMain(main, HELP)

