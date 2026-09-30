# Site-level work: audits, migrations, international sites and large catalogues

Section 18. The problems that live across a whole site rather than on one page, and how to approach
them without doing damage.

**Read this when** you are auditing a whole site, moving or restructuring URLs, running several
languages or countries, managing filters on a large catalogue, or generating many pages from data.

## Contents

- **18a.** Auditing a whole site
- **18b.** Migrations, redirects and pivots
- **18c.** International sites and hreflang
- **18d.** Faceted navigation and large catalogues
- **18e.** Programmatic pages without scaled content abuse
- **18f.** A first 30 days, if you are starting from nothing

---

## 18a. Auditing a whole site

Checklist audits lose to careful judgement, measurably: on an independent benchmark of SEO skills
run against a planted-defect site, most skill-equipped agents scored *below* the same agent with no
skill, because checklists produce findings that are not real and miss the ones that span the site
[M]. So:

1. Say what data you have and what you lack. A crawl, the sitemaps, Search Console exports,
   Bing Webmaster Tools exports, server logs, the source repository. An audit without Search Console
   data cannot say which pages matter, and should say so.
2. Check every finding against the live HTML before reporting it. Never recommend adding
   something that is already there (a canonical, Open Graph tags, a schema type, a robots rule).
3. Audit the live site, fix in the source. Where you have the repository, compare what it would
   deploy (titles, canonicals, sitemaps, robots.txt, redirects) with what is live, and flag anything a
   deploy would break.
4. Never state a number you did not read from data you were given. No invented search volumes,
   positions or traffic estimates. If a decision needs a number you do not have, say which export
   would provide it.
5. Notice when the business has moved. If the live product no longer matches the queries a site
   historically ranked for, that shift is the most important finding, and it changes what every
   other fix is for.
6. Rank findings by the pages and demand they affect, not by how many rules fired. One template
   defect on 5,000 URLs outranks twenty one-off warnings.

`crawl-site.mjs` crawls a capped number of pages and reports broken internal links and missing
fragment targets, pages linked but absent from the sitemap and sitemap URLs nothing links to,
duplicate titles and descriptions, redirect chains and click depth. `analyze-gsc.mjs` reads Search
Console exports offline.

## 18b. Migrations, redirects and pivots

From Google's site move documentation (updated 20 August 2026) [G]:

- Use permanent redirects (301 or 308). "Keep the redirects for as long as possible, generally at
  least 1 year"; keeping them indefinitely is better for users.
- "Avoid chaining redirects." Googlebot follows up to 10 hops, but redirect straight to the final
  destination.
- Update internal links to the new URLs straight away, submit the new sitemap, and use Search
  Console's Change of Address tool only for a move between domains or subdomains.
- "A small to medium-sized website can take a few weeks for most pages to move, and larger sites
  take longer." Expect fluctuation meanwhile.

How to plan one:

- Build the URL map from evidence: every URL with impressions in Search Console, every URL with
  external links, and every URL in the logs, not only the ones in the CMS.
- Decide per URL, with the numbers beside it: keep, redirect to the closest equivalent, merge
  into a stronger page, or retire with 404 or 410. Redirecting everything to the home page throws
  away the relevance of each old URL.
- For a pivot (the product or positioning has changed), keep the old pages that still earn
  demand the new business can serve, redirect the ones with a close equivalent, and retire the rest
  honestly rather than rewriting them into something they were never about.

## 18c. International sites and hreflang

From Google's localized versions documentation [G]:

- Google works out a page's language from its visible text. It does not use `lang` attributes or
  hreflang to detect language; hreflang only tells it which version to show to whom. So a
  translated page with the old language's navigation and boilerplate still reads as mixed.
- Every language or regional version lists all versions, including itself, using fully qualified
  URLs (`https://example.com/de/`, never `/de/`).
- Links must be reciprocal: if page A points to page B, page B must point back to A, or the
  annotation is ignored.
- Codes are an ISO 639-1 language, optionally with an ISO 3166-1 alpha-2 region (`en`, `en-GB`,
  `pt-BR`). A region on its own is invalid, and so is `en-UK`.
- Google suggests you "consider" `x-default` for the page shown when no version matches, typically a
  language selector or a home page that redirects by location.
- Declare hreflang in one place per URL set: HTML `link` elements, HTTP headers, or the sitemap.
- Each version's canonical points at itself, never at another language.
- Do not redirect by IP or browser language without a way out. Googlebot crawls mostly from the
  United States, so automatic redirection can hide every other version from it.

## 18d. Faceted navigation and large catalogues

From Google's faceted navigation documentation (updated December 2025) [G]:

- If filtered URLs do not need to be indexed, stop them being crawled: disallow the filter parameters
  in robots.txt and keep the unfiltered pages crawlable. Filters built on URL fragments (`#`) have no
  effect on crawling either way.
- If they may be indexed, keep the filter order consistent, never allow duplicate filters, and use a
  canonical pointing at the unfiltered version where a filtered page adds nothing.
- "Return an HTTP 404 status code when a filter combination doesn't return results."

Crawl budget is a real constraint only on large sites. Below tens of thousands of URLs, fix quality
and duplication first.

## 18e. Programmatic pages without scaled content abuse

Google's spam policies (updated 28 August 2026) define scaled content abuse as "when many pages are
generated for the primary purpose of manipulating search rankings and not helping users", and give
as an example "using generative AI tools or other similar tools to generate many pages without adding
value for users". The policies also cover attempts to manipulate generative AI responses in Search
[G].

Generating pages from data is legitimate when each page carries something a user needs that no other
page on your site carries. A workable test:

- Unique data per page: real prices, stock, specifications, local details, measurements. A template
  with the place name swapped is the pattern the policy describes.
- Launch in batches and watch indexation. The share of new pages Google chooses to index is the
  honest quality meter.
- `noindex`, or do not generate, combinations with no real data behind them.

Success stories for programmatic SEO are mostly vendor case studies [V]. None isolates the effect of
the pages from everything else the site changed.

## 18f. A first 30 days, if you are starting from nothing

A sensible order, not a measured one:

1. Week 1, measurement. Verify the site in Google Search Console and Bing Webmaster Tools, turn on
   Bing's AI Performance report, keep server logs, record a baseline (§16).
2. Week 2, can anything be found. Server-rendered content (§1), robots.txt and CDN crawler access
   (§14), status codes, sitemaps with honest `lastmod`, canonicals.
3. Week 3, templates. Titles, descriptions, headings, dates, structured data and internal links,
   fixed once at template level rather than page by page.
4. Week 4, demand. Pages that answer the questions your prompt panel and Search Console show people
   asking (§3, §16), and a plan for earning mentions on the sites engines cite (§6).
