---
name: forge-security
description: "Threat-model a change: secrets, injection, authz, SSRF"
---
# forge-security

Check in order: secrets in diffs, command injection, SSRF, authz skips, path traversal, project-config privilege flips.
Never recommend disabling shellguard / netguard / assumeYes.
