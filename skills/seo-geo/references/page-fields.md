# Document structure, metadata and structured data

Sections 8, 9 and 13. Every field a page carries, what each one is for, what happens when it is
missing, and the narrow job structured data still does.

**Read this when** you are building a page template, adding a CMS field, or auditing what a page
emits.

## Contents

- **8.** Document structure (headings, landmarks, named sections)
- **9.** Per-page metadata
  - **9a.** Head elements
  - **9b.** Dates: three places, one truth
  - **9c.** Authorship
  - **9d.** Schema by page type
  - **9e.** The field checklist, as CMS requirements
- **13.** Structured data: infrastructure, not a citation lever

---

## 8. Document structure

- Exactly one `<h1>`, saying what the page is about.
- Never skip heading levels. The outline is how assistive technology and extraction systems
  read hierarchy, and headings visibly shape where passages are cut (§3) [M].
- Headings are content, not styling. Never mark up an eyebrow or label as a heading to get a
  font size. Use a `<p>` with a class. It corrupts the outline.
- Real landmarks: `<header>`, `<nav>`, `<main>`, `<footer>`, `<article>`, `<aside>`.
- Name every `<section>` with `aria-labelledby` pointing at its heading's id. An unnamed
  section is invisible in a landmark list and tells a parser nothing.
- One `<main>`, with a skip link as the first focusable element.

`audit-page.mjs` checks the single `<h1>`, skipped levels, `lang` and `<main>`.

## 9. Per-page metadata

The complete set of fields every page carries. Make these CMS fields with validation, not
conventions; a convention lasts until the first person in a hurry.

### 9a. Head elements

| Element | Rule | Evidence |
|---|---|---|
| `<title>` | Unique, most distinctive words first, echoing the H1. Google sets no length limit and truncates by pixel width, so about 50 to 60 characters is a display guide, not a rule. Google rewrites titles it judges vague, boilerplate or out of date; the largest study (Ahrefs, 953,276 top-10 pages, 2021, still the biggest sample) found it rewrote about a third and used the `<h1>` about half the time when it did, and newer, smaller studies report higher rates. In March 2026 Google confirmed a small test of AI-written title links (trade press). A title that says plainly what the page is has the best chance of surviving, and title-to-sub-query similarity is a top ChatGPT citation correlate (§3) | [G] [S] |
| Meta description | Not a ranking factor: it is the pitch for the click, and Google often writes its own snippet. No length limit either; around 150 to 160 characters fits most desktop results. Write it for a person: by hand on key pages, generated from page-specific data (price, specification, author, date) on large catalogues, which Google says is "appropriate and ... encouraged" there. Never a keyword list, never the same text site-wide | [G] [S] |
| Canonical | Absolute, self-referencing by default, exactly one per page. If JavaScript changes it, the raw HTML and the rendered page must agree, or leave it out of the raw HTML (Google, December 2025) | [G] |
| `robots` | `index, follow` is the default, so you rarely need to say it. Add `max-snippet:-1, max-image-preview:large, max-video-preview:-1`: these are permissions, not boosts, and snippet limits also cap what Google's AI answers may quote. Never ship `noarchive` or `nocache` by accident: Google ignores both, but Bing uses `noarchive` to keep a page out of Copilot answers entirely and `nocache` to limit it to title, URL and snippet, and treats a page with both as `nocache` | [G] |
| Open Graph | `og:title`, `og:description`, `og:image` (1200 by 630), `og:url`, `og:type`, plus `twitter:card`. Since March 2026 Google also uses `og:image` alongside schema.org markup when choosing thumbnails in Search and Discover, so it is not only a social tag. Check the image URL resolves: an absolute URL on a domain that is not live yet returns 404 | [G] [M] |
| `lang` | On `<html>`, with a region where it matters (`en-GB`). It is for screen readers, browsers and translation; Google says it does not use `lang` or `hreflang` to detect a page's language, and reads the text instead | [G] |
| `hreflang` | Only if you publish several languages or regions. Every version lists all versions including itself, with fully qualified URLs, and links are reciprocal. Add `x-default` where there is a language selector or a redirecting home page. §18c has the detail | [G] |

Do not put a contact email in `twitter:data1` or any other meta field. Some plugins do this by
default, and it gets scraped.

### 9b. Dates: three places, one truth

The field set most often skipped, and the one with the clearest guidance. Google's rule is that
dates must be consistent wherever they appear, and its rule for sitemaps is all or nothing trust.

| Surface | What to emit |
|---|---|
| Visible on the page | "Add a user-visible date to the page and feature it prominently. Label your dates appropriately with text like 'Publish' or 'Last updated'." [G] |
| JSON-LD | `datePublished` and `dateModified` on a `CreativeWork` type, ISO 8601, ideally with a time zone [G] |
| Sitemap `lastmod` | The date of the last significant update to main content, structured data or links. A changed copyright year is not one. Google ignores `<priority>` and `<changefreq>` [G] |

**The trust trap.** Google uses `lastmod` only if it is "consistently and verifiably accurate".
Gary Illyes, July 2026, answering a site whose CMS stamped wrong dates: sites with unintentionally
wrong dates are "probably better off without the lastmods". A CMS that stamps `lastmod` on every
save, typo fixes included, risks getting no signal rather than a weaker one. Stamp on significant
change only [G].

Also from Google's documentation [G]: never a future date; never the date of the event the page
describes; keep other dates that could be mistaken for the byline to a minimum; get the time zone
right.

Two ways to get this wrong that look right on a laptop:

- `new Date()` at build time restamps every URL on every deploy, which is exactly the false
  freshness signal the trust rule punishes.
- Reading dates from git at build time fails in most CI builds: containers often exclude
  `.git`, and shallow CI checkouts return the same last commit for every file.

Author the dates, store them with the content, and change them only when the content changes.
`check-sitemap.mjs` warns when most URLs share one `lastmod`, which is the fingerprint of a
restamp.

Do dates rank? Google makes no ranking claim for byline dates. They are display and
crawl-scheduling mechanics. The retrieval-side argument is §7's, and it is modest.

### 9c. Authorship

Google's `Article` structured data has no required properties [G], and §4's position applies:
author markup is entity plumbing and reader credibility, not a measured ranking lever.

- `author.name` is the name only: no company name, no job title [G].
- `author.url` or `sameAs` pointing at a page that uniquely identifies the person. Google: "Google
  can understand both `sameAs` and `url` when disambiguating authors" [G]. This is the line that
  turns a string into an entity.
- A `Person` node linked from a real bio page, and the bio page itself marked as `ProfilePage` with
  the `Person` as `mainEntity`; Google says other features, `Article` authors included, can link to
  `ProfilePage` markup [G]. Never invent `sameAs` URLs: a wrong one resolves you to someone else.
- Google still "strongly encourage[s]" accurate bylines where readers expect them, for readers
  rather than for ranking (§4) [G].

### 9d. Schema by page type

One `@graph` per page, nodes referring to each other by `@id`. Site-wide: `Organization`, and
`WebSite`, which feeds the site name Google shows (its old `SearchAction` for the sitelinks search
box has done nothing since November 2024). What schema is and is not for: §13.

| Page type | Add |
|---|---|
| Article or blog post | `Article` or `BlogPosting`, `BreadcrumbList` (breadcrumbs now show on desktop results only), author `Person` |
| Product page (one specific product) | `Product`. If the page sells it, follow Google's merchant listing requirements; if not, product snippets. See §17 |
| Software or app | `SoftwareApplication`. It earns a rich result only with `offers.price` (0 if free) and a genuine `aggregateRating` or `review`; without real reviews, emit it for entity clarity and expect no stars. Never invent ratings |
| Pricing | `Offer` per tier, with prices in server-rendered visible HTML (assistants do not read the schema alone) |
| Comparison | `Article` plus a real HTML table and a visible "last checked" date |
| Glossary | `DefinedTerm` inside a `DefinedTermSet` |
| FAQ | The visible questions and answers are the value. `FAQPage` markup is optional now that the rich result is gone; emit it only if it is generated from the same source as the copy |
| Tool or calculator | `SoftwareApplication`, plus indexable explanatory text around the tool |

Markup Google no longer shows any rich result for: `HowTo` (2023); the sitelinks search box
(`SearchAction` on `WebSite`, November 2024; keep `WebSite` itself); `SpecialAnnouncement`,
estimated salary (`Occupation`) and vehicle listing (`Car`), whose documentation went in September
2025 along with course info and learning video; practice problems (`Quiz`, January 2026); and
`FAQPage` (rich result ended 7 May 2026, documentation removed 15 June 2026). Course info and
learning video reused `Course` and `VideoObject`, which other features still use, so do not flag
those types. `audit-page.mjs` warns on the rest. `ClaimReview` is being phased out of Search but
Google's Fact Check Explorer still reads it, and `Dataset` serves Dataset Search. The list shrinks
every year: check Google's Search Gallery before adding a type for its rich result [G].

### 9e. The field checklist, as CMS requirements

```
required     title          about 60 chars max, unique, echoes the H1
required     description    about 150 to 160 chars, written for a person
required     canonical      absolute, self-referencing
required     datePublished  ISO 8601 with time zone
required     dateModified   ISO 8601; changes ONLY on a significant edit
required     author         Person, with url or sameAs
required     ogImage        1200 x 630, URL checked to resolve
required     answerBlock    40 to 60 words, quotable with no context (§2)
recommended  refreshDueAt   turns "which pages are stale?" into a query (§7)
recommended  lastChecked    for comparison and pricing pages
derived      lastmod        from dateModified, significant changes only
```

## 13. Structured data: infrastructure, not a citation lever

The evidence from 2026 is clear about what schema does and does not do.

- Adding JSON-LD does not move AI citations upward. Ahrefs compared 1,885 already-cited pages
  that added schema with about 4,000 that did not, 30 days before and after: AI Mode +2.4% and
  ChatGPT +2.2%,
  both within noise, and AI Overviews −4.6%, which was statistically significant, though small
  in absolute terms. This is [S], not [E]: Ahrefs *found* pages that had added schema rather than
  adding it, and says it "can't fully separate schema from these kinds of co-occurrences". That
  caveat is itself a strong argument for no benefit, since a natural experiment cannot credit the
  decline to schema either.
- Answer-time fetchers treat it as text at best. In searchVIU's test, a price that existed
  *only* in JSON-LD was extracted by none of ChatGPT, Claude, Gemini, Perplexity or AI Mode. In
  Mark Williams-Cook's test (June 2026), an address that existed only inside deliberately invalid
  JSON-LD was returned by ChatGPT and Perplexity: they read the script block as plain text rather
  than as validated schema. Either way, schema is not a special channel into the answer. Training
  pipelines such as FineWeb (via trafilatura) strip `<script>` tags before anything is embedded
  [M].
- Google says no special structured data is needed for AI features [G], and here the controlled
  evidence agrees with Google. The popular correlation ("cited pages are three times more likely to
  carry JSON-LD") is the standard example of site-quality confounding.

What schema is still for, and cheap to keep:

- Google rich results and knowledge-graph plumbing, for the types that still have a rich result.
  That list has shrunk every year since 2024, so check the Search Gallery before promising one.
- Bing and Copilot. Microsoft's Fabrice Canel has been reported (via a conference attendee,
  not a published quote) as saying schema helps Bing's language models understand content, the
  closest thing to a first-party statement from an AI platform [G].
- Entity disambiguation through `Organization` and `Person` with `sameAs` (§4).
- Agent-facing endpoints. Microsoft's NLWeb turns existing schema.org and RSS data into a
  conversational endpoint: markup as machine-readable inventory rather than a ranking token.
- There is no AI-specific schema type; schema.org v30.1 (September 2026) added none. Anyone
  selling "AI schema" is selling a myth [G].

Rules that follow:

- Emit JSON-LD from the same fields that render the visible copy. Schema that describes content
  you do not show is a manual-action risk, and schema that *replaces* visible content is invisible
  to every assistant.
- Any fact that must be quotable (a price, a date, a specification) lives in visible text first.
  The markup mirrors it, never replaces it.
- Type it (for example with `schema-dts`) so a wrong shape fails at build time.
- Never mark up invisible content. Never publish a price you have not committed to.
