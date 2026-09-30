# Writing a page worth citing

## Contents

- **1.** The value test, before you write anything
- **2.** Formatting: people scan
- **3.** Voice
- **4.** Words and shapes that read as machine-made
- **5.** The self-check before you hand it over

The [seo-geo skill](https://github.com/rankxai/seo-geo-skills/blob/main/skills/seo-geo/SKILL.md) covers retrieval: rendering, answer-first structure,
passages, what has been tested and failed. This file covers the other half: whether the page is
worth a reader's time, and whether it reads like a person wrote it. Both matter for the same
reason. A page nobody finds useful gets no mentions, no links and no citations, whatever its
markup says.

---

## 1. The value test, before you write anything

Answer these in one sentence each. If you cannot, the page is not ready to draft.

1. **What does this page contain that no other page on the results page contains?**
2. **Who is the reader, and what can they do after reading that they could not do before?**
3. **What would make someone send this to a colleague?**

"It is more comprehensive" is not an answer to the first question. Google's guidance names the
failure directly: content that is "mainly summarizing what others have to say without adding much
value" is what its helpful-content systems are built to demote.

**Information gain** is the useful frame. Google's patent *Contextual estimation of link
information gain* (filed 2018, granted 2022) describes scoring a document by what it adds beyond
documents the reader has already seen. Google has not said whether it is used, so treat it as a
way of thinking rather than a ranking factor. On a results page where ten pages say the same
thing, the eleventh saying it again earns nothing either way.

### What creates information gain

Roughly in order of how hard it is for a competitor to copy:

- **First-hand measurement.** Your own data, from your own product, customers or experiments.
  Nobody else can run your numbers.
- **A null result nobody reports.** "This widely sold tactic was tested and did not work" is more
  useful than another list of tactics, and almost nobody publishes it.
- **A distinction the field blurs.** Two things usually treated as one.
- **Primary sources read properly.** Not "studies show" but the study, its sample, its date and
  what it actually tested.
- **A correction.** A number everyone repeats that does not survive checking.

A draft with none of these is a summary. Stop and find one.

---

## 2. Formatting: people scan

Nielsen Norman Group's classic studies (1997) found most users scan a new page rather than read
it word by word, and that a test site became markedly more usable when rewritten to be concise,
scannable and objective, with the three together worth more than any one. The studies are old;
the finding has been repeated in their eye-tracking work since, and it matches how retrieval
systems pick passages: front-loaded, self-contained blocks.

- **Paragraphs of 2 to 4 sentences, roughly 40 to 70 words.** Past about 90 words, readers skip.
- **One idea per paragraph.** A second idea buried mid-paragraph is usually missed.
- **Sentences around 20 words, one idea each.** A 50-word sentence is usually two.
- **Front-load every paragraph**, not just every section. Conclusion first, because many readers
  see nothing else.
- **A subheading every 2 to 4 paragraphs.**
- **Lists earn their place or go back to prose.** A list of full sentences is often a paragraph
  broken into bullets. Lists are for genuinely parallel items.
- **Tables for anything with more than two dimensions.** Comparisons in prose make the reader
  hold the grid in their head.
- **Bold the load-bearing clause**, not the keyword. Bolding for SEO is visible and reads as
  anxious.

None of this trades against retrieval. A self-contained 60-word paragraph that opens with its
claim is exactly what a grounding pipeline lifts.

---

## 3. Voice

- **Objective beats promotional.** Readers and retrieval systems both discount sales copy.
- **Say the number.** "Ahrefs compared 1,885 pages against about 4,000 controls" beats "studies
  suggest schema may not help".
- **Name who measured it, and when.** An unattributed statistic is a liability.
- **Admit uncertainty in the sentence that makes the claim**, not in a disclaimer at the end.
- **Never sell inside an explanation.** If the page mentions your product, do it once, near the
  end, clearly marked as yours. A reader who feels sold to mid-argument stops trusting the
  argument.
- **Write to the reader as a peer.** No "simply", no "just", no "of course".
- **Pick one spelling convention and keep it.** Proper nouns keep their own spelling.

---

## 4. Words and shapes that read as machine-made

One of these proves nothing. **Clusters do**, especially when nothing concrete is attached. The
reliable signal is formulaic sentence shapes plus an absence of specific detail, not vocabulary
alone. `scripts/check-prose.mjs` enforces the list below: words warn with a count, phrases and
shapes fail.

### Words to avoid unless they are genuinely the right word

<!-- prose-check: off -->
delve, tapestry, realm, landscape, multifaceted, nuanced, intricate, robust, pivotal, crucial,
vital, leverage (as a verb), foster, harness, underscore, navigate (figuratively), testament,
beacon, cornerstone, embark, elevate, unlock, streamline, seamless, myriad, plethora,
game-changer, dive into, boasts, empower, revolutionise, journey, effortless, supercharge,
turbocharge, unparalleled, holistic, synergy, transformative, cutting-edge, state-of-the-art,
world-class, best-in-class, unleash, next-level
<!-- prose-check: on -->

Some are ordinary English. The test is whether each is the most accurate word available, or
arrived because it sounded weighty.

### Phrases to cut on sight

<!-- prose-check: off -->
- "In today's fast-paced world" and every variant
- "It's worth noting that". If it is worth noting, note it.
- "In the ever-evolving landscape of"
- "Let's dive in", "Let's explore", "Buckle up"
- "I hope this helps", "Feel free to reach out"
- "In conclusion" or "In summary" opening a section
- "Whether you're an X or a Y" as an opening hedge
- "The key takeaway is". Say the takeaway.
<!-- prose-check: on -->

### Sentence shapes that give it away

<!-- prose-check: off -->
- **The contrast reframe.** "It's not about X, it's about Y." "This isn't just X, it's Y." It
  manufactures a feeling of insight without adding information, and it is the most recognisable
  machine shape in current prose. One per article is a lot. Zero is better. The exception is the
  informative use, where the second half carries a distinction the reader genuinely needs, and a
  parallel negation ("it is not a pass and not a failure") is not a reframe at all.
- **The rule of three, endlessly.** Occasionally right, usually padding.
- **Perfectly parallel paragraphs.** Same length, same internal shape, every section.
- **Hedge stacking.** "It can often be somewhat difficult to potentially determine." One
  qualifier or none.
- **The summary that repeats the intro.** If the closing paragraph could go, it should.
<!-- prose-check: on -->

### The em dash

The em dash has become one of the most noticed tells in general-audience writing, fairly or not.
Use a comma, a colon, a full stop or brackets. A sentence that seems to need one is usually two
sentences. The same goes for metadata: titles, descriptions, alt text and ARIA labels are copy
too.

### Invisible characters

Zero-width spaces, direction marks and characters from the Unicode tag block have no place in
published copy. They break search matching, they can make displayed text differ from stored text,
and the tag block is a known way to hide instructions from human readers while a model still sees
them. `check-prose.mjs` fails on all of them.

---

## 5. The self-check before you hand it over

- [ ] Could a reader who knows the field learn something specific here?
- [ ] Is there at least one number, null result or distinction that appears on no competing page?
- [ ] Does every section open with its answer, naming the subject rather than "it"?
- [ ] Any paragraph over about 90 words, or carrying two ideas?
- [ ] Any sentence over about 40 words that is really two?
- [ ] Any word from the list above that is not the most accurate word available?
- [ ] Any contrast reframe?
- [ ] No em dashes, including in metadata?
- [ ] Does any product mention sit at the end, once, clearly marked?
- [ ] Does every number name who measured it and when?
- [ ] Would you send this to someone whose opinion you respect?

The script covers the mechanical half. The last question is yours.
