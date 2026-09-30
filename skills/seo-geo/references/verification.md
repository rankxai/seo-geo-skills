# Verification, priorities and sources

The checks you can run, where to spend the next hour per page type, what can honestly be promised
about measurement, and the sources behind every claim in this skill.

**Read this when** you are auditing a live page, or about to quote a number from this skill to
anyone.

## Contents

- The scripts
- Copy-paste `curl` checks, for when you cannot run Node
- Priorities by page type
- Measurement
- Sources, ordered by strength of evidence

---

## The scripts

All plain Node 18 or later with no dependencies (tested on 18, 22 and 24). Every one accepts
`--json` and `--help`.

| Script | What it checks |
|---|---|
| `scripts/audit-page.mjs <url or file>` | Visible text in the raw HTML, one `<h1>`, heading levels, `lang`, `<main>`, title and description, canonical (self and absolute, including one in the `Link` header), a `<head>` closed early, meta refresh, robots meta and `X-Robots-Tag` scoped per crawler, Bing's `noarchive` and `nocache`, Open Graph image, alt text and image dimensions, lazy-loaded hero image, JSON-LD parsing and types (including retired ones), placeholders in schema, the 2 MB limit, invisible characters, how the page opens, and known myths in the copy |
| `scripts/check-crawlers.mjs <site> [--live]` | robots.txt read the way RFC 9309 says, for every AI crawler in `data/crawlers.json`, grouped by purpose, including the Applebot fallback and 4xx/5xx semantics. With `--live`, fetches the page as each crawler and compares it with a browser to find CDN blocks. Also checks `llms.txt` without treating its absence as a fault |
| `scripts/check-sitemap.mjs <site>` | Every URL in every sitemap: 200, no redirect, no `noindex` in meta or header, canonical equals the URL. Flags future `lastmod` dates and a single `lastmod` shared by most URLs |
| `scripts/crawl-site.mjs <site> [--max N]` | A polite, capped crawl from the home page and the sitemap: broken internal links and missing `#fragment` targets, redirects and chains, pages linked but not in the sitemap and sitemap URLs nothing links to, duplicate titles and descriptions, `noindex` pages that are linked, click depth |
| `scripts/analyze-gsc.mjs <folder or csv>` | Search Console Performance exports, offline: totals and date range, striking-distance queries, pages with impressions and no clicks, low click-through judged against the export's own position curve, and cannibalisation when the export pairs queries with pages |
| `scripts/check-logs.mjs <log> [--verify]` | Common, combined and JSON-lines access logs: which crawlers visited, by purpose, with status mix, re-fetch share and robots.txt fetches. With `--verify`, checks each hit against the vendor's published IP ranges |

Exit codes: 0 clean, 1 errors found, 2 usage error, 3 could not check. Anything the script could not
check is reported as "not checked".

## Copy-paste checks

```bash
URL=https://example.com/page
SITE=https://example.com

# 1. Is the content actually in the HTML? (the check that matters most)
curl -s "$URL" | grep -q "a distinctive sentence from the page" && echo OK || echo "NOT IN THE RAW HTML"

# 2. Exactly one h1, and the heading outline
curl -s "$URL" | grep -oE '<h[1-6][^>]*>' | sed -E 's/<(h[1-6]).*/\1/' | uniq -c

# 3. Title, description, canonical
curl -s "$URL" | grep -oE '<title>[^<]*</title>|<meta name="description"[^>]*>|rel="canonical" href="[^"]*"'

# 4. Images missing alt
curl -s "$URL" | grep -oE '<img [^>]*>' | grep -v 'alt=' || echo "all images have alt"

# 5. Structured data types (then confirm every marked-up fact is also in visible text)
curl -s "$URL" | grep -oE '"@type":"[^"]*"' | sort | uniq -c

# 6. Status and redirect chain
curl -sIL -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}\n' "$URL"

# 7. AI crawler rules in robots.txt: are the SEARCH crawlers allowed? (§14)
curl -s "$SITE/robots.txt" | grep -iE 'Googlebot|Bingbot|GPTBot|OAI-SearchBot|OAI-AdsBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|Google-Extended|Applebot|Applebot-Extended|Amzn-SearchBot|meta-webindexer' \
  || echo "no AI crawler rules"

# 8. Do you say what a crawl may be USED for? (Content Signals, §14)
curl -s "$SITE/robots.txt" | grep -i 'Content-Signal' || echo "no content signals declared"

# 9. Robots meta: are the max-* permissions present, and no stray noarchive? (§9a)
curl -s "$URL" | grep -oE '<meta name="(robots|bingbot)"[^>]*>'
curl -s "$URL" | grep -qiE 'noarchive|nocache' && echo "noarchive or nocache found: noarchive keeps the page out of Copilot answers, nocache limits it to title, URL and snippet" || echo "no noarchive or nocache"

# 10. Do the dates agree? Schema dates and sitemap lastmod (§9b)
curl -s "$URL" | grep -oE '"date(Published|Modified)":"[^"]*"'
curl -s "$SITE/sitemap.xml" | grep -A1 -F "$URL" | grep -oE '<lastmod>[^<]*'

# 11. Is a staging or preview host leaking into the index?
curl -sI "$URL" | grep -i 'x-robots-tag' || echo "no X-Robots-Tag: correct only on the real host"

# 12. Does the Open Graph image resolve?
curl -s "$URL" | grep -oE 'og:image" content="[^"]*"' | sed 's/.*content="//;s/"//' \
  | xargs -r curl -sIo /dev/null -w 'og:image %{http_code}\n'

# 13. Is the page under Googlebot's 2 MB limit, uncompressed?
curl -s "$URL" | wc -c

# 14. Do search crawlers actually reach the origin? Compare a browser and a crawler user agent.
# A user-agent test only shows rules keyed on the user agent. Most CDNs verify real crawlers by IP,
# so a pass here does not prove the real crawler gets in: check your logs as well.
curl -s -o /dev/null -w 'browser %{http_code}\n' -A 'Mozilla/5.0' "$URL"
curl -s -o /dev/null -w 'OAI-SearchBot %{http_code}\n' -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot' "$URL"
```

Core Web Vitals: use field data (Chrome UX Report, Search Console), never a lab score alone.

## Priorities by page type

Everything applies everywhere, but where the next hour goes differs. This is judgement, not
measurement: a starting point.

| Page type | Spend the effort on | Watch out for |
|---|---|---|
| Article or blog post | Answer first, first-hand data, sub-question coverage, internal links to the pillar | Prose any model could have written |
| Product or feature | A clear entity, real specifics instead of adjectives, capabilities stated in prose, LCP | Marketing copy with nothing extractable |
| Pricing | Real numbers in visible server-rendered HTML, `Offer` schema mirroring them, a plain tier comparison | Prices rendered client-side or only in schema: invisible to every assistant, on the most asked question about any product |
| Comparison or "vs" | Honest treatment of where the competitor wins, tables, a visible "last checked" date | Claiming you win everything: not credible, and not cited |
| Free tool or calculator | Server-rendered explanation around the widget | A tool with no surrounding text: nothing to cite |
| Glossary or definition | A 40 to 60 word definition first, dense internal links (`DefinedTerm` markup is optional; Google shows no rich result for it) | Rewriting stable content for a freshness signal that does not apply |
| Home page | One clear H1, `Organization` and `WebSite` schema, fast LCP, links out to depth | Trying to rank the home page for everything |

## Measurement

The full method is §16 in [measurement.md](measurement.md): the first-party reports, why single
prompts measure noise, and how to build a prompt panel with error bars. Before you promise anyone a
number:

- Single-prompt checks are noise, measured: less than a 1 in 100 chance that two runs return the
  same list of brands [S].
- What is defensible: rates across a panel of dozens to hundreds of prompts, run repeatedly and
  tracked over time, plus first-party numbers: server logs, Google Search Console (including the
  Generative AI report, impressions only), Bing Webmaster Tools' AI Performance report (citations
  and grounding queries), and AI referral sessions in your analytics.
- Keep referral numbers in proportion. AI referrals are a small share of traffic for most sites,
  and on one B2B site measured to convert many times better than organic; do not generalise one
  site's number. Most Google searches now end without a click to the open web.
- The influence of training data cannot be separated from real-time retrieval. Any tool claiming
  to isolate it is guessing.

## Sources, ordered by strength of evidence

Re-verify before relying on any of these. This field moves fast.

**Controlled experiments**
- [SearchPilot and Omio GEO split tests](https://www.searchpilot.com/resources/blog/lose-google-and-you-lose-ai-search): +18% AI referral traffic from brand selling-point modules (Google effect inconclusive); −6.5% organic from a "key takeaways" block
- [SearchPilot: 10 SEO A/B tests with over 10% impact](https://www.searchpilot.com/resources/blog/10-seo-ab-tests-with-an-impact-of-over-10-percent), including question-format H2s +12%
- [SearchPilot: month and year in titles](https://www.searchpilot.com/resources/case-studies/seo-split-test-lessons-adding-month-year-to-title-tags) and [what share of SEO tests win, lose or do nothing](https://www.searchpilot.com/resources/blog/losing-seo-tests)

**Peer-reviewed and academic**
- [Lost in the Middle (Liu et al., TACL 2024)](https://arxiv.org/abs/2307.03172)
- [GEO: Generative Engine Optimization (Aggarwal et al., KDD 2024)](https://arxiv.org/abs/2311.09735), read with its replications, including C-SEO Bench
- [Large Language Models Cannot Self-Correct Reasoning Yet (Huang et al., ICLR 2024)](https://arxiv.org/abs/2310.01798), the reason reviews should run in a fresh context

**Directly measured behaviour**
- [Vercel and MERJ: the rise of the AI crawler](https://vercel.com/blog/the-rise-of-the-ai-crawler) (December 2024, about 1.3 billion AI crawler fetches in a month)
- [searchVIU: what AI assistants see of schema markup](https://www.searchviu.com/en/schema-markup-and-ai-in-2025-what-chatgpt-claude-perplexity-gemini-really-see/) and [Mark Williams-Cook on invalid schema (Search Engine Journal)](https://www.searchenginejournal.com/schema-llms-the-low-bar-for-evidence-in-geo/576090/)
- [DEJAN: how big are Google's grounding chunks](https://dejan.ai/blog/how-big-are-googles-grounding-chunks/)
- [iPullRank: on chunking](https://ipullrank.com/misinformation-about-chunking)
- [Ahrefs: 97% of llms.txt files got zero requests](https://ahrefs.com/blog/llmstxt-study/)
- [Cloudflare: accountable mixed-use AI crawlers (15 September 2026)](https://blog.cloudflare.com/accountable-mixed-use-ai-crawlers/), [Content Signals Policy](https://blog.cloudflare.com/content-signals-policy/)
- The 2024 Google Content Warehouse leak: [iPullRank's analysis](https://ipullrank.com/google-algo-leak)

**Large-sample studies**
- [Ahrefs: 1,885 already-cited pages that added schema, against about 4,000 controls](https://ahrefs.com/blog/schema-ai-citations/) (a matched natural experiment over 30 days, not a controlled test)
- [Kevin Indig: where in a document ChatGPT citations come from](https://searchengineland.com/chatgpt-citations-content-study-469483)
- [Ahrefs: why ChatGPT cites pages](https://ahrefs.com/blog/why-chatgpt-cites-pages/), [brand mentions and AI visibility](https://ahrefs.com/blog/ai-overview-brand-correlation/), [AI Overview citations and the top 10](https://ahrefs.com/blog/ai-overview-citations-top-10/), [freshness of cited content](https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content)
- [Moz: AI Mode citations](https://moz.com/blog/ai-mode-citations)
- [Zyppy: 23 million internal links](https://zyppy.com/seo/seo-study/)
- [Seer Interactive: AI Overviews and click-through rate, 2026 update](https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-2026-update)
- [Pew Research Center: clicks on Google searches with AI summaries](https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/)
- [SparkToro: AI brand-recommendation consistency](https://sparktoro.com/blog/new-research-ais-are-highly-inconsistent-when-recommending-brands-or-products-marketers-should-take-care-when-tracking-ai-visibility/)
- [Profound: ChatGPT and Perplexity citation overlap](https://www.tryprofound.com/blog/citation-overlap-strategy) (vendor, July 2025 data)
- [Ahrefs: title tag study, 2021](https://ahrefs.com/blog/title-tags-study/) (old, still the largest sample)

**Official platform documentation**
- [Google: optimizing for generative AI features](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), [spam policies](https://developers.google.com/search/docs/essentials/spam-policies), [creating helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Google: site moves with URL changes](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes), [localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions), [faceted navigation](https://developers.google.com/crawling/docs/faceted-navigation), [robots.txt specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec)
- [Google: title links](https://developers.google.com/search/docs/appearance/title-link), [snippets](https://developers.google.com/search/docs/appearance/snippet), [Search Gallery of structured data](https://developers.google.com/search/docs/appearance/structured-data/search-gallery)
- [web.dev: optimize LCP](https://web.dev/articles/optimize-lcp) and [build agent-friendly websites](https://web.dev/articles/ai-agent-site-ux); [Chrome: Lighthouse agentic browsing](https://developer.chrome.com/docs/lighthouse/agentic-browsing) and [WebMCP](https://developer.chrome.com/docs/ai/webmcp)
- [Bing Webmaster Tools: AI Performance](https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c), [Bing webmaster guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a) and [NOCACHE and NOARCHIVE in AI answers](https://blogs.bing.com/webmaster/2023/9/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat/)
- [Google Search Console Help: the Search generative AI control](https://support.google.com/webmasters/answer/16908024) and [the Generative AI performance report](https://support.google.com/webmasters/answer/16984139)
- [Google: robots meta tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag), [common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers), [user-triggered fetchers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers), [Googlebot](https://developers.google.com/search/docs/crawling-indexing/googlebot)
- [Google: publication dates](https://developers.google.com/search/docs/appearance/publication-dates) and [sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: guidance on third-party SEO tools](https://developers.google.com/search/docs/fundamentals/third-party-seo)
- [Google: Search Central updates log](https://developers.google.com/search/updates)
- [OpenAI: crawlers](https://developers.openai.com/api/docs/bots), [publisher FAQ](https://help.openai.com/en/articles/12627856), [product discovery in ChatGPT](https://openai.com/index/powering-product-discovery-in-chatgpt/)
- [Anthropic: crawlers](https://support.claude.com/en/articles/8896518), [Perplexity: crawlers](https://docs.perplexity.ai/docs/resources/perplexity-crawlers), [Apple: Applebot](https://support.apple.com/en-us/119829), [Amazon: Amazonbot](https://developer.amazon.com/amazonbot)
- [Cloudflare: Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/), [Bot Preference Sync](https://blog.cloudflare.com/bot-preference-sync/)
- [Universal Commerce Protocol specification](https://ucp.dev/specification/overview/) and [Google's launch post](https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/)

**Standards**
- [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309)
- [WCAG 2.2 success criterion 2.5.8, Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and [W3C on WCAG 3's timeline](https://www.w3.org/WAI/standards-guidelines/wcag/wcag3-intro/)
- [ARIA in HTML](https://w3c.github.io/html-aria/)
- [schema.org releases](https://schema.org/docs/releases.html)

Checked 29 September 2026.
