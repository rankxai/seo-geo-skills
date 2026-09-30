/**
 * lib/tells.mjs: the machine-tell catalogue.
 *
 * Two silent failures this suite exists to prevent:
 *   1. A stemming shortcut killing the base words. rootPattern strips a
 *      trailing e/ed/ing/ly, and the obvious version of it leaves "elevat",
 *      which stops matching "elevate" itself. A green run would not show it.
 *   2. A widened rule firing on correct prose. Every widening below is paired
 *      with a case that must stay clean.
 *
 * Mutation record (each applied to the source, the suite run, a test failed,
 * the source restored):
 *   - TELL_SHAPES[0]: the `(?!\s+not\b)` lookahead removed. Caught by "a
 *     parallel negation is not a reframe".
 *   - PROPER_NOUNS emptied. Caught by "an entity name is not a style choice".
 *   - rootPattern: the bare `e` alternative removed from the suffix group.
 *     Caught by "every root pattern still matches its own base word".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOT_TELLS, findTells, rootPattern, stackedCompounds } from '../skills/content-review/scripts/lib/tells.mjs'
import { proseFromHtml } from '../skills/seo-geo/scripts/lib/html.mjs'

test('every root pattern still matches its own base word', () => {
  const dead = ROOT_TELLS.filter((w) => !rootPattern(w).test(w))
  assert.deepEqual(dead, [])
})

test('inflections fire', () => {
  for (const w of ['elevation', 'elevates', 'empowers', 'streamlining', 'fostered', 'revolutionised', 'harnessing', 'boasts', 'unlocking', 'underscores']) {
    assert.ok(findTells(`The product ${w} the workflow.`).words.length > 0, w)
  }
})

test('ordinary copy stays clean', () => {
  for (const ok of [
    'Navigate to Settings and pick a project.',
    'It measures whether you appear in ChatGPT or Perplexity.',
    'The audit ran on 12 pages and returned four issues.',
    'The report lists every crawler by vendor and purpose.',
  ]) {
    const t = findTells(ok)
    assert.equal(t.words.length + t.phrases.length + t.shapes.length, 0, ok)
  }
})

test('stock phrases fire, including with a curly apostrophe', () => {
  assert.ok(findTells("It's worth noting that the index changed.").phrases.includes("it's worth noting"))
  assert.ok(findTells('It\u2019s worth noting that the index changed.').phrases.includes("it's worth noting"))
  assert.ok(findTells("In today's fast-paced market, speed matters.").phrases.length > 0)
  assert.equal(findTells('The note is worth reading.').phrases.length, 0)
})

test('the contrast reframe is caught in every form', () => {
  for (const bad of [
    'This is not just a citation, it is a testament to the work.',
    "It's not just a tool, it's a platform.",
    "Visibility isn't a vanity metric, it's the whole funnel.",
    'This is not merely a report, but also a plan.',
  ]) {
    assert.ok(findTells(bad).shapes.length > 0, bad)
  }
})

test('a parallel negation is not a reframe', () => {
  const real = 'The verdict is not assessed, which is a real outcome: it is not a pass, it is not a failure, and it moves the score in neither direction.'
  assert.equal(findTells(real).shapes.length, 0)
})

test('the whether-you-are hedge is caught as an opener and nowhere else', () => {
  assert.ok(findTells("Whether you're an agency or an in-house team, start here.").shapes.length > 0)
  assert.equal(findTells('The check tells you whether you are cited or invisible.').shapes.length, 0)
})

test('stacked hedging fires; a single qualifier does not', () => {
  assert.ok(findTells('Rankings may potentially shift after a refresh.').shapes.some((s) => s.label === 'stacked hedging'))
  assert.equal(findTells('Rankings may shift after a refresh.').shapes.length, 0)
})

test('an entity name is not a style choice', () => {
  assert.equal(findTells("Core Web Vitals are Google's three page-experience measurements.").words.length, 0)
  assert.equal(findTells('The Core Web Vital that matters most is LCP.').words.length, 0)
  assert.ok(findTells('Schema is vital to how assistants read a page.').words.length > 0)
})

test('exact-match words do not reach their literal senses', () => {
  assert.equal(findTells('Rotate the screen to landscape orientation.').words.filter((w) => w.word === 'landscaping').length, 0)
  assert.equal(findTells('Navigate to the dashboard.').words.length, 0)
  assert.ok(findTells('Navigating the shift to AI search is hard.').words.some((w) => w.word === 'navigating'))
})

test('hyphenated compounds only fire when stacked', () => {
  assert.equal(stackedCompounds('The audit is answer-first and machine-readable throughout.').length, 0)
  assert.ok(stackedCompounds('Our industry-leading, context-aware, best-in-class, AI-powered, next-generation platform ships today.').length > 0)
  assert.equal(stackedCompounds('User-triggered fetchers such as ChatGPT-User, Claude-User, Perplexity-User, Google-Agent and Amzn-User differ.').length, 0, 'product names are not modifiers')
})

test('a block boundary ends a sentence, so two elements cannot weld into one', () => {
  const html = '<h3>Tool A is cheaper, and unlimited seats is not a small thing</h3><p>At $29 a month, or $25 billed annually, it is the lowest entry price here.</p>'
  assert.equal(findTells(proseFromHtml(html)).shapes.length, 0)
})

test('a quoted specimen is not the author\'s copy, and script content is never scored', () => {
  assert.equal(findTells(proseFromHtml('<p data-verbatim>Bad example: cutting-edge solutions.</p>')).words.length, 0)
  assert.ok(findTells(proseFromHtml('<p>Our cutting-edge platform ships today.</p>')).words.length > 0)
  assert.equal(findTells(proseFromHtml('<script>const seamless = "delve";</script><p>The audit ran.</p>')).words.length, 0)
})

test('entities are decoded, or contraction rules go blind', () => {
  assert.ok(findTells(proseFromHtml('<p>It&#x27;s not just a tool, it&#x27;s a platform.</p>')).shapes.length > 0)
})
