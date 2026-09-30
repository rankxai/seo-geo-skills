# Media, performance, crawler control and accessibility

Sections 11, 12, 14 and 15. How the page is delivered, who is allowed to fetch it and for what
purpose, and why accessibility is now also agent-readiness.

**Read this when** you are working on images, Core Web Vitals, robots.txt, CDN bot settings or
interactive controls.

## Contents

- **11.** Images and media
- **12.** Performance: Core Web Vitals, honestly weighted
- **14.** Crawler control by purpose: training, search and user fetches, robots.txt rules, the
  Google controls, and CDN bot policy
- **15.** Accessibility, which is now also agent-readiness

---

## 11. Images and media

- `alt` on every meaningful image, describing content and purpose. `alt=""` for decorative images
  is correct, not lazy. Do not stuff keywords.
- Always set `width` and `height` (or `aspect-ratio`). Missing dimensions are the top cause of
  layout shift.
- AVIF or WebP, compressed hard, with `srcset` and `sizes` so each screen gets roughly its own pixel
  density rather than every screen getting the retina file.
- Never lazy-load the main above-the-fold image. Put it in the HTML as a real `<img>` with
  `fetchpriority="high"`, on one image or two at most, since raising more than that makes the hint
  useless (web.dev). Preload it only when the HTML cannot reference it directly, such as a CSS
  background, and then preload with `fetchpriority="high"`. Lazy-load everything below the fold.
- Descriptive file names.
- On video: YouTube mentions correlate strongly with brand visibility in AI answers [S]. Do not
  read that as "make videos": the lesson is the format. Specific, name-dense, first-hand accounts
  get extracted, and you can do that in writing. Make video when the topic suits video.

## 12. Performance

Core Web Vitals are judged at the 75th percentile of real users over 28 days (Chrome UX Report),
not by a lab run. The thresholds are unchanged as of September 2026:

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| LCP | 2.5 s or less | 2.5 to 4.0 s | over 4.0 s |
| INP | 200 ms or less | 200 to 500 ms | over 500 ms |
| CLS | 0.1 or less | 0.1 to 0.25 | over 0.25 |

The weighting, from Google's repeated statements and every large study since 2021: fixing "poor"
pages can matter when competition is close; polishing "good" to "perfect" measures as close to
nothing for rankings [G] [S]. Google documents no fallback for pages without enough field data, and
the common assumption that they simply get no Core Web Vitals signal is inference, not a statement
[S]. Claims like "fast first paint triples AI citations" are vendor correlations:
very fast pages are a fingerprint of large sites on big CDNs, not a lever. The crawlers that feed
ChatGPT, Claude and Perplexity fetch HTML and do not render, so for them the only speed rule is
"do not be slow enough to time out" [V] [X].

Speed still pays where it is real: people convert better on fast pages, and JavaScript you do not
ship cannot hurt INP.

- Ship less JavaScript. Most INP problems are main-thread contention from code that did not need
  to run in the browser.
- Self-host fonts as `woff2`, and preload the one used above the fold.
- Reserve space for anything that loads late.
- Audit third-party scripts, ad and consent libraries for history manipulation that traps the Back
  button. Google announced back-button hijacking as spam on 13 April 2026 and has enforced it as a
  malicious practice since 15 June 2026 [G].
- Enforce a JavaScript budget in CI, measured as what your app adds over the framework's own
  baseline. An absolute number is often unreachable and ends up switched off.

## 14. Crawler control by purpose

Most AI vendors now run separate crawlers for training, for search and for fetches a user asked
for. Blocking the wrong one costs you visibility for nothing [G]:

| Purpose | OpenAI | Anthropic | Perplexity | Google | Microsoft | Apple |
|---|---|---|---|---|---|---|
| Training | GPTBot | ClaudeBot | none | Google-Extended (token) | none separate | Applebot-Extended (token) |
| Search and answers | OAI-SearchBot | Claude-SearchBot | PerplexityBot | Googlebot | Bingbot | Applebot |
| User-triggered fetch | ChatGPT-User | Claude-User | Perplexity-User | Google-Agent, Google-GeminiNotebook | none documented | none documented |

A token is a robots.txt name that no crawler fetches under. Microsoft and Apple control AI answers
with meta tags rather than a separate crawler: Bing keeps a page out of Copilot answers with
`noarchive` and limits it to title, URL and snippet with `nocache`, and Apple says `nosnippet` keeps
a page out of its AI-generated answers, while `isAccessibleForFree: false` keeps it in search but
out of AI context [G].

The full list, 28 named tokens across Meta, Amazon, Mistral, DuckDuckGo, Common Crawl, ByteDance
and the vendors above, is in [../data/crawlers.json](../data/crawlers.json), each row linked to the
vendor's own page and re-read on 29 September 2026. `check-crawlers.mjs` reads it.

- Blocking GPTBot does not remove you from ChatGPT search. Blocking OAI-SearchBot does. The same
  split applies at Anthropic. Decide per purpose: many sites block training crawlers and stay
  visible in AI search [G]. OpenAI adds a wrinkle: a page OAI-SearchBot may not crawl can still
  appear in ChatGPT as a navigational link, unless it carries `noindex`.
- Most user-triggered fetchers ignore robots.txt. A person asked, so the fetch happens.
  OpenAI, Perplexity and Google all say so in their own words. Anthropic is the exception: it says
  Claude-User obeys robots.txt. Either way, robots.txt is not access control [G].

### How robots.txt is actually read (RFC 9309)

- A crawler obeys the group that names it, and falls back to `User-agent: *` only when no group
  does. A named group replaces the `*` group; it does not add to it. So a `Disallow` or any other
  line written only under `*` never reaches a crawler that has its own group. If you add named
  groups for AI crawlers, repeat every shared rule in each one [G].
- Matching is by exact product token, case-insensitive. A group for `Google` does not apply to
  `Google-Extended`.
- Some crawlers fall back to another crawler's rules. Applebot follows Googlebot's rules when
  it is not named, and Amazon documents a similar fallback for Amzn-SearchBot. A blanket rule for
  Googlebot therefore reaches Apple too.
- The status code of robots.txt matters (RFC 9309 sections 2.3.1.3 and 2.3.1.4). On a 4xx a
  crawler "MAY access any resources". On a 5xx the RFC says to assume everything is disallowed, and
  crawlers differ after that: Google stops crawling for 12 hours, then uses its last good copy for
  up to 30 days, and treats `429` like a 5xx; Amazon treats a robots.txt it cannot fetch as absent.
  So an error page on `/robots.txt` can pause crawling site-wide, or silently drop your rules,
  depending on the crawler. Serve it as a static file with a 200 [G].
- `robots.txt` stops crawling, not indexing. To keep a page out of results use `noindex`, and do
  not also block that page in robots.txt, or the crawler never sees the `noindex`.

### Google's controls, as of September 2026

- Google-Extended governs training and grounding, never inclusion. It decides whether Google may
  use your content to train Gemini models, including "the models used to generate responses in
  Search generative AI features" (Search Console Help), and for grounding in Gemini apps and in
  Vertex AI's Grounding with Google Search. Google states it does not affect inclusion or ranking in
  Search. Blocking it does not take you out of AI Overviews [G].
- Two controls do. Search Console's "Search generative AI" setting (under Settings) removes a site
  or property from AI Overviews, AI Mode and Discover's AI features and leaves ordinary results
  untouched. It reached every site on 31 August 2026, defaults to Include, works per
  property, and Google says it "isn't used as a ranking or inclusion signal affecting other parts
  of Search". Per page, `nosnippet`, `max-snippet` and `noindex` still limit what AI Overviews and
  AI Mode may use, and each also changes the ordinary result [G].
- Because inclusion in that setting is now an eligibility requirement for AI features, check it is
  set to include if you want to appear.

### Your CDN may be deciding for you

Cloudflare's AI Crawl Control groups AI traffic into Search, Agent and Training [G].

- For domains added from 15 September 2026, Cloudflare offers two starting presets: a site
  without ads blocks nothing, and a site with ads sets Training to "Disallow AI Training" and
  Agent to "block on pages with ads".
- From the same date, Cloudflare classifies a crawler by every purpose it has. Choosing Block, or
  "Block on pages with ads", for Training "now appl[ies] to mixed-use crawlers, including Applebot,
  Bingbot, and Googlebot",
  so it turns Google away (Cloudflare blog, "accountable mixed-use AI crawlers", 15 September
  2026; Cloudflare's older "block AI bots" page, last updated in July, predates this).
- The same day Cloudflare added "Disallow AI Training", which refuses training through robots.txt
  and keeps those crawlers fetching for search, and it moved existing training blocks, including
  the 2025 one-click "Block AI bots" setting, to that option. Domains that had the one-click setting
  also got Agent set to "Block on pages with ads", so agent fetches of their ad-carrying pages are
  now refused. A site that clicked the old setting keeps Googlebot; a Block chosen from 15 September
  onwards does not.
- The old one-click setting never blocked AI *search* crawlers either: it "excludes mixed-purpose
  bots that are used both for Training and for Search". Cloudflare says Bing will only start
  receiving the no-training preference in early 2027.

Whatever your CDN says it does, check the search-purpose crawlers actually get 200 responses,
in your logs or with `check-crawlers.mjs --live`, which fetches your page as each crawler and
compares the answer with a normal browser. A CDN block does not show up in any robots.txt tester.

### Saying what a crawl may be used for

- Content Signals (Cloudflare, September 2025, added then to over 3.8 million domains) extend
  robots.txt with three signals, each `yes`, `no` or unset: `search` (build a search index and show
  links and short excerpts, explicitly not AI summaries), `ai-input` (use the page in a generated
  answer in real time) and `ai-train` (training or fine-tuning). The line looks like
  `Content-Signal: search=yes, ai-train=no`. No engine documents honouring it, so price it like
  llms.txt: cheap, useful for stating your licensing position, not a lever. It
  does travel in a file every crawler already reads, and it expresses use after access, which
  `Allow` and `Disallow` cannot. Remember the group rule above: put it in every group.
- Two Cloudflare details that set a position for you. On 15 September 2026 Cloudflare deprecated
  its managed robots.txt in favour of "Bot Preference Sync", which writes your Search, Training and
  Agent choices into robots.txt. And since its launch in February 2026, Markdown for Agents has
  added `Content-Signal: ai-train=yes, search=yes, ai-input=yes` to every converted page whose origin
  sets no `content-signal` header of its own, so switching it on without that header states a
  permissive position you may not hold [G].
- Expect waste. Cloudflare reported in July 2026 that over half of AI crawler requests re-fetch
  unchanged pages. Crawl-to-referral ratios swing widely: Anthropic's peaked around 70,900 to 1 in
  June 2025 and Cloudflare Radar showed about 507 to 1 in September 2026, when Perplexity's was the
  highest at about 3,200 to 1. Cache aggressively and serve crawlers cheap 200 responses [M].

### Crawl and index basics

- An XML sitemap with accurate `lastmod` (§9b).
- Real status codes. A "soft 404" that returns 200 poisons the index. Google sends pages that
  return 200 to rendering, and says this "might not be the case" for other codes, so an error page
  that builds its message with JavaScript may never be rendered at all (December 2025) [G].
- Never put `noindex` in the raw HTML and remove it with JavaScript. Google may stop at the raw
  `noindex` and never render: "If there's a possibility that you do want the page indexed, don't
  use a noindex tag in the original page code" (December 2025) [G].
- Googlebot reads only the first 2 MB of an HTML file, measured uncompressed (Google's
  Googlebot documentation, updated February 2026). Content past that is not indexed. Measure the
  served bytes including any framework data inlined in the page, which on some stacks is most of it.
  `audit-page.mjs` warns at 1 MB and fails at 2 MB.
- The Indexing API is only for `JobPosting` and `BroadcastEvent` pages. It is not a way to get
  an article or product page indexed faster. Sitemaps and Search Console's URL Inspection are.
- IndexNow tells Bing, Yandex, Seznam, Naver, Yep, Amazon and the Internet Archive about
  changed URLs in one request. Google does not use it. Submit only URLs that return 200.
- Pages generated per visitor: `noindex`, and never cached by a shared cache.

## 15. Accessibility, which is now also agent-readiness

Accessibility overlaps heavily with machine parsing, and since 2025 it has a second audience:
browser agents (ChatGPT's agent, Perplexity's Comet, Claude in Chrome) drive real browsers and
succeed or fail on the same semantics assistive technology needs. A form a screen reader cannot
operate is a form an agent cannot complete [M].

- Real `<button>`, `<form>` and `<label>` on every control. Accessible names are what an agent
  targets. Errors with `role="alert"` and `aria-describedby`.
- Visible focus states. Never `outline: none` without a replacement.
- Contrast of 4.5:1 for body text, 3:1 for large text and control boundaries. Measure it: light
  text on a saturated brand colour usually fails.
- Touch targets: WCAG 2.2 success criterion 2.5.8 sets 24 by 24 CSS pixels at Level AA, with a
  spacing exception. The 44 by 44 figure is 2.5.5, Level AAA. Meet 24 everywhere and aim for 44 on
  primary controls. WCAG 2.2 is still the standard to meet as of September 2026; W3C says WCAG 3 is
  "a few more years" away and that meeting 2.2 now is the best preparation.
- Keyboard-operable in a logical order.
- ARIA must be valid, not just present. A role an element may not take (`role="dialog"` on an
  `<aside>`) or a name on an element that cannot be named (`aria-label` on a plain `<div>` with no
  role) is an error, not a hint. ARIA in HTML lists what each element allows. A banner that does
  not trap focus is a labelled `region`, not a `dialog`.
- Lighthouse now scores this as agent-readiness. An Agentic Browsing category appeared in
  Lighthouse 13.2 and became part of the default run in 13.3 (May 2026). It is shown as a fraction
  rather than a percentage. Its accessibility-tree audit runs 33 axe rules and scores zero on a
  single failure anywhere on the page, so one shared component (a cookie banner, a CAPTCHA wrapper)
  can fail every page on a site. The category also counts layout shift, three WebMCP audits (which
  tools a page registers, whether its forms are annotated, and whether the tool schemas are valid),
  an llms.txt audit, and, since 13.5 (September 2026), an Agentic Resource Discovery audit that
  validates an `ai-catalog.json` manifest. The llms.txt and discovery audits are "not applicable"
  when the file is absent, and the WebMCP audits need a browser with WebMCP enabled. Google labels
  the whole category experimental. Treat it as a baseline for real browser agents, not a ranking
  factor [G] [M].
- Google's own agent guidance, which its AI optimisation guide links to, is web.dev's "Build
  agent-friendly websites" (April 2026): keep interactive elements visible and larger than 8 square
  pixels, avoid invisible "ghost" elements laid over controls, and give every `<label>` a `for`
  attribute. WebMCP, which lets a page declare tools an agent can call, is "a proposed web
  standard" in a Chrome origin trial; worth watching, not yet worth building for most sites [G].
- Google-Agent, the fetcher behind Google's browsing agent, is experimenting with the Web Bot Auth
  protocol under the `https://agent.bot.goog` identity, so signed requests may become a better way to
  verify agents than user agents or IP ranges [G].
- Shops have their own agent protocols, UCP and ACP, covered in §17. Relevant to merchants only.
