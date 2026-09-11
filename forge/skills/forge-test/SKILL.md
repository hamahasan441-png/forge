---
name: forge-test
description: "Add or fix tests for the files you just changed"
---
# forge-test

- Prefer the existing runner (package.json / Cargo.toml / go.mod / pytest.ini).
- Cover the failure first, then the fix.
- Do not invent `npm test --` flags the repo does not use.
