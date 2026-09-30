# Contributing

Thank you for helping. This project has one rule that matters more than the others: **every claim
needs a source, and the source decides how much weight the claim gets.**

## Reporting that something is wrong or out of date

This is the most useful contribution there is. Open an issue with the "Claim is wrong or stale"
template and include:

- the file and line
- what it says now
- what is true, with a link to the **primary** source (the study, the vendor's own documentation,
  the standard), not a news article about it
- the date you checked

If a figure has been replaced by a newer study from the same publisher, say so. That is the most
common way a claim goes stale.

## Adding or changing a rule

- Tag it with an evidence grade from the table in `skills/seo-geo/SKILL.md`: [E], [P], [M], [S],
  [G], [V] or [X]. If you cannot say which, the rule probably is not ready.
- State the data date, not only the publication date. They are often months apart.
- Correlation is not a recommendation. "Cited pages have X" needs an intervention before it
  becomes "add X".
- If you add a widely repeated false claim to `data/myths.json`, write the pattern narrowly
  enough that it never fires on correct text, and add a test with one sentence it must catch and
  one it must not.

## Code

- The scripts are plain Node 18+ with **no dependencies**. Please keep it that way. It is what lets
  them run anywhere an agent can run a command.
- Every script that reads a page accepts a local file as well as a URL, because some agent environments have no
  network.
- Run the tests with `node --test tests/*.test.mjs` and add a test for anything you change. We like tests
  that were proven by breaking the rule on purpose and watching them fail.
- Anything the script could not check must be reported as "not checked", never as a pass.

## Writing style

Plain British or American English, consistently within a file. No em dashes, no emojis. Run
`node skills/content-review/scripts/check-prose.mjs <file>` on any Markdown you change; CI runs it
too.

## Generated files

The helpers in `skills/content-review/scripts/shared/` and `skills/content-review/data/myths.json`
are generated copies, so each skill works when installed on its own. Edit the seo-geo originals and
run `node scripts/sync-shared.mjs`; CI fails if the copies drift. Run
`node tests/validate-skills.mjs` after touching a manifest, and build release zips with
`node scripts/build-release.mjs`.
