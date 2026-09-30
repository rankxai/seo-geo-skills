# Measuring search and AI visibility honestly

Section 16. What you can measure directly, what you have to sample, and how to build an AI
visibility panel without paid tools.

**Read this when** someone asks "are we showing up in ChatGPT?", wants a baseline before a change,
or is about to quote a visibility number to anyone.

## Contents

- **16a.** First-party data you already have
- **16b.** Why single prompts measure noise
- **16c.** Building a prompt panel
- **16d.** What to report, and what not to

---

## 16a. First-party data you already have

Start here. None of it is sampled by you, all of it is free, and it beats any third-party estimate.

| Source | What it tells you | What it does not |
|---|---|---|
| Bing Webmaster Tools, AI Performance (public preview since 10 February 2026) | How often your pages are cited as sources in Microsoft Copilot, AI summaries in Bing and "select partner integrations": total citations, average cited pages per day, page-level citation counts, trends over time, and grounding queries, the phrases the AI used when it retrieved your content (a sample). Intents, Topics, Citation Share and a Compare view were added on 16 June 2026 [G] | Clicks, and anything about other engines. Microsoft says the counts do not indicate ranking or placement in an answer |
| Google Search Console, Generative AI report (every site since 31 August 2026) | Impressions from AI Overviews and AI Mode together, by page, country, date and device, with a filter for multimodal searches [G] | Clicks, queries and a split between the two surfaces, and Google documents no API for it. Clicks from AI features are folded into ordinary web search totals |
| Google Search Console, Performance | Queries and pages for web, image, video and news search, and since 24 September 2026 a multimodal search type for searches made with images (Lens, Circle to Search) [G] | AI citations |
| Analytics referrals | Visits from AI products. OpenAI says ChatGPT "automatically includes the UTM parameter `utm_source=chatgpt.com` in referral URLs" [G]. Other assistants show up as referrers (perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai) | Answers that named you without a click, which is most of them |
| Server logs | Whether search-purpose AI crawlers fetch your pages, what status codes they get, and how much of their traffic is wasted re-fetching. Verify bots by published IP ranges or reverse DNS before trusting a user agent (§14); `check-logs.mjs` does the counting [M] | Whether a fetched page was cited |

Bing's grounding queries are the closest thing any platform publishes to the sub-queries of §3.
Treat them as the seed list for your prompt panel and for the headings on the pages they point at.

## 16b. Why single prompts measure noise

- SparkToro and Gumshoe ran the same prompts 2,961 times through 600 volunteers: less than a 1 in
  100 chance that two runs return the same list of brands, and about 1 in 1,000 that they come in
  the same order [S].
- Answers change with account state, memory, location and whether web search ran. A screenshot of
  one answer is an anecdote.
- Models and products change underneath you. OpenAI said its May 2026 default model changed "when
  ChatGPT decides to search the web", and in September 2026 Anthropic's new Claude experience
  dropped the search toggle and searches when Claude judges it useful. Either can move a citation
  rate with nothing changed on your site, so every figure needs a date and a model attached.
  [../data/ai-platform-changes.json](../data/ai-platform-changes.json) logs the changes.

## 16c. Building a prompt panel

A panel is a fixed set of questions, asked the same way, repeatedly, so that changes over time are
signal rather than noise. You can run one with nothing but a spreadsheet and patience; tools only
save time.

1. Build the questions from real demand, not from what you hope to rank for. Sources, best
   first: Bing grounding queries for your site; Search Console queries rewritten as natural questions;
   questions your sales and support teams actually get; the "People also ask" boxes on your key
   queries. Aim for 50 to 200 questions.
2. Split branded from unbranded. "Is Acme Analytics good for agencies?" measures reputation.
   "What is the best analytics tool for agencies?" measures visibility. Mixing them inflates the
   share, because a question that names you almost always mentions you.
3. Fix and record the settings. Engine, model, logged in or out, web search on or off, location,
   language, date. Change one of these and you have a new panel.
4. Repeat each question. At least three runs per engine per round; more for questions that
   matter. Then report a rate ("named in 7 of 15 runs") rather than a yes or no.
5. Record four things per answer: was the brand mentioned, was the site cited as a source, was
   the brand recommended, and which domains were cited instead. Mention and
   citation are different: a page can be cited without the brand ever being named in the text.
6. Re-run on a schedule (monthly is enough for most sites) and after any major model launch,
   and keep the old rounds. The trend is the finding.

Put error bars on every rate. With n runs and k hits, the Wilson interval is cheap to compute
and honest about small samples: 7 of 15 is anywhere from about 25% to 70%. A move from 7 of 15 to 9
of 15 is not a result. The retrieved, cited, mentioned, recommended ladder is a useful way to think
about it, not a finding in itself.

## 16d. What to report, and what not to

Report:

- first-party numbers (Bing citations, Search Console impressions, AI referrals, crawler fetches),
  each with its date range;
- panel rates with their interval, split branded and unbranded, per engine;
- the domains engines cite instead of you, which tell you where to earn a presence (§6).

Do not report:

- a single "AI visibility score" out of 100. It hides the engines, the sample size and the error
  bars, and Google's own guidance warns that third-party tools "don't have access to our internal
  ranking data";
- a "rank" in an AI answer;
- any volume, position or traffic figure you did not read from data you were given. If you do not
  have the data, say so and say how to get it.
