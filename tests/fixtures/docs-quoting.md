---
name: example
description: A short description with no problems.
---

# Style guide

Write plainly. The banned list is below and is quoted on purpose.

<!-- prose-check: off -->
- "In today's fast-paced world"
- "It's worth noting that"
- delve, leverage, seamless
- The claim that no AI crawler renders JavaScript is wrong.
<!-- prose-check: on -->

Code is never scored:

```bash
echo "it's worth noting" | grep delve
```

Inline code like `leverage` is not scored either.
