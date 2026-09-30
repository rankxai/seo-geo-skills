# AI shopping and product pages

Section 17. How ChatGPT and Google's AI Mode choose products, what a shop can actually control, and
the checkout protocols, as of September 2026.

**Read this when** the site sells products and someone asks how to show up when people shop through
an AI assistant.

## Contents

- **17a.** Feeds beat crawling for products
- **17b.** What each platform says it uses
- **17c.** Checkout and feed protocols
- **17d.** The product page itself
- **17e.** What is not known

---

## 17a. Feeds beat crawling for products

For products, the assistants lean on structured product data far more than on what they can read
from your pages. Price, availability, variants and identifiers change too often to crawl, so both
major platforms describe feeds and third-party product data as the source. A product page still
matters (it is what a shopper lands on and what gets quoted), but the fastest lever for AI shopping
is usually the quality and freshness of your product data.

Keep one version of the truth: the price and availability in your feed, your structured data and
your visible page must match. A mismatch is a common product-data defect, and Google's structured
data guidelines require markup to describe content that is actually visible on the page [G].

## 17b. What each platform says it uses

ChatGPT. OpenAI's shopping help page (updated August 2026) says product results "are selected
independently by ChatGPT and are not ads", and that when choosing products ChatGPT considers
"structured metadata from first-party and third-party providers (e.g., price, product description)
and other third-party content". Merchants are ranked on "availability, price, quality, and whether
they are the maker or primary seller". Two routes in [G]:

- Shopify stores are already included through Shopify Catalog: "No additional work is required
  from individual merchants."
- Everyone else can apply to send a direct product feed to OpenAI, following its product
  feed specification.

ChatGPT also rewrites product titles and descriptions and generates review summaries from public
reviews, so what shoppers see may not be your wording. The ads that now appear in ChatGPT, in more
than 40 markets by September 2026 and able to use product feeds since 31 August, are separate from
product results [G].

Google AI Mode. Google says AI Mode shopping "brings together Gemini capabilities with our
Shopping Graph", which it described in May 2025 as "more than 50 billion product listings", with
"more than 2 billion" refreshed every hour [G]. The practical route in is Google Merchant Center
(free listings and product feeds) plus merchant listing structured data on product pages.

## 17c. Checkout and feed protocols

Two protocols connect a merchant's catalogue and checkout to an assistant:

- Universal Commerce Protocol (UCP), an open standard Google launched in January 2026, co-developed
  with Shopify, Etsy, Wayfair, Target and Walmart. A business publishes a machine-readable profile at `/.well-known/ucp` describing
  what it supports. Google's Merchant Center help says UCP checkout in AI Mode and Gemini "is
  available for select merchants at this time", applies to products eligible in the United States,
  Canada and Australia, and shows a Buy button only for listings using the `native_commerce`
  checkout attribute. It runs off your Merchant Center data [G].
- Agentic Commerce Protocol (ACP), from OpenAI and Stripe. It launched in 2025 for Instant Checkout
  inside ChatGPT. On 24 March 2026 OpenAI said that version "did not offer the level of flexibility
  that we aspire to provide", let merchants use their own checkout, and extended ACP to product
  discovery through merchant feeds. Its merchants page now says OpenAI is "moving away from a
  standalone Instant Checkout experience". For most merchants ACP is therefore the feed route; the
  shopping help page still mentions an Instant Checkout option "for some eligible products and
  merchants", so it has been scaled back, not switched off [G].

Neither checkout integration is something a small shop needs to build first. Clean, current feeds
come first; checkout matters once you are being shown.

## 17d. The product page itself

- Answer first, in the visible text. Name, what it is for, key specifications, price, availability,
  delivery and returns, in plain server-rendered HTML (§1, §2). Assistants read text, not markup,
  and a price that exists only in structured data is often missed (§13).
- Identifiers. Use GTINs (or MPN and brand) consistently across the feed, the markup and the
  page. They are how the same product is matched across merchants.
- Variants. Use Google's product variant structured data (`ProductGroup` with `hasVariant`)
  rather than one page per colour with near-duplicate text [G].
- Reviews. Only real, disclosed reviews. Google's review snippet rules (July 2026) exclude fake
  and undisclosed incentivised reviews [G].
- Out of stock. Keep the page live with accurate availability rather than removing it, unless the
  product is gone for good, in which case redirect to the closest replacement or return 404 or 410.

## 17e. What is not known

- Neither OpenAI nor Google publishes how much a feed, a review score or a page's content weighs in
  product selection. Treat any vendor "ranking factor" list for AI shopping as a vendor claim [V].
- Claims such as "most ChatGPT shopping results come from Google Shopping" come from vendor studies,
  not from OpenAI. Grade them [V] and re-check them before repeating them.
- There is no platform report of product citations yet. Measure with a prompt panel of real
  shopping questions (§16) and your own referral and order data.
