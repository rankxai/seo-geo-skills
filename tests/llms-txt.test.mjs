/**
 * lib/llms-txt.mjs: the llms.txt format proposed at llmstxt.org.
 *
 * Mutation record: LINK_ITEM changed to accept any line starting with "- ".
 * Caught by "malformed list entries in an H2 section are reported".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeHtml, validateLlmsTxt } from '../skills/seo-geo/scripts/lib/llms-txt.mjs'
import { readFixture } from './helpers.mjs'

test('a well-formed file passes and reports its shape', () => {
  const r = validateLlmsTxt(readFixture('llms-valid.txt'))
  assert.equal(r.valid, true, JSON.stringify(r.issues))
  assert.equal(r.h1, 'Example Site')
  assert.equal(r.hasSummary, true)
  assert.deepEqual(r.sections.map((s) => s.name), ['Key pages', 'Optional'])
  assert.equal(r.totalLinks, 3)
})

test('a BOM and a bare H1 are enough', () => {
  assert.equal(validateLlmsTxt('\uFEFF# Just a name\n').valid, true)
})

test('a missing H1, content before it, and a second H1 are reported', () => {
  assert.ok(validateLlmsTxt('> summary only\n').issues.some((i) => i.rule === 'h1-required'))
  assert.ok(validateLlmsTxt('hello\n# Name\n').issues.some((i) => i.rule === 'h1-first'))
  assert.ok(validateLlmsTxt('# One\n# Two\n').issues.some((i) => i.rule === 'single-h1'))
})

test('H3 and deeper headings are reported', () => {
  assert.ok(validateLlmsTxt('# Name\n\n### Deep\n').issues.some((i) => i.rule === 'no-deep-headings'))
})

test('malformed list entries in an H2 section are reported', () => {
  assert.ok(validateLlmsTxt('# Name\n\n## Docs\n\n- not a link\n').issues.some((i) => i.rule === 'link-item'))
  assert.equal(validateLlmsTxt('# N\n\n## S\n\n- [A](https://a.example): with a note\n').valid, true)
})

test('an HTML page served as llms.txt is recognised', () => {
  assert.equal(looksLikeHtml('<!doctype html><html>'), true)
  assert.equal(looksLikeHtml('# Site\n'), false)
})
