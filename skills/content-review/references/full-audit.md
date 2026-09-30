# The full audit

## Contents

- **Phase 1** Analyse the current page
- **Phase 2** Results page and competitor research
- **Phase 3** Quality audit, factor by factor
- **Phase 4** The rewrite, and what to hand over
- **Phase 5** Quality gate

[SKILL.md](../SKILL.md) is the routine pre-publish pass. Use this file for a deeper review: a
quarterly refresh, a pillar page, a page that underperformed, or any time someone asks for a full
audit. Work the phases in order and do not start rewriting until the research is done. A rewrite
started early gets anchored to the draft's existing shape.

---

## Phase 1: Analyse the current page

1. **Target query and intent.** What is the primary query? Is the dominant intent informational,
   commercial, transactional or navigational? Does the page serve it, or drift?
2. **Format fit.** Look at what the top ten results actually are: tools, lists, comparisons,
   guides, definitions. If most are one format and yours is another, a better version of your
   format will still struggle. Say so rather than polishing the wrong thing.
3. **Structure.** Heading outline, scannability, and whether the answer to the core query sits in
   the first 150 words or is buried.
4. **Weaknesses.** Thin sections, unsupported claims, generic filler, missing subtopics, dated
   information, a weak opening, missing internal or external links.
5. **Machine tells.** Run `scripts/check-prose.mjs` and read [writing.md](writing.md) section 4
   for what the script cannot judge.
6. **Verdict.** A score out of 10 as it stands, with one paragraph on why it would or would not
   rank today.

## Phase 2: Results page and competitor research

1. **Read the top five to eight results.** For each: its angle, what it covers that this page
   does not, its depth, and what they *all* miss. That last item is the gap this page can own.
2. **Find the information gain.** Two or three things no competitor says, ranked by how hard they
   are to copy: first-hand measurement, a null result, a distinction the field blurs, primary
   sources read properly, a correction to a repeated number.
3. **Collect five to ten statistics, each verified by fetching the source.** Record the exact
   figure, who measured it, the **data collection date** and the URL. Never approximate, never
   quote from memory.
4. **Recheck anything older than a month** using SKILL.md section 2. Platform behaviour, citation
   shares and crawler rules get rechecked whatever their age.
5. **People Also Ask and related searches.** List them, and mark which the page should answer.
   Separate genuine questions from noise.
6. **Freshness of the results page itself.** What in the draft is dated relative to what ranks,
   and, more valuable, what in the ranking pages is dated relative to reality.

## Phase 3: Quality audit, factor by factor

Give each factor Pass, Partial or Fail, with the evidence and the exact fix.

- **Experience.** Specific examples, real scenarios, process detail, "we measured" framing. Or
  does it read like someone who has never done the thing?
- **Expertise.** Depth, correct terminology, edge cases a beginner would miss.
- **Authoritativeness.** Citations to primary sources, and whether the page itself is worth
  citing.
- **Trustworthiness.** Accurate claims, limitations stated in the sentence that makes the claim,
  sources linked, dates included.
- **Helpfulness.** Would a reader feel finished, or go back to the results page? Is there value
  beyond summarising others? Answer first, then depth?
- **Extractability for AI search.** Direct answers, labelled sections, definitional sentences,
  attributed statistics, self-contained passages an assistant could lift and credit. See the
  [seo-geo skill](https://github.com/rankxai/seo-geo-skills/blob/main/skills/seo-geo/SKILL.md) sections 2 and 3.
- **Citability.** What would another site link to? If nothing, name the asset to add.
- **On-page basics.** A title that says plainly what the page is, echoing the H1; about 50 to 60
  characters including any site-wide suffix fits most results, though Google sets no limit. A meta
  description written for a person. One H1. A logical heading outline. The main topic
  named in the first 100 words. Internal links with descriptive anchors. External links to
  primary sources. Alt text. A clean slug. Structured data that mirrors visible copy.

Weigh any SEO tool's recommendations against the "measured not to work" table in the seo-geo
skill. Generic tools still recommend keyword density targets, llms.txt as a ranking lever and
schema as an AI-citation lever, and the evidence answers all three.

## Phase 4: The rewrite, and what to hand over

**Substance.** Answer the core query in the first 150 words. Cover the subtopics and questions
the research showed matter, and cut what does not serve the reader. Work in the verified
statistics with inline attribution. Include the information-gain elements and the citable asset.
Show experience through concrete numbers and honest trade-offs: this works when X, avoid it when Y.

**Voice.** Per [writing.md](writing.md) section 3. Objective, peer register, one spelling
convention, any product mention once at the end. Vary sentence length. Take positions and back
them.

**Hand over, in this order:**

1. Title with character count, plus two alternatives
2. Meta description with character count
3. Slug recommendation (usually "keep it": changing a slug costs the links it has earned)
4. The rewritten page, in whatever format the site publishes
5. Internal links: anchor text and target for each
6. Structured data recommendation (usually "generate it from the same fields that render the
   copy", never a hand-written snippet that will drift)
7. A changelog: the five to eight biggest changes and why each helps
8. The source list: every statistic with its URL and data date

## Phase 5: Quality gate

Confirm each before presenting. Fix anything that fails first.

- [ ] Core query answered in the first 150 words
- [ ] Every statistic verified by fetching its source, attributed and dated
- [ ] Every figure older than a month rechecked, with what was confirmed noted alongside what was
      replaced
- [ ] Every figure checked for what it measures: rate or share, and of what denominator
- [ ] At least two information-gain elements competitors lack
- [ ] At least one asset worth linking to
- [ ] No unsupported claims; experience signals present
- [ ] `check-prose.mjs` clean, and every paragraph passes "would a busy expert write this?"
- [ ] Reads well aloud
- [ ] Title, description, H1 and heading outline all pass
- [ ] Quotable, self-contained passages exist
- [ ] Nothing exists only to hit a word count
- [ ] `check-sources.mjs` and `check-overlap.mjs` still clean after the edits

Then score it out of 10 against the original and say what would take it to 10.
