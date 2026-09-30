/**
 * The machine-tell catalogue: words, phrases and sentence shapes that make
 * prose read as machine-written.
 *
 * Adapted from ItsssssJack/SlopMonster (MIT, Copyright (c) 2026 Jack Roberts),
 * which is where the root matching, the two-tier word split and the
 * 220-character window in stackedCompounds come from.
 *
 * How much a hit is worth:
 *   words     WARN with a count. One flagged word proves nothing; a cluster of
 *             them with no concrete detail attached is the reliable signal.
 *   phrases   ERROR. None has a use that a plainer sentence does not serve
 *             better.
 *   shapes    ERROR. A page can pass a vocabulary check and still read as
 *             generated, and the sentence shapes are louder than any word.
 *
 * Matching, and why it is not a plain substring. A rule like \bword\w* cannot
 * reach an inflection that changes the stem: "elevate" never matches
 * "elevation". Marketing copy is mostly third person, so the inflected form is
 * the common one. rootPattern strips a trailing e/ed/ing/ly and allows the
 * suffixes back. The bare "e" alternative matters: without it, stripping the
 * "e" from "elevate" leaves "elevat", which no longer matches the base word.
 * The tests assert every entry still matches its own base form, because that
 * failure is silent and takes a dozen words with it.
 *
 * Words with an honest literal sense are matched EXACTLY instead, never by
 * root, so "navigate to Settings" passes and "navigating the shift to AI
 * search" does not.
 */

import { normalise } from '../shared/html.mjs'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/**
 * Matched by ROOT, so every inflection fires.
 *
 * Deliberately NOT here: curated, compelling, intuitive, crafted, showcase,
 * bespoke. Each appears on some tell lists, and each is the accurate word often
 * enough (a curated list, "compelling legitimate grounds" in a privacy
 * policy) that flagging it would fire on correct copy. A check that fires on
 * correct copy gets switched off.
 */
export const ROOT_TELLS = [
  'delve', 'tapestry', 'realm', 'multifaceted', 'nuanced', 'intricate',
  'robust', 'pivotal', 'crucial', 'vital', 'leverage', 'foster', 'harness',
  'underscore', 'testament', 'beacon', 'cornerstone', 'embark', 'elevate',
  'unlock', 'streamline', 'seamless', 'myriad', 'plethora', 'game-changer',
  'boast', 'empower', 'revolutionise', 'revolutionize',
  'journey', 'effortless',
  'supercharge', 'turbocharge', 'unparalleled', 'holistic', 'synergy',
  'synergies', 'transformative', 'cutting-edge', 'state-of-the-art',
  'world-class', 'best-in-class', 'unleash', 'game-changing', 'next-level',
]

/**
 * A tell in one sense and ordinary English in another. Matched word for word.
 * This buys precision on inflection, not on sense: "landscape" never reaches
 * "landscaping", and "navigating" never reaches "navigate to Settings". It
 * cannot tell "the competitive landscape" from "landscape orientation";
 * nothing mechanical can, which is why a word only ever warns.
 */
export const EXACT_TELLS = [
  'landscape', 'landscapes', 'navigating', 'dive into', 'diving into',
  'harness the power', 'in the realm of',
]

/** No legitimate use, in any sense. Substring match on lower-cased text. */
export const TELL_PHRASES = [
  "in today's fast-paced", "in today's digital age", "in today's world", "it's worth noting",
  'ever-evolving landscape', "let's dive in", "let's explore", 'buckle up',
  'i hope this helps', 'feel free to reach out', 'in conclusion,',
  'in summary,', 'the key takeaway is', 'when it comes to',
  'at the end of the day', 'paradigm shift', 'look no further',
]

/**
 * Sentence SHAPES.
 *
 * The contrast reframe covers the contracted and uncontracted forms of both
 * halves: an early version required "it's" on the right-hand side, and
 * "this is not just a citation, it is a testament" passed straight through.
 *
 * The (?!\s+not\b) lookahead is the opposite correction. A PARALLEL NEGATION
 * is not a reframe: "it is not a pass, it is not a failure, and it moves the
 * score in neither direction" says two things and reframes nothing. The
 * reframe's whole complaint is that the second half arrives as a revelation,
 * so a second half that is itself a negation cannot be one.
 *
 * `hasInformativeUse` marks a shape that CAN be the right call: drawing a real
 * distinction the reader needs does add information. It is still reported,
 * and the message says so, so the author can judge.
 */
export const TELL_SHAPES = [
  {
    label: 'contrast reframe ("not X, it is Y")',
    hasInformativeUse: true,
    re: /\b(?:is|are|was|were|it'?s|that'?s)\s+not\s+(?:just\s|merely\s|simply\s|only\s)?(?:a\s|an\s|the\s|about\s)?[^.;:!?]{3,60}[,;]\s*(?:it|they|that|this)\s*(?:'s|'re|is|are)\b(?!\s+not\b)/i,
  },
  {
    label: 'contrast reframe ("isn\'t X, it is Y")',
    hasInformativeUse: true,
    re: /\b(?:is|are|it)\s*n'?t\s+(?:just\s|merely\s|simply\s|only\s)?[^.;:!?]{3,60}[,;]\s*(?:it|they|that|this)\s*(?:'s|'re|is|are)\b(?!\s+not\b)/i,
  },
  {
    label: 'contrast reframe ("not just X, but Y")',
    hasInformativeUse: true,
    re: /\bnot\s+(?:just|only|merely|simply)\s+[^.;:!?]{3,60}[,;]\s*but\s+(?:also\s)?/i,
  },
  {
    // Anchored to the start of a sentence: the opening hedge is the tell, and
    // "it measures whether you appear in ChatGPT or Perplexity" mid-sentence
    // is ordinary English.
    label: 'the "Whether you are X or Y" opener',
    re: /(?:^|[.!?]\s+)Whether you(?:'re| are)\b[^.;:!?]{0,40}\bor\b/,
  },
  {
    label: 'stacked hedging',
    re: /\b(?:may|might|could|can)\s+(?:potentially|possibly|perhaps|arguably)\s|\b(?:often|sometimes)\s+(?:can|may)\s+(?:potentially|possibly)\b/i,
  },
]

export function rootPattern(word) {
  const root = word.replace(/(ed|ing|ly|e)$/, '')
  if (root.length < 4) return new RegExp(`(?<!\\w)${escapeRe(word)}(?!\\w)`, 'gi')
  return new RegExp(`(?<!\\w)${escapeRe(root)}(?:e|es|ed|ing|ion|ions|ional|ive|al|ally|s|ly|ness)?(?!\\w)`, 'gi')
}

export const exactPattern = (phrase) => new RegExp(`(?<!\\w)${escapeRe(phrase)}(?!\\w)`, 'gi')

const COMPOUND = /\b[a-z]{2,}-[a-z]{2,}(?:-[a-z]{2,})*\b/gi

/**
 * Hyphenated compound modifiers stacked in front of one noun: "our
 * industry-leading, context-aware, best-in-class, AI-powered platform". One
 * is ordinary English ("machine-readable", "answer-first"), so the floor is
 * five. The window is 220 characters rather than a sentence because interface
 * text carries no full stops, and splitting a page on [.!?] can turn the whole
 * document into one sentence.
 */
export const COMPOUND_FLOOR = 5
export function stackedCompounds(text, floor = COMPOUND_FLOOR) {
  const out = []
  for (const sentence of String(text).split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < Math.max(1, sentence.length); i += 220) {
      // A capital after the hyphen marks a product name (ChatGPT-User,
      // Google-Extended), not a stacked modifier, so it does not count.
      const found = (sentence.slice(i, i + 220).match(COMPOUND) ?? []).filter((c) => !/-[A-Z]/.test(c))
      if (found.length >= floor) {
        out.push({ count: found.length, sample: found.slice(0, 4).join(', ') })
        break
      }
    }
  }
  return out
}

/**
 * Proper nouns that CONTAIN a catalogue word, swapped for a neutral
 * placeholder before matching. "Core Web Vitals" is the name of Google's
 * metric group, not a register choice, and a page about it cannot be written
 * without it. A placeholder rather than a deletion keeps the sentence's shape
 * for the rules that reason about one.
 */
export const PROPER_NOUNS = [/\bCore Web Vitals?\b/gi]

export function findTells(input) {
  let text = normalise(input)
  for (const re of PROPER_NOUNS) text = text.replace(re, 'Entity')
  const lower = text.toLowerCase()

  const words = []
  for (const [list, pattern] of [
    [ROOT_TELLS, rootPattern],
    [EXACT_TELLS, exactPattern],
  ]) {
    for (const word of list) {
      const count = (lower.match(pattern(word)) ?? []).length
      if (count) words.push({ word, count })
    }
  }

  const phrases = TELL_PHRASES.filter((p) => lower.includes(p))

  const shapes = []
  for (const { label, re, hasInformativeUse } of TELL_SHAPES) {
    const m = text.match(re)
    if (m) shapes.push({ label, hasInformativeUse: Boolean(hasInformativeUse), sample: m[0].trim().slice(0, 80) })
  }

  return { words, phrases, shapes, compounds: stackedCompounds(text) }
}
