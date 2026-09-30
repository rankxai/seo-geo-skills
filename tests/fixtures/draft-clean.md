---
title: How robots.txt group selection works
---

# How robots.txt group selection works

A crawler reads robots.txt, finds the groups that name its product token, and obeys only those.
If no group names it, the star group applies. RFC 9309 defines both rules.

## Why exact matching matters

A group written for "Google" does not apply to Google-Extended. In one sample of 120 files, 14%
used a prefix that matched nothing ([sample notes](https://example.com/notes/robots-sample)).

The same sample found 3x more star groups than named groups.

## Sources

- Robots sample, 120 files, 3x ratio: https://example.com/notes/robots-sample
