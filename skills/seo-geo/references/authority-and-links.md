# Authority, links and freshness

Sections 4, 6, 7 and 10. What makes a page worth citing, how much of citation is decided off your
own site, how much freshness really buys, and how links work inside and out.

Read this when you are deciding what a page should contain and where it sits in the site,
rather than how it is marked up or delivered.

## Contents

- 4. Write something worth citing, with the GEO paper read properly
  (includes E-E-A-T without the mythology, and entity consistency)
- 6. The off-page reality: most citation influence is not on your page
- 7. Freshness
- 10. Links and anchor text (includes hub and spoke)

---

## 4. Write something worth citing, with the GEO paper read properly

The most quoted claim first, because it is usually quoted wrong.

The GEO paper (Aggarwal et al., *GEO: Generative Engine Optimization*, KDD 2024) tested nine
ways of rewriting a source and measured how much more visible it became in generated answers. In
its main results, Quotation Addition ranked first (roughly +41% over the baseline), then
Statistics Addition, then Cite Sources, and keyword stuffing lost ground on that main
measure. It is often repeated as
<!-- prose-check: off -->
"cite sources, +40%",
<!-- prose-check: on -->
which is not what its table shows. The paper also does not
prescribe any passage length, and the prompts it used allowed invented sources and statistics.

More important than the ranking is what happened next. The paper measured citation share in a
simulated setting where five documents were placed directly into the model's context, so
retrieval was taken out of the picture entirely. Later work testing similar rewrites in more
realistic conditions found far weaker effects: C-SEO Bench (2025) found significant gains in only
3 of 54 method and domain combinations, and a 2026 benchmark found rewritten pages lost about
9% at retrieval and 16% at reranking. A 2026 critical survey concludes no rewrite technique shows a
stable, cross-platform causal effect [X].

What survives:

- Keyword stuffing does not help. It lost about 8% on the original paper's main visibility
  measure (it scored slightly better on a second, subjective measure), and the 2026 survey grades
  it null or negative [P] [X].
- Relevance to the sub-question and position in the document held up across the replications.
  In one large 2026 study, concrete price and recency cues also helped consistently, while
  formatting-only rewrites did little. That is §2 and §3, not a writing trick [P] [S].
- Concrete, extractable facts (real prices, dates, numbers, quotes with names) keep their
  support. They are what extractive snippets can lift, and a competitor's language model cannot
  fake your specifics [S].
- First-hand data, named sources and original numbers make a page the primary source other
  pages cite, and brand mentions across the web are the strongest off-page correlate there is (§6).
  Commodity prose earns neither.

So cite sources, quote named people and give real numbers with dates, because that makes the page
worth citing and extracting, not because a multiplier promised it.

### E-E-A-T, without the mythology

E-E-A-T is not a score, and it is not only a rater rubric either. Google says "E-E-A-T itself isn't
a specific ranking factor", but that its systems look for "a mix of factors" that signal it and
"give even more weight" to strong E-E-A-T on topics that affect health, money or safety. Human
quality raters use the same idea to check whether those systems work; their ratings do not rank
pages. What no test has shown is that author markup or bylines, as page features, lift rankings or
citations. Google's Danny Sullivan (January 2024): "Author bylines aren't something you do for
Google, and they don't help you rank better." Google still "strongly encourage[s]" accurate bylines
where readers expect them, for readers [G] [X].
Figures like Semrush's "+30.64%" for E-E-A-T signals come from correlations over visible text
features on cited URLs: direction at best, confounded by site quality [V].

Do these for readers, for credibility on topics that affect money or health, and for entity
resolution, not as a ranking lever:

- A real named author with relevant credentials, linked to a bio page. Not "Admin".
- `Person` schema with `sameAs` to LinkedIn, ORCID or a personal site, so an engine can
  resolve the name to a person. Never invent profile URLs.
- Visible dates that match the schema (§9b).
- Outbound links to primary sources. Linking to the study you quote is credibility, not a
  leak of authority.
- First-hand experience stated plainly. "We ran this on 40 sites and found..." is the part a
  competitor cannot copy.
- "Reviewed by" a named expert for medical, legal and financial topics.

### Entity consistency

If an engine cannot work out who you are, it cannot cite you with confidence.

- One canonical name, used identically everywhere. "Acme Analytics", "Acme" and "AcmeAnalytics"
  are three different strings to a machine. Pick one and enforce it in copy, schema, profiles and
  third-party listings.
- `Organization` schema with `sameAs` to every profile you control: Wikipedia, Wikidata,
  LinkedIn, Crunchbase, GitHub.
- Wikipedia and Wikidata carry disproportionate weight, because they are heavily represented
  in training data and retrieval. You cannot write your own entry. The notability that earns one
  is worth more than most link building.
- The widely quoted "+46% impressions from entity markup" is one vendor case study of a handful of
  pages on a single site. Treat it as an anecdote [V].

## 6. The off-page reality: most citation influence is not on your page

This section is well supported, and it limits how much on-page work can achieve:

- Brand mentions across the web correlate with AI Overview visibility about three times as
  strongly as backlinks. Ahrefs, across 75,000 brands: Spearman 0.664 for plain web mentions and
  0.527 for branded anchors, against 0.218 for the number of backlinks. A follow-up across
  three AI surfaces found YouTube mentions the strongest single predictor (0.737) [S].
- Brands appear in AI answers through third-party sources (review sites, Reddit, publishers)
  about 6.5 times as often as through their own domains (AirOps, October 2025). Owned pages get
  cited more once a buyer is checking details, so you need both [S].
- Citations and mentions are different things. Your page can be linked as a source while the
  answer never names you, and users rarely click: Pew found people clicked a link inside Google's
  AI summary on about 1% of visits (March 2025 data). Being named in the answer is the prize
  [S].
- How much organic rank predicts AI citation is contested. Use the trend, not a snapshot:

  | Finding | Surface | Source |
  |---|---|---|
  | Top-10 share of AI Overview citations fell from about 76% to about 38% between mid-2025 and early 2026 (Ahrefs notes part of the drop comes from its own change in method) | AI Overviews | Ahrefs, 863,000 SERPs, 4 million cited URLs [S] |
  | 88% of citations are not in the organic top 10 for the visible query | Google AI Mode | Moz, about 40,000 queries [S] |
  | Only about 12% of URLs cited by assistants rank in Google's top 10 for the prompt (Perplexity about 29%, the others about 8%) | ChatGPT, Gemini, Copilot, Perplexity | Ahrefs, 15,000 long-tail queries, August 2025 [S] |
  | Domain-level overlap stays much higher than URL-level | all | several studies [S] |

  The reconciliation: AI Overviews sit on Google's ranking stack; AI Mode cites pages that rank for
  sub-queries (§3); ChatGPT does not use Google at all. And one model upgrade can reshuffle
  everything. Safe reading: ranking somewhere an engine retrieves from is the minimum; a top-10
  position for the head term is neither required nor enough. Any single overlap percentage has
  a shelf life of months.
- Being cited is worth real traffic even as clicks fall. Seer Interactive's April 2026 study
  (53 brands, 5,471,127 queries) found brands cited in an AI Overview earn about 120% more organic
  clicks per impression than uncited brands. Read the other half too: informational queries that
  show an AI Overview still earn fewer clicks (about 38% fewer) than informational queries with no
  AI Overview. A citation beats everyone else on that page; it does not bring back the old
  baseline [S].
- Reddit and forums: real but unstable. Reddit appeared in about 37% of Google top-10 results in
  SE Ranking's 2025 data, and brands mentioned on Reddit are cited more by ChatGPT, but a cited
  thread's own Google rank does much of the work. Visibility also swings: Google's March 2026 core
  update cut Reddit's visibility, reversed within weeks, and the May 2026 update raised it again.
  Show up where your buyers ask questions; do not buy your way in (§5) [S].

These are correlations, and brand size confounds all of them: big brands get mentions and
citations. Nobody has published a clean causal test of "seeding" mentions. Treat them as
direction, not dose, and remember there is an industry selling manufactured mentions on the
strength of exactly these numbers [V].

## 7. Freshness

Freshness has a real but modest effect, and it differs by platform. "AI only cites fresh content"
is folklore.

- The largest clean measurement (Ahrefs, 17 million cited URLs): content cited by AI assistants
  averages about 1,064 days old, against 1,432 for pages in organic results. About a quarter
  fresher, and still around three years old. ChatGPT is the freshest; AI Overviews show little or
  no freshness preference [S].
- Pages not updated for over three months were about three times more likely to *lose* ChatGPT
  citations (AirOps with Kevin Indig, December 2025) [S].
- Split-test evidence for freshness *signals* is small: putting the current month and year in the
  title gave about +5% organic sessions in a SearchPilot test, short of 95% significance [E].
- Widely quoted figures such as "76% of ChatGPT citations are under 30 days old" trace to a source
  that no longer resolves. Do not use them [X].

The causality partly runs backwards. Topics that churn (news, pricing, tools, "best X in
2026") get both more updates and more citations. A stable definition page is not losing citations
for being two years old, and rewriting it on a schedule buys nothing.

| Content type | Freshness pressure | Cadence |
|---|---|---|
| News, pricing, tool comparisons, "in 2026" pages | High, genuinely decays | Weeks |
| Product and feature pages | Medium, follows the product | On change |
| Definitions, concepts, glossaries | Low | Review quarterly, edit only if wrong |

Update genuinely and date it. Do not touch `dateModified` without changing the content. It is
detectable, it misleads readers, and it teaches search engines to ignore your dates (§9b).

Make the review date data, not memory. A `refreshDueAt` field on every page turns "which pages
are stale?" into a query that someone can run every month.

## 10. Links and anchor text

- Anchor text describes the destination. It is the strongest on-page signal about what the
  target page is, for Google. LLM retrieval largely ignores anchors, but internal links still
  matter for AI visibility indirectly, because they drive the crawling and ranking retrieval sits
  on.
- Never reuse one anchor for two different destinations on a page.
- The real evidence on internal linking: Zyppy's study of 23 million internal links across 1,800
  sites found pages with more internal links pointing at them got more Google traffic, up to
  roughly 45 to 50 links, after which traffic declined. Its first study linked varied anchor text
  to more traffic; its 2026 follow-up on 50 sites found the opposite, so treat anchor variety as
  unsettled [S]. SearchPilot has measured specific internal-linking changes with gains from +5% to
  +25%, alongside inconclusive ones [E]. "Add 3 to 5 links and see movement in 6 weeks" has no
  primary source.
- Keep important pages within a few clicks of the home page. Three is a common convention, not a
  documented Google rule; what matters is that important pages are linked from pages that are
  themselves crawled often.
- Use real `<a href>` links. A `<div onClick>` is not a link and is not crawled.
- Stable, lowercase, hyphenated, descriptive natural-language URLs. Slug quality correlates
  with ChatGPT citation (§3). Changing URLs costs you; redirect with a 301 if you must.
- `rel="nofollow"`, `ugc` or `sponsored` on untrusted or paid links.
- Every link in your footer must resolve.

Architecture, not just individual links:

- Hub and spoke. A pillar page covers the topic broadly, cluster pages go deep. Every cluster
  page links up to the pillar, the pillar links down to all of them, and siblings link across where
  it genuinely helps. This is the structure that answers a fan-out cluster well: §3 at site level.
- Find orphans. A page with no internal links pointing at it is close to invisible, whatever
  its quality. Compare your crawl against your sitemap.
- Link from established pages to new ones, not only from the navigation.
- Watch for passages that repeat each other across pages. Two of your pages answering the same
  sub-question at the same depth compete for the same passage slot.
  `content-review/scripts/check-overlap.mjs` finds them.
