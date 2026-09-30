---
name: seo-geo
description: SEO and AI-search audit for a site or page. Use when asked why a site isn't ranking or cited by ChatGPT, Perplexity or AI Overviews, or to check robots.txt, AI crawlers, sitemaps, schema or llms.txt.
license: MIT
metadata:
  version: "1.0.0"
  repository: https://github.com/rankxai/seo-geo-skills
  last-verified: "2026-09-29"
---

# SEO and GEO, graded by evidence

Optimisation for classic search (SEO), for generative engines (GEO) and for answer engines (AEO),
where every rule carries a tag saying how strong the evidence behind it is. Controlled experiments
are kept apart from correlation studies, vendor claims are marked as vendor claims, and there is a
list of tactics that were measured and found wanting.

**Last verified against primary sources: 29 September 2026.** Crawler rules, index composition and
vendor guidance all change, and one widely quoted overlap figure moved 38 points in seven months.
Before you repeat a number from this skill to anyone, open its source.

## Quick start

Plain Node 18 or later, nothing to install. Paths are from the repository root; in an installed
skill the scripts sit in this skill's own `scripts/` folder.

```bash
node skills/seo-geo/scripts/audit-page.mjs https://example.com/pricing     # one page, every mechanical rule below
node skills/seo-geo/scripts/crawl-site.mjs https://example.com             # a whole site: broken links, orphans, duplicates, redirect chains
node skills/seo-geo/scripts/check-crawlers.mjs https://example.com --live  # which AI crawlers robots.txt and the CDN let in
node skills/seo-geo/scripts/check-sitemap.mjs https://example.com          # every sitemap URL: 200, indexable, self-canonical
node skills/seo-geo/scripts/analyze-gsc.mjs ./gsc-export/                  # Search Console exports, read offline
node skills/seo-geo/scripts/check-logs.mjs access.log --verify             # which crawlers really visited, verified by IP
```

Every script takes a saved file as well as a URL where that makes sense, prints a plain report and
supports `--json`. Exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check.

## Where to look

This file holds the rules that apply to every page. The detail is in the reference files, and
section numbers carry across, so "§9b" always resolves.

| Read | For |
|---|---|
| [references/site-changes.md](references/site-changes.md) | **§18** auditing a whole site, migrations and redirects, hreflang, faceted navigation, programmatic pages, a first 30 days |
| [references/measurement.md](references/measurement.md) | **§16** Search Console, Bing's AI Performance report, analytics and logs, and building a prompt panel |
| [references/page-fields.md](references/page-fields.md) | **§8** document structure, **§9** head elements, dates, authorship, schema by page type, **§13** what structured data is for |
| [references/authority-and-links.md](references/authority-and-links.md) | **§4** writing something worth citing, E-E-A-T, entities; **§6** off-page; **§7** freshness; **§10** links |
| [references/technical-delivery.md](references/technical-delivery.md) | **§11** images, **§12** Core Web Vitals, **§14** crawler control by purpose and CDN policy, **§15** accessibility and agents |
| [references/commerce.md](references/commerce.md) | **§17** AI shopping: feeds, ChatGPT and AI Mode, checkout protocols |
| [references/verification.md](references/verification.md) | copy-paste `curl` checks, priorities by page type, and every source by evidence grade |

Data files: [data/crawlers.json](data/crawlers.json) (documented AI crawlers, by purpose, with the
vendor's own words on robots.txt), [data/myths.json](data/myths.json) (widely repeated claims that
are false, each with its source), [data/google-changes.json](data/google-changes.json) and
[data/ai-platform-changes.json](data/ai-platform-changes.json) (dated changes since February 2026,
each confirmed on the platform's own pages).

**Auditing a whole site?** Read §18a first. It covers what to do before trusting any finding:
check it against the live HTML, never recommend what already exists, and never state a number you
did not read from data you were given.

## 60-second pre-ship check

1. Is the content in the raw HTML? `curl -s <url> | grep -q "<a distinctive sentence>"`
2. One `<h1>`, no skipped heading levels?
3. The answer in the first 100 or so words, and at the top of each `<h2>` section?
4. Does each `<h2>` section name its subject rather than saying "it", and would it make sense
   quoted alone?
5. A unique title that says plainly what the page is, echoing the H1? A description written for a
   person?
6. Every image has `alt`, `width` and `height`? The main image above the fold has
   `fetchpriority="high"` and is not lazy-loaded?
7. Structured data matching the visible copy, with every fact that must be quotable also in the
   visible text?
8. Do the visible date, `dateModified` and sitemap `lastmod` agree? (§9b)
9. Three to five contextual internal links out, with descriptive anchor text?
10. Any real statistics, first-hand data, quotes or named sources, or is it prose any model could
    have written?
11. Can the search crawlers get in, in robots.txt and at the CDN: Googlebot, Bingbot, Applebot,
    OAI-SearchBot, Claude-SearchBot, PerplexityBot? Is the site set to Include in Search Console's
    Search generative AI setting? Is there a stray `noarchive` that takes pages out of Copilot? (§14)

## How to read this: evidence grades

Most SEO and GEO advice has never been measured. Three things make that worse:

1. **Google's public statements have been contradicted by its own internal documents.**
2. **Most GEO research is published by vendors selling GEO tools.**
3. **"Cited pages have X" is not "adding X gets you cited".** Almost every correlation in this
   field is confounded by one variable: being a large, well-run site. Big sites have schema, fast
   pages, author bios and llms.txt files, and they also get cited. The only way through is
   intervention: someone adds X to real pages and measures the change against controls. When teams
   do that, they keep finding nulls where correlation studies found lifts.

So every rule is tagged:

| Tag | Meaning | Trust |
|---|---|---|
| [E] | Controlled experiment or split test: X was added, the change measured against controls | Highest |
| [P] | Peer-reviewed or academic research | High, if the setting matches reality |
| [M] | Directly measured behaviour: crawler logs, API instrumentation, court records | High |
| [S] | Large-sample correlation study, sample size given | Medium: direction, not dose |
| [G] | Official platform documentation (Google, Microsoft, OpenAI, Anthropic, Apple) | Medium, see below |
| [V] | Vendor study: directionally useful, conflicted | Low |
| [X] | Tested and found not to work, or failed replication | Act on this |

Where evidence conflicts, prefer [E] and [M]. And keep one base rate in mind: across all the SEO
split tests SearchPilot ran in 2022 and 2023, about 75% were inconclusive, about 15% won and 7 to 8%
actively hurt [E]. SearchPilot later re-scored a sample with a more sensitive model and counted
nearer 29% as wins, which still leaves most changes doing nothing measurable. Price any tactic sold
without a test against that.

## Official guidance is the starting point, not the last word

The May 2024 Google Content Warehouse leak (2,596 modules, 14,014 attributes) contradicted years of
public statements. Google confirmed the documents were real while disputing how they were being
read [M]:

| Google said publicly | The documents showed |
|---|---|
| There is no "domain authority" metric | A `siteAuthority` feature |
| Clicks are not used for ranking | NavBoost, click-driven re-ranking, also described in sworn testimony at the US v. Google trial |
| There is no sandbox for new sites | A `hostAge` attribute used "to sandbox fresh spam" |
| Chrome data is not used in Search | A `chromeInTotal` site-level signal |

The leak proves these attributes exist in a storage schema, not their weights or current use.
Public guidance is written to discourage manipulation, so it tends to understate anything that can
be gamed.

Sometimes Google is right and the industry is wrong. Google says structured data is not needed for
AI features [G], and the evidence agrees (§13). Its AI optimization guide (updated 10 July 2026) says
there is "no requirement to break your content into tiny pieces" [G], which matches what has been
measured for Google. For other engines, measured retrieval behaviour (§3) shows passage structure
does matter. The two fit together: one clear subject per section is not tiny pieces.

Google also warns about tools that sell this kind of advice. Its third-party SEO guidance (June 2026)
names "AEO" and "GEO" tools and says third-party tools "don't have access to our internal ranking
data" and "can't guarantee performance" [G]. Any score a tool computes, ours included, is that
tool's own measurement.

---

## 0. The retrieval map: "AI search" is not one channel

Each engine retrieves differently, which decides how much classic SEO carries over. As of September
2026 [M] [G]:

| Engine | Retrieves from | What carries over, and the controls |
|---|---|---|
| Google AI Overviews and AI Mode | Google's index, through "query fan-out" (§3). Grounding uses a faster, cut-down semantic ranking described in the court's findings in US v. Google (September 2025), citing Google's own testimony. Since Google I/O (May 2026) an AI Overview can lead straight into an AI Mode conversation | Google SEO carries over most. The page must be indexed and snippet-eligible, and the site included in Search Console's Search generative AI setting (defaults to Include). `nosnippet` and `max-snippet` limit what AI answers may use |
| Microsoft Copilot | Bing's index, which since June 2026 also grounds third-party agents through Microsoft's Web IQ APIs | Bing SEO carries over directly, and Bing says grounding weighs freshness and accuracy more than ranking did. Bing uses `noarchive` to keep a page out of Copilot answers entirely, and `nocache` to limit it to title, URL and snippet, while Google ignores both |
| ChatGPT search | OpenAI's crawler (OAI-SearchBot) plus licensed and third-party data. In Profound's July 2025 data only about 8% of ChatGPT's citations matched Bing's top results and about a third matched Google's | Partly. OpenAI says sites that block OAI-SearchBot "will not be shown in ChatGPT search answers, though can still appear as navigational links"; only `noindex` removes the link as well, and the crawler must be allowed to see it |
| Perplexity | Its own index (over 200 billion URLs, as Perplexity described it in September 2025), with its own rerankers | Partly. Google rank correlates but is not the mechanism |
| Apple (Siri and Search answers) | Applebot. Siri AI, released September 2026, answers from web information | Apple says `nosnippet` keeps a page out of its AI-generated answers, and `isAccessibleForFree` set to false keeps it in search but out of AI context |
| Claude | Anthropic's Claude-SearchBot index plus a third-party search provider that Anthropic does not name (Brave appears on its subprocessor list). Since September 2026 the new Claude experience searches whenever Claude judges it useful, with no toggle | Least documented |

What follows from this:

- Only about 11% of domains are cited by both ChatGPT and Perplexity (Profound, the same 100,000
  prompts run on each, July 2025 data), and across other pairs of engines Profound found between
  about 6% and 16%. Academic audits in 2026 find overlap as low or lower. Optimising for "AI" as one
  thing is a category error [S].
- Google's AI retrieval is semantic first: relevance to the sub-query beats site authority there [M].
- Where organic rank still gates citation is contested and moving (§6 has the numbers). The stable
  version: being retrievable somewhere each engine looks is the floor.

## 1. Rendering: the rule that outranks every other

**Every word that must rank or be cited belongs in the server-rendered HTML.**

- The crawlers that feed ChatGPT, Claude and Perplexity executed no JavaScript when Vercel and MERJ
  measured them across Vercel's network (published December 2024, about 1.3 billion AI crawler
  fetches in a month): GPTBot and ClaudeBot downloaded JavaScript files in 11.5% and 23.8% of
  requests and ran none of them, and CCBot does not render either [M]. That is still the best public
  measurement, and it is 21 months old. OAI-SearchBot now sends a full Chrome user agent, which does
  not prove it renders, and one October 2025 test saw a JavaScript-only price turn up in Perplexity's
  results. Re-test with a sentence that only JavaScript inserts, and check your logs, before relying
  on either answer.
- Three major crawlers do render: Googlebot, Bingbot and Applebot. Googlebot's rendering also serves
  Gemini; Bing's guidelines ask sites to "allow Bingbot to crawl and render content efficiently" and
  warn that "content that cannot be reliably rendered may not be indexed or selected for grounding
  results", which covers Copilot; and Apple's documentation says "Applebot may render the content of
  your website within a browser" [M] [G]. So never write that AI crawlers as a group skip
  JavaScript: name the crawlers, or say "every crawler except Googlebot, Bingbot and Applebot".
- Browser agents are different. ChatGPT's agent, Perplexity's Comet and Claude in Chrome drive real
  browsers and do render, but those are single-user sessions, not index crawls. Retrieval and
  citation still run on the raw HTML [M].
- Retrieval pipelines turn HTML into plain text or Markdown before a model sees it. Visible body text
  survives that. Text living only in `<script>` tags is unreliable: in searchVIU's test no engine
  extracted a price that existed only in JSON-LD, while in another ChatGPT and Perplexity read an
  address from a JSON-LD block as plain text (§13) [M].
- Google may not render pages that return a status other than 200, so an error page that builds its
  content in JavaScript may never be seen [G].

What to do:

- Server-render or statically generate every piece of meaningful content. Use client-side JavaScript
  for interaction, never for content that must be found.
- Keep the answer to each heading visible on load. Collapsed text inside the HTML still counts for
  indexing, but Google's "read more" deep links, which jump a searcher to the matching section,
  favour content that is visible on load (April 2026). Collapse detail, not answers, and do not strip
  `#fragments` from the URL on load [G].
- If JavaScript changes the canonical or the robots meta, the raw HTML and the rendered page must
  agree. Never put `noindex` in the raw HTML and remove it with JavaScript [G].

`audit-page.mjs` reports how much visible text is in the raw HTML. If that is close to zero, fix it
before anything else.

## 2. Answer first

Put the answer at the top. Several kinds of evidence point the same way:

- *Lost in the Middle* (Liu et al., TACL 2024): language models use information at the start or end
  of their context much better than in the middle. Newer long-context models narrow the gap but, in
  2026 re-tests, have not closed it [P].
- About 44% of ChatGPT citations come from the first 30% of a page (Kevin Indig, 44.2% of 18,012
  verified citations). The same work found cited passages are about twice as likely to use
  definitional phrasing ("X is", "X refers to") and read at a simpler grade level [S].
- Question-format `<h2>` headings gave +12% organic sessions in a SearchPilot split test (the
  headings also gained the product name). Brand selling-point modules near the top of pages gave +18%
  traffic from AI assistants, with the effect on Google inconclusive (SearchPilot with Omio) [E].
- Google's grounding is extractive: it lifts near-verbatim sentences that stand on their own [M].

So:

- Open the page, and each `<h2>` section, with the answer. Do not build up to it.
- Write a 40 to 60 word direct answer near the top that survives being quoted with no context. Make
  it a required field in your CMS, not a habit.
- Prefer "X is a Y that does Z" over a chain of pronouns, and write plainly.

> **The one controlled GEO test pair we know of is a warning** [E]. The same SearchPilot programme
> that found +18% from selling-point modules also tested a "key takeaways" bullet block. It raised AI
> referral traffic and cost an estimated 6.5% of Google organic sessions, so it was not rolled out.
> GEO and SEO effects can pull in opposite directions on the same change, so measure both before
> changing templates. And do not split content into micro-pages: Google says it understands
> multi-topic pages, and fragmenting has no evidence behind it.

## 3. Query fan-out and passage-level retrieval

This is how AI search retrieves, and it moves the unit of optimisation from the page to the passage.

**Fan-out.** "Query fan-out" is Google's own term, introduced with AI Mode in March 2025 and now in
its AI documentation. The engine splits a question into subtopics and runs many searches at once;
Google says its Deep Search mode runs "hundreds of searches". It has never published a count for an
ordinary query, so treat any specific number you read as made up [G].

What the evidence says fan-out rewards:

- In a 1.4-million-prompt ChatGPT study (Ahrefs, published April 2026), similarity between the page
  title and the sub-queries was among the strongest citation correlates, stronger than similarity to
  the original prompt. Descriptive, natural-language URL slugs also correlated with citation [S].
- 88% of Google AI Mode citations are not in the organic top 10 for the visible query (Moz, about
  40,000 queries), because they rank for the sub-queries instead [S].
- Sub-queries are generated and vary between runs, padded with words nobody typed ("best",
  "reviews", the current year). You cannot target them exactly. You can cover them. Bing's AI
  Performance report shows the actual "grounding queries" that retrieved your pages (§16).

What to do:

- Give each sub-question its own `<h2>`, phrased the way a person would ask it. Question-format
  headings have causal support: +12% in a split test [E].
- Answer the obvious neighbouring questions on the page rather than sending the engine elsewhere.
- State comparisons, specifications and criteria explicitly. Fan-out reliably generates commercial
  and comparative sub-queries.
- **Cover sub-questions on the page; do not spin out a page per fan-out variant.** Google's AI guide
  says creating "separate content for every possible variation", fan-out queries included, to
  manipulate rankings or AI responses "violates Google's scaled content abuse spam policy" [G].

**Passage mechanics, measured.** Dan Petrovic instrumented Google's Gemini grounding API (7,060
queries, 883,000 snippets) [M]:

- Google allows roughly 2,000 words of grounding per query, split across the top sources by
  relevance. The top source contributes around 530 words, the fifth around 266.
- The median page contributes about 377 words, and extraction levels off around 540 words per page.
  Pages under 1,000 words get about 61% of their content used; pages over 3,000 words, about 13%.
  Density beats length.
- Extraction is near-verbatim, chosen for sentences that stand alone.

Mike King's chunking demonstrations point the same way. Splitting a two-topic paragraph improved one
half's similarity to its query by about 19%, and in a separate example putting the heading in front
of a passage improved it by about 17% [M]. They are different measurements, so do not add them.
Chunk sizes inside ChatGPT, Perplexity and Claude are not public.

At passage level:

- Repeat the subject's name instead of "it" at the start of each section. "Acme Analytics tracks..."
  survives extraction; "It tracks..." does not.
- One subject per passage: each `<h2>` section should answer its own heading completely.
- Do not split one argument across a heading.
- Front-load each section; the start and end of a passage carry the most weight.
- Past about 500 dense words on one subtopic, most of it is never extracted.

(§4 onwards lives in the reference files: see the table under "Where to look".)

## 5. What has been measured NOT to work

Stop spending on these.

| Tactic | Finding | Evidence |
|---|---|---|
| llms.txt | 97% of the files received zero requests in server logs from 137,000 domains (Ahrefs, May 2026 data). Of the bots that did ask, SEO audit tools were the largest group and AI retrieval bots about 1%. SE Ranking found no citation difference across 300,000 domains. Google says Search does not use it and that it "will neither harm nor help". No engine documents reading it | [M] [G] [X] |
| JSON-LD as an AI-citation lever | 1,885 already-cited pages that added schema, compared 30 days before and after against about 4,000 that did not: no upward movement. ChatGPT +2.2% and AI Mode +2.4% are within noise; AI Overviews −4.6% was statistically significant but small. A matched natural experiment, not a controlled test. §13 covers what schema is still for | [S] [M] [X] |
| FAQ and HowTo rich results | HowTo rich results ended in 2023. FAQ rich results stopped showing on 7 May 2026. Visible question-and-answer copy still gets extracted; the markup wrapper does nothing in Google | [G] [X] |
| Keyword density and chasing content scores | Keyword stuffing lost ground on the GEO paper's main visibility measure (about −8%), and a 2026 survey of the replications grades it null or negative. Surfer's own study: content score to rank correlation of 0.28. No controlled test of score-driven edits exists. Use coverage tools as checklists | [P] [X] [V] |
| Generic "GEO rewrites" at scale | Significant in only 3 of 54 method and domain combinations in C-SEO Bench; another 2026 benchmark found rewritten pages lost about 9% at retrieval and 16% at reranking; gains shrink as everyone adopts them | [X] |
| A page per fan-out query | Google names it scaled content abuse (§3) | [G] [X] |
| Author markup as a ranking tactic | Google's Danny Sullivan: bylines "aren't something you do for Google". No positive test in years of it being standard advice. Write author bios for readers (§4) | [G] [X] |
| Tracking AI rank with single prompts | SparkToro and Gumshoe (600 volunteers, 2,961 runs): less than a 1 in 100 chance two runs of the same prompt return the same list of brands. Aggregate rates across many prompts are the defensible measure (§16) | [S] [X] |
| Buying Reddit or forum mentions | Planting text works in a lab: a Cornell team got a 13-word planted passage cited in 38% to 51% of deep-research agent reports in a sandbox. In the wild, a thread's search rank rather than its karma predicts citation, Reddit says it catches about 25,000 spammy posts and comments a day, and bought placements disappear with the accounts | [S] [M] |
| Chasing domain authority | For AI Overview visibility, the number of backlinks (0.218) correlated far more weakly than plain brand mentions (0.664) across 75,000 brands (§6) | [S] |
| Length for its own sake | Extraction levels off around 540 words per page; pages over 3,000 words get about 13% used. Covering sub-questions (§3) is what "comprehensive" should mean | [M] |
| Speakable schema for AI search | Google still documents it, as a beta, for one narrow use: Google Assistant reading news aloud on Google Home devices set to US English. No AI answer engine, AI Overviews and AI Mode included, documents reading it | [G] |
| Serving different content to AI bots ("AI shadow sites", "edge AI delivery") | Cloaking. Since 15 May 2026 Google has stated that its spam policies also apply to generative AI responses in Search | [G] do not |

On llms.txt: ship one only if you want a Markdown map of your docs for developer tools. Do not ship
it expecting ranking or citation gains, and treat any audit that leads with llms.txt as a warning
sign; an "AI visibility audit" built on llms.txt plus schema plus a proprietary score is a familiar
sales pattern. Serving Markdown versions of pages is a separate question: some developer tools do
ask for them (Cloudflare reports Claude Code and OpenCode send `Accept: text/markdown`, and server
logs show Cursor and Copilot doing the same), while ChatGPT, Claude.ai, Gemini and Perplexity do
not. If you negotiate, do it at the edge: Cloudflare "does not consider vary values in caching
decisions" by default, so origin-side negotiation behind a cached HTML route can serve Markdown to
browsers. Cloudflare's own Markdown for Agents converts at the edge and sets `Vary: Accept` itself,
but see §14 for the content signal it adds [G].

For reviewing a draft before it ships (sources, freshness, machine-sounding prose), use the
[content-review skill](https://github.com/rankxai/seo-geo-skills/blob/main/skills/content-review/SKILL.md).
