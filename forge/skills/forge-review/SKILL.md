---
name: forge-review
description: "Review a diff: correctness, security, blast radius, tests"
---
# forge-review

1. List the changed files. Skip generated and vendor dirs.
2. Check secrets, assumption-as-requirement, blast radius, missing tests.
3. Findings warn. Blockers become required actions. Do not rewrite the patch unless asked.
