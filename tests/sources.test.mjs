/**
 * check-sources.mjs and classifyStatus, against a local HTTP server.
 *
 * The rule under test is narrower than "not 200" on purpose: only 404 and 410
 * are dead. Bot protection, rate limits, server errors and timeouts are "could
 * not be checked", because many publishers serve exactly those to a script
 * while being alive in a browser.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - classifyStatus(): `status === 403` added to the dead branch. Caught by
 *     "bot protection and server errors are unknown, never dead".
 *   - HEAD_REFUSED: 404 removed. Caught by "a HEAD 404 is retried with GET".
 *   - content.mjs linksIn(): code spans no longer blanked. Caught by "a URL
 *     in inline code or a fenced block is an example" and "check-sources
 *     fetches the real link and never the code-span example".
 *   - content.mjs BARE_URL: the backtick allowed back into a URL. Caught by
 *     "a URL in inline code or a fenced block is an example".
 *   - content.mjs parseDocument(): fences only at column 0 again. Caught by
 *     the tilde-fence case in the same test.
 *   - content.mjs htmlToMarkdownish(): the naive comment regex restored.
 *     Caught by "a comment marker inside an HTML script string".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { classifyStatus, externalUrls, parseDocument } from '../skills/content-review/scripts/lib/content.mjs'
import { CONTENT, run, runJson, send, serve, tempFile } from './helpers.mjs'

const CHECK = join(CONTENT, 'check-sources.mjs')

test('a dead citation is a 404 or a 410, and nothing else', () => {
  assert.equal(classifyStatus(404), 'dead')
  assert.equal(classifyStatus(410), 'dead')
  assert.equal(classifyStatus(200), 'ok')
  assert.equal(classifyStatus(301), 'ok')
})

test('a URL in inline code or a fenced block is an example, not a citation, and a backtick never ends up in a URL', () => {
  // The two real cases: technical-delivery.md and site-changes.md, where the
  // closing backtick was glued on and fetched as "agent.bot.goog`/" and "/de/%60".
  const doc = parseDocument([
    'Signed under the `https://agent.bot.goog` identity.',
    '',
    'Hreflang URLs (`https://example.com/de/`, never `/de/`).',
    '',
    '- A list item with an indented fence:',
    '',
    '  ```',
    '  curl https://fenced.example/in-a-list',
    '  ```',
    '',
    '- And a tilde fence, which no code-span rule would catch:',
    '',
    '  ~~~',
    '  https://tilde.example/in-a-list',
    '  ~~~',
    '',
    '``https://double.example/`` and a real https://real.example/page link.',
  ].join('\n'))
  const urls = externalUrls(doc).map((u) => u.url)
  assert.deepEqual(urls, ['https://real.example/page'])
  assert.ok(!urls.some((u) => /`|%60/.test(u)))
  // A bare URL right before a stray backtick stops at the backtick.
  assert.deepEqual(externalUrls(parseDocument('Go to https://stray.example/a` now.')).map((u) => u.url), ['https://stray.example/a'])
  // A link whose TEXT is code is still a link.
  assert.deepEqual(externalUrls(parseDocument('See [`robots.txt`](https://linked.example/robots).')).map((u) => u.url), ['https://linked.example/robots'])
})

test('a comment marker inside an HTML script string does not swallow the page', () => {
  // Stripping comments before scripts with a naive regex read from the
  // script's '<!--' to the next '-->' and dropped every link in between.
  const html = '<body><script>var a = "<!--";</script><p>See <a href="https://kept.example/a">this</a>.</p><!-- note --><p>End.</p></body>'
  assert.deepEqual(externalUrls(parseDocument(html, 'html')).map((u) => u.url), ['https://kept.example/a'])
  const commented = '<body><!-- <a href="https://hidden.example/">old</a> --><p>x</p></body>'
  assert.deepEqual(externalUrls(parseDocument(commented, 'html')), [])
})

test('check-sources fetches the real link and never the code-span example', async () => {
  const seen = []
  const srv = await serve((req, res) => {
    seen.push(req.url)
    send(res, 200, 'ok')
  })
  try {
    const file = tempFile('code.md', `# T\n\nExample: \`${srv.origin}/example-only\`.\n\nSource: [report](${srv.origin}/real).\n`)
    const r = await runJson(CHECK, [file])
    assert.equal(r.code, 0, r.stdout)
    assert.deepEqual(r.json.results.map((x) => x.url), [`${srv.origin}/real`])
    assert.ok(!seen.some((u) => u.includes('example-only')), seen.join(', '))
  } finally {
    await srv.close()
  }
})

test('bot protection and server errors are unknown, never dead', () => {
  for (const s of [0, 401, 403, 429, 500, 502, 503, 999]) assert.equal(classifyStatus(s), 'unknown', String(s))
})

test('links are found in Markdown and HTML, deduplicated, fragments ignored', () => {
  const md = parseDocument('See [a](https://a.example/x#frag) and <https://b.example/> and https://c.example/p.\n\n[ref]: https://d.example/\n\nUse [the ref][ref]. Also [a again](https://a.example/x).')
  assert.deepEqual(externalUrls(md).map((u) => u.url), ['https://a.example/x', 'https://b.example/', 'https://c.example/p', 'https://d.example/'])
  const html = parseDocument('<p>See <a href="https://a.example/y">this</a> and <a href="/local">that</a> and <a href="mailto:x@y.z">mail</a>.</p>', 'html')
  assert.deepEqual(externalUrls(html).map((u) => u.url), ['https://a.example/y'])
})

test('dead, alive and could-not-check are sorted apart, and a HEAD 404 is retried with GET', async () => {
  const srv = await serve((req, res) => {
    const u = req.url
    if (u === '/alive') return send(res, 200, 'ok')
    if (u === '/moved') return send(res, 301, '', { location: '/alive' })
    if (u === '/gone') return send(res, 410, 'gone')
    if (u === '/missing') return send(res, 404, 'nf')
    if (u === '/blocked') return send(res, 403, 'no bots')
    if (u === '/limited') return send(res, 429, 'slow down')
    if (u === '/broken') return send(res, 500, 'oops')
    if (u === '/head-404') return send(res, req.method === 'HEAD' ? 404 : 200, 'ok')
    return send(res, 404, 'nf')
  })
  try {
    const o = srv.origin
    const draft = tempFile('draft.md', `# Draft\n\n${['alive', 'moved', 'gone', 'missing', 'blocked', 'limited', 'broken', 'head-404'].map((p) => `- [${p}](${o}/${p})`).join('\n')}\n`)
    const r = await runJson(CHECK, [draft])
    assert.equal(r.code, 1)
    const verdict = Object.fromEntries(r.json.results.map((x) => [x.url.split('/').pop(), x.verdict]))
    assert.deepEqual(verdict, { alive: 'ok', moved: 'ok', gone: 'dead', missing: 'dead', blocked: 'unknown', limited: 'unknown', broken: 'unknown', 'head-404': 'ok' })
    assert.deepEqual(r.json.counts, { alive: 3, dead: 2, unknown: 3 })
    const text = await run(CHECK, [draft])
    assert.match(text.stdout, /2 dead, 3 alive, 3 could NOT be checked/)
  } finally {
    await srv.close()
  }
})

test('no dead links exits 0; nothing checkable at all exits 3; a missing file exits 3', async () => {
  const srv = await serve((req, res) => send(res, req.url === '/ok' ? 200 : 403, 'x'))
  try {
    assert.equal((await run(CHECK, [tempFile('a.md', `[ok](${srv.origin}/ok)`)])).code, 0)
    assert.equal((await run(CHECK, [tempFile('b.md', `[x](${srv.origin}/blocked)`)])).code, 3)
  } finally {
    await srv.close()
  }
  assert.equal((await run(CHECK, [tempFile('c.md', 'No links here.')])).code, 0)
  assert.equal((await run(CHECK, ['no-such-draft.md'])).code, 3)
  assert.equal((await run(CHECK, [])).code, 2)
})
