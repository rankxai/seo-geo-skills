#!/usr/bin/env node
/**
 * validate-skills.mjs: structural checks for the skills and plugin manifests.
 * A plain script, not a node:test file, so `node --test tests/` does not run
 * it twice. CI runs it directly:
 *
 *   node tests/validate-skills.mjs
 *
 * It fails (exit 1) when:
 *   - a SKILL.md front matter key is outside name, description, license,
 *     compatibility, metadata, allowed-tools
 *   - `name` differs from its folder, or breaks the Agent Skills naming rules:
 *     1 to 64 characters, lower-case letters, digits and single hyphens, no
 *     leading or trailing hyphen, and not containing "claude" or "anthropic"
 *   - `description` is empty, over 1024 characters (the Agent Skills limit),
 *     or over 200 characters (the limit claude.ai applies on upload)
 *   - a SKILL.md body is over 500 lines
 *   - a relative Markdown link anywhere under skills/ points at a missing file
 *   - any file under skills/ is over 256 KiB
 *   - a plugin manifest does not parse, or the manifests disagree on the
 *     plugin name or version, or the scripts' VERSION constant disagrees
 *   - a marketplace file (Claude, Cursor, Codex agents) does not parse, has
 *     no plugins[] entry named rankx-seo, or gives that entry no source
 *
 * The front matter reader is deliberately small (no YAML dependency): it
 * understands top-level keys, quoted and plain scalars, folded (>) and literal
 * (|) blocks, and indented children, which is everything a SKILL.md needs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SKILLS = join(ROOT, 'skills')

export const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const DESCRIPTION_MAX = 1024
export const DESCRIPTION_UPLOAD_MAX = 200
export const BODY_MAX_LINES = 500
export const FILE_MAX_BYTES = 256 * 1024
export const PLUGIN_NAME = 'rankx-seo'
/** Files that describe the plugin itself: each names it at the top level and carries its version. */
export const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', 'gemini-extension.json']

/**
 * Marketplace files: the top-level `name` is the MARKETPLACE ("rankx"), and
 * the plugin is an entry in `plugins`. The check is that an entry named
 * PLUGIN_NAME exists (never "the first entry, whatever it is called"). A
 * version on the entry is optional, because the plugin manifest carries it,
 * but one that is present must agree with the rest.
 */
export const MARKETPLACES = ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json', '.agents/plugins/marketplace.json']

/** Split a SKILL.md into { frontMatter, body, bodyStartLine } or null. */
export function splitFrontMatter(text) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  return { frontMatter: m[1], body: m[2], bodyStartLine: m[1].split(/\r?\n/).length + 3 }
}

const unquote = (v) => {
  const t = v.trim()
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/** Top-level keys of a YAML front matter block, with scalar values resolved. */
export function parseFrontMatter(yaml) {
  const lines = String(yaml).split(/\r?\n/)
  const out = new Map()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([^\s:#][^:]*?):(?:\s+(.*))?$/)
    if (!m) continue
    const key = m[1].trim()
    const rest = (m[2] ?? '').trim()
    const child = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) child.push(lines[++i])
    while (child.length && child.at(-1).trim() === '') child.pop()
    let value
    if (/^[>|][-+]?$/.test(rest)) {
      const indent = Math.min(...child.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length))
      const body = child.map((l) => l.slice(indent))
      value = rest.startsWith('>') ? body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').trim() : body.join('\n').trim()
    } else if (rest === '' && child.length) {
      value = { children: child.map((l) => l.trim()).filter(Boolean) }
    } else {
      value = unquote([rest, ...child.map((l) => l.trim())].join(' ').trim())
    }
    out.set(key, value)
  }
  return out
}

/** Relative Markdown links in a file that point at nothing. */
export function brokenLinks(file, text) {
  const out = []
  const withoutCode = String(text).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
  for (const m of withoutCode.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue
    const path = decodeURI(target.split('#')[0].split('?')[0])
    if (!path) continue
    const abs = path.startsWith('/') ? join(ROOT, path) : resolve(dirname(file), path)
    if (!existsSync(abs)) out.push(target)
  }
  return out
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

export function validate(root = ROOT) {
  const errors = []
  const notes = []
  const rel = (p) => relative(root, p).replace(/\\/g, '/')
  const skillsDir = join(root, 'skills')

  if (!existsSync(skillsDir)) return { errors: ['skills/ does not exist'], notes }
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const dir of skillDirs) {
    const file = join(skillsDir, dir.name, 'SKILL.md')
    if (!existsSync(file)) {
      errors.push(`skills/${dir.name}: no SKILL.md`)
      continue
    }
    const split = splitFrontMatter(readFileSync(file, 'utf8'))
    if (!split) {
      errors.push(`${rel(file)}: no YAML front matter (the file must start with ---)`)
      continue
    }
    const fm = parseFrontMatter(split.frontMatter)
    for (const key of fm.keys()) if (!ALLOWED_KEYS.has(key)) errors.push(`${rel(file)}: front matter key "${key}" is not allowed (allowed: ${[...ALLOWED_KEYS].join(', ')})`)

    const name = fm.get('name')
    if (typeof name !== 'string' || !name) errors.push(`${rel(file)}: name is missing`)
    else {
      if (name !== dir.name) errors.push(`${rel(file)}: name "${name}" does not match its folder "${dir.name}"`)
      if (name.length > 64) errors.push(`${rel(file)}: name is ${name.length} characters (max 64)`)
      if (!NAME_RE.test(name)) errors.push(`${rel(file)}: name "${name}" must be lower-case letters, digits and single hyphens, with no leading or trailing hyphen`)
      if (/claude|anthropic/i.test(name)) errors.push(`${rel(file)}: name must not contain "claude" or "anthropic"`)
    }

    const description = fm.get('description')
    if (typeof description !== 'string' || !description.trim()) errors.push(`${rel(file)}: description is missing or empty`)
    else {
      if (description.length > DESCRIPTION_MAX) errors.push(`${rel(file)}: description is ${description.length} characters (max ${DESCRIPTION_MAX})`)
      if (description.length > DESCRIPTION_UPLOAD_MAX) errors.push(`${rel(file)}: description is ${description.length} characters; claude.ai rejects uploads over ${DESCRIPTION_UPLOAD_MAX}`)
      notes.push(`${rel(file)}: name "${name}", description ${description.length} characters`)
    }

    const bodyLines = split.body.split(/\r?\n/).length
    if (bodyLines > BODY_MAX_LINES) errors.push(`${rel(file)}: body is ${bodyLines} lines (max ${BODY_MAX_LINES}); move detail into references/`)
  }

  for (const file of walk(skillsDir)) {
    const size = statSync(file).size
    if (size > FILE_MAX_BYTES) errors.push(`${rel(file)}: ${(size / 1024).toFixed(0)} KiB (max ${FILE_MAX_BYTES / 1024} KiB)`)
    if (file.endsWith('.md')) {
      for (const target of brokenLinks(file, readFileSync(file, 'utf8'))) errors.push(`${rel(file)}: link to "${target}" points at a missing file`)
    }
  }

  // ---- manifests ------------------------------------------------------------
  const found = []
  const readJson = (m) => {
    const path = join(root, m)
    if (!existsSync(path)) {
      errors.push(`${m}: missing`)
      return null
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push(`${m}: does not parse: ${error.message}`)
      return null
    }
  }
  for (const m of MANIFESTS) {
    const json = readJson(m)
    if (!json) continue
    found.push({ file: m, name: json.name, version: json.version, versionRequired: true })
  }
  let marketplaces = 0
  for (const m of MARKETPLACES) {
    const json = readJson(m)
    if (!json) continue
    marketplaces += 1
    if (!Array.isArray(json.plugins)) {
      errors.push(`${m}: no "plugins" array`)
      continue
    }
    const entry = json.plugins.find((p) => p?.name === PLUGIN_NAME)
    if (!entry) {
      errors.push(`${m}: no plugins[] entry named "${PLUGIN_NAME}" (found ${json.plugins.map((p) => `"${p?.name}"`).join(', ') || 'none'})`)
      continue
    }
    if (!entry.source) errors.push(`${m}: the "${PLUGIN_NAME}" entry has no source`)
    found.push({ file: m, name: entry.name, version: entry.version, versionRequired: false })
  }
  for (const f of found) if (f.name !== PLUGIN_NAME) errors.push(`${f.file}: plugin name is "${f.name}", expected "${PLUGIN_NAME}"`)
  const versions = new Set(found.map((f) => f.version).filter(Boolean))
  if (versions.size > 1) errors.push(`manifest versions disagree: ${found.filter((f) => f.version || f.versionRequired).map((f) => `${f.file}=${f.version ?? 'none'}`).join(', ')}`)
  for (const f of found) if (f.versionRequired && !f.version) errors.push(`${f.file}: no version`)
  const cli = join(root, 'skills', 'seo-geo', 'scripts', 'lib', 'cli.mjs')
  if (existsSync(cli) && versions.size === 1) {
    const scriptVersion = readFileSync(cli, 'utf8').match(/export const VERSION = '([^']+)'/)?.[1]
    const [v] = versions
    if (scriptVersion !== v) errors.push(`skills/seo-geo/scripts/lib/cli.mjs VERSION is ${scriptVersion}, manifests say ${v}`)
  }
  if (found.length) notes.push(`manifests: ${found.length - marketplaces} parsed and ${marketplaces} marketplace(s), name ${[...new Set(found.map((f) => f.name))].join('/')}, version ${[...versions].join('/') || 'none'}`)
  return { errors, notes }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { errors, notes } = validate()
  const lines = ['validate-skills', '']
  for (const n of notes) lines.push(`  ok     ${n}`)
  for (const e of errors) lines.push(`  ERROR  ${e}`)
  lines.push('', `  ${errors.length} error(s)`, '')
  console.log(lines.join('\n'))
  process.exitCode = errors.length ? 1 : 0
}
