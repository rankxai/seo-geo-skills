/**
 * Loader for data/myths.json: claims known to be wrong, or measured not to
 * work, each with the primary source that settles it.
 *
 * Why a scan for known sentences is worth having: a correction to a guide
 * does not reach the pages that already quoted the old claim. Nothing reads a
 * published corpus for a sentence known to be wrong unless something is built
 * to, and the same few wrong claims recur across the web because they are
 * copied from one summary to the next.
 *
 * Patterns run over normalised prose (curly quotes folded, whitespace
 * collapsed). A match is a WARNING, never proof: the author may be quoting the
 * claim in order to correct it, which is legitimate, so the message gives the
 * evidence and leaves the judgement to a person.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalise } from './html.mjs'

export const MYTHS_FILE = fileURLToPath(new URL('../../data/myths.json', import.meta.url))

let cache
export function loadMyths(file = MYTHS_FILE) {
  if (file === MYTHS_FILE && cache) return cache
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const myths = data.myths.map((m) => ({
    ...m,
    regexes: m.patterns.map((p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`)),
  }))
  const out = { staleDays: data.staleDays ?? 90, myths }
  if (file === MYTHS_FILE) cache = out
  return out
}

/** Every match of every myth in `text`, one per myth and pattern position. */
export function findMyths(text, { myths } = loadMyths()) {
  const clean = normalise(text)
  const out = []
  for (const myth of myths) {
    const seen = new Set()
    for (const re of myth.regexes) {
      re.lastIndex = 0
      for (const m of clean.matchAll(re)) {
        if (seen.has(m.index)) continue
        seen.add(m.index)
        out.push({ id: myth.id, kind: myth.kind, match: m[0], index: m.index, why: myth.why, source: myth.source, checked: myth.checked })
      }
    }
  }
  return out
}

/** Myths whose `checked` date is older than `staleDays` on `today`. */
export function staleMyths(today = new Date(), data = loadMyths()) {
  const cutoff = today.getTime() - data.staleDays * 86_400_000
  return data.myths.filter((m) => Date.parse(`${m.checked}T00:00:00Z`) < cutoff)
}

/** Findings for a block of prose, at the given level. */
export function mythFindings(text, level = 'warn') {
  const findings = findMyths(text).map((hit) => ({
    level,
    rule: `myth:${hit.id}`,
    message: `"${hit.match.slice(0, 140)}". ${hit.why} Source: ${hit.source} (checked ${hit.checked}).`,
  }))
  const stale = staleMyths()
  if (findings.length && stale.length) {
    findings.push({
      level: 'info',
      rule: 'myths-stale',
      message: `${stale.length} myth entr${stale.length === 1 ? 'y is' : 'ies are'} past the recheck window (${stale.map((m) => m.id).join(', ')}); re-read the source before relying on the verdict.`,
    })
  }
  return findings
}
