/**
 * Test helpers: run a script as a real child process (so exit codes, stdout
 * and argument parsing are tested as a user meets them) and start a local
 * HTTP server so no test touches the internet.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SEO = join(ROOT, 'skills', 'seo-geo', 'scripts')
export const CONTENT = join(ROOT, 'skills', 'content-review', 'scripts')
export const FIXTURES = join(ROOT, 'tests', 'fixtures')
export const fixture = (name) => join(FIXTURES, name)
export const readFixture = (name) => readFileSync(fixture(name), 'utf8')

/** Run `node script ...args`, optionally with stdin. Resolves { code, stdout, stderr }. */
export function run(script, args = [], { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/** Run and parse --json output. */
export async function runJson(script, args = [], opts) {
  const r = await run(script, [...args, '--json'], opts)
  let json
  try {
    json = JSON.parse(r.stdout)
  } catch {
    throw new Error(`not JSON (exit ${r.code}):\n${r.stdout}\n${r.stderr}`)
  }
  return { ...r, json }
}

/**
 * Start a server whose handler is `(req, res, origin) => void`. Resolves
 * { origin, close }. Port 0 lets the OS pick a free port.
 */
export function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, `http://127.0.0.1:${server.address().port}`))
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      resolve({
        origin,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      })
    })
  })
}

export function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

/** Write text to a fresh temp file and return its path. */
export function tempFile(name, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ebs-test-'))
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

/** Rule ids present at a level. */
export const rules = (findings, level) => findings.filter((f) => !level || f.level === level).map((f) => f.rule)
