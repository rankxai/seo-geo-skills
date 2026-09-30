#!/usr/bin/env node
/**
 * check-overlap.mjs: do two of your own pages answer the same sub-question
 * with the same words?
 *
 *   node skills/content-review/scripts/check-overlap.mjs content/
 *   node skills/content-review/scripts/check-overlap.mjs a.md b.md c.html
 *   node skills/content-review/scripts/check-overlap.mjs content/ --report
 *
 * WHAT THIS IS NOT: a keyword-cannibalisation report. The evidence does not
 * support that tool. Ahrefs counted about 9,700 cases of its own site ranking
 * with more than one URL for a keyword, hand-reviewed a sample of 80, and
 * found one that needed action (February 2024). Several URLs ranking for a
 * keyword is usually diversification, not a fault.
 * https://ahrefs.com/blog/multiple-rankings-study/
 *
 * WHAT IT IS: a passage check. Search engines and AI assistants retrieve and
 * cite sections, not whole pages, so two sections on two of your pages that
 * restate one answer at the same depth compete with each other for one
 * passage. That is detectable, and it is the real defect behind most
 * "cannibalisation" worries.
 *
 * How: each file is split into sections at its headings. Each section becomes
 * a set of five-word shingles, and every pair of sections from DIFFERENT files
 * is scored by Jaccard similarity (shared shingles over all shingles).
 * Shingles rather than embeddings because the failure is restatement, not
 * paraphrase, and because a check with no network call and no API key can run
 * on every commit.
 *
 * Thresholds: warn at 0.05, fail at 0.10, derived on one corpus of 18
 * long-form articles where almost every pair scored zero and the handful
 * above 0.05 were real restatements. Your corpus differs: run --report,
 * look at the distribution, and set --warn and --fail from it rather than
 * adjusting them until a run passes.
 *
 * The usual fix is not to delete a section. Cut the overlapping depth from
 * the page that owns the topic less, and link to the page that owns it more.
 *
 * Exit codes: 0 nothing at fail level, 1 a pair at or above --fail, 2 usage
 * error, 3 could not check (no readable files, or fewer than two).
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EXIT, UsageError, formatFinding, intOption, parseCli, runMain, summaryLine, VERSION } from './shared/cli.mjs'
import { OVERLAP_FAIL_AT, OVERLAP_SHINGLE, OVERLAP_WARN_AT, detectFormat, jaccard, parseDocument, shingles } from './lib/content.mjs'

const HELP = `usage: node check-overlap.mjs <dir | files...> [options]

Splits each .md, .mdx or .html file into sections at its headings and scores
every pair of sections from different files by five-word shingle overlap.

options:
  --warn <x>        warn threshold, 0 to 1 (default ${OVERLAP_WARN_AT})
  --fail <x>        fail threshold, 0 to 1 (default ${OVERLAP_FAIL_AT})
  --shingle <n>     words per shingle (default ${OVERLAP_SHINGLE})
  --report          print the score distribution and the top pairs; never fails
  --top <n>         pairs to list in --report (default 12)
  --json            machine-readable output
  -h, --help        this text

exit codes: 0 clean, 1 a pair at or above --fail, 2 usage error, 3 could not check`

const EXTENSIONS = /\.(?:md|mdx|markdown|html?)$/i

async function collect(paths) {
  const files = []
  for (const p of paths) {
    let s
    try {
      s = await stat(p)
    } catch {
      throw new UsageError(`no such file or directory: ${p}`)
    }
    if (s.isDirectory()) {
      const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue
          const full = join(dir, e.name)
          if (e.isDirectory()) await walk(full)
          else if (EXTENSIONS.test(e.name)) files.push(full)
        }
      }
      await walk(p)
    } else files.push(p)
  }
  return [...new Set(files)].sort()
}

/** Sections of one file, each with its shingle set. */
export function sectionsOf(file, text, n) {
  const doc = parseDocument(text, detectFormat(file, text))
  return doc.sections
    .filter((s) => !s.isSources)
    .map((s) => ({ file, heading: s.heading ?? '(before the first heading)', shingles: shingles([s.heading ?? '', ...s.paragraphs.map((p) => p.text)].join(' '), n) }))
    .filter((s) => s.shingles.size > 0)
}

const ratio = (v, name, fallback) => {
  if (v === undefined) return fallback
  const x = Number(v)
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new UsageError(`--${name} must be a number from 0 to 1`)
  return x
}

async function main(argv) {
  const { values, positionals } = parseCli(argv, {
    warn: { type: 'string' },
    fail: { type: 'string' },
    shingle: { type: 'string' },
    report: { type: 'boolean' },
    top: { type: 'string' },
  })
  if (values.help) {
    console.log(HELP)
    return EXIT.CLEAN
  }
  if (positionals.length === 0) throw new UsageError('give a directory or at least two files')
  const warnAt = ratio(values.warn, 'warn', OVERLAP_WARN_AT)
  const failAt = ratio(values.fail, 'fail', OVERLAP_FAIL_AT)
  const n = intOption(values.shingle, 'shingle', OVERLAP_SHINGLE, 1)
  const top = intOption(values.top, 'top', 12, 1)

  const files = await collect(positionals)
  const sections = []
  const unreadable = []
  for (const f of files) {
    try {
      sections.push(...sectionsOf(f, await readFile(f, 'utf8'), n))
    } catch (error) {
      unreadable.push(`${f}: ${error.message}`)
    }
  }
  const fileCount = new Set(sections.map((s) => s.file)).size
  if (fileCount < 2) {
    const reason = `need at least two readable files with text; found ${fileCount}${unreadable.length ? ` (${unreadable.length} unreadable)` : ''}`
    if (values.json) console.log(JSON.stringify({ tool: 'check-overlap', version: VERSION, checked: false, reason }, null, 2))
    else console.log(`check-overlap\n\n  NOT CHECKED  ${reason}\n`)
    return EXIT.UNCHECKED
  }

  const pairs = []
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[i].file === sections[j].file) continue
      pairs.push({ a: sections[i], b: sections[j], score: jaccard(sections[i].shingles, sections[j].shingles) })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  const values_ = pairs.map((p) => p.score).sort((a, b) => a - b)
  const pct = (p) => values_[Math.floor((values_.length - 1) * p)] ?? 0
  const distribution = { sections: sections.length, files: fileCount, pairs: pairs.length, median: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: values_.at(-1) ?? 0 }
  const rel = (f) => {
    const r = relative(process.cwd(), f)
    return !r || r.startsWith('..') ? f : r
  }
  const describe = (p) => ({ score: Number(p.score.toFixed(4)), a: { file: rel(p.a.file), heading: p.a.heading }, b: { file: rel(p.b.file), heading: p.b.heading } })

  if (values.report) {
    if (values.json) {
      console.log(JSON.stringify({ tool: 'check-overlap', version: VERSION, checked: true, shingle: n, distribution, top: pairs.slice(0, top).map(describe) }, null, 2))
    } else {
      const f4 = (x) => x.toFixed(4)
      const lines = [`check-overlap --report  (${fileCount} files, ${sections.length} sections, ${pairs.length} cross-file pairs, ${n}-word shingles)`, '']
      lines.push(`  median ${f4(distribution.median)}   p90 ${f4(distribution.p90)}   p99 ${f4(distribution.p99)}   max ${f4(distribution.max)}`, '', `  top ${Math.min(top, pairs.length)} pairs:`)
      for (const p of pairs.slice(0, top)) lines.push(`    ${f4(p.score)}  ${rel(p.a.file)} :: ${p.a.heading}`, `            ${rel(p.b.file)} :: ${p.b.heading}`)
      lines.push('', '  Set --warn a little above the level where ordinary topical adjacency stops, and --fail above every pair you have judged acceptable.', '')
      console.log(lines.join('\n'))
    }
    return EXIT.CLEAN
  }

  const findings = []
  for (const p of pairs) {
    if (p.score < warnAt) break
    findings.push({
      level: p.score >= failAt ? 'error' : 'warn',
      rule: 'overlap',
      message: `${p.score.toFixed(3)}  ${rel(p.a.file)} "${p.a.heading}"  and  ${rel(p.b.file)} "${p.b.heading}"`,
    })
  }
  for (const u of unreadable) findings.push({ level: 'not-checked', rule: 'unreadable', message: u })

  if (values.json) {
    console.log(JSON.stringify({ tool: 'check-overlap', version: VERSION, checked: true, shingle: n, warnAt, failAt, distribution, pairs: pairs.filter((p) => p.score >= warnAt).map(describe), findings, summary: summaryLine(findings) }, null, 2))
  } else {
    const lines = [`check-overlap  (${fileCount} files, ${sections.length} sections, ${pairs.length} cross-file pairs; warn ${warnAt}, fail ${failAt})`, '']
    for (const f of findings) lines.push(formatFinding(f))
    if (!findings.length) lines.push(`  no pair of sections reaches ${warnAt}; highest is ${distribution.max.toFixed(3)}`)
    else lines.push('', '  Two of your sections answer one question at the same depth. Cut the overlapping depth from', '  the page that owns the topic less, and link to the one that owns it more.')
    lines.push('', `  ${summaryLine(findings)}`, '')
    console.log(lines.join('\n'))
  }
  return findings.some((f) => f.level === 'error') ? EXIT.FINDINGS : EXIT.CLEAN
}

await runMain(main, HELP)
