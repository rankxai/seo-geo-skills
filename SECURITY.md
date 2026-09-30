# Security

The scripts in this repository fetch URLs you give them and read files you point them at. They do
not send data anywhere else, collect no telemetry, and need no credentials.

What they send: requests identify as `seo-geo-skills/<version>` with a link to this repository.
When a site answers that user agent with a bot-protection page, `audit-page` and `check-sitemap`
retry once as an ordinary browser. `check-crawlers --live` deliberately sends each AI crawler's
documented user agent from your own IP address, so run it only against sites you are responsible
for. `check-sitemap` does not fetch sitemap URLs that sit on a different host from their sitemap.

If you find a security problem, for example a way for a crafted page, robots.txt or sitemap to make
a script read local files or run code, please report it privately through GitHub's
"Report a vulnerability" button on the Security tab of this repository rather than in a public
issue. We aim to reply within five working days.

## A note on prompt injection

Web pages, competitor copy and search results are untrusted input. Both skills tell the agent to
treat fetched content as data, never as instructions. If you find a page that gets an agent using
these skills to follow instructions hidden in it, please report that too.
