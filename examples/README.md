# Example reports

Real output from the scripts, run on 29 September 2026. Sites change, so rerun them to see today's
results.

| File | Command |
|---|---|
| `check-crawlers-rankxai-live.txt` | `check-crawlers.mjs https://rankxai.com --live` |
| `check-sitemap-rankxai-sample25.txt` | `check-sitemap.mjs https://rankxai.com --sample 25` |
| `audit-page-rankxai-home.txt` | `audit-page.mjs https://rankxai.com/` |
| `audit-page-bbc-news.txt` | `audit-page.mjs https://www.bbc.co.uk/news` |

The BBC report is here because it shows what a large, well-run site still turns up: a page over
half of Googlebot's 2 MB limit, a skipped heading level, a lazy-loaded first image, and an
`X-Robots-Tag` that keeps the page out of Microsoft Copilot answers. None of them
is a crisis.
