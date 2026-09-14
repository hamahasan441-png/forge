---
name: api-design
description: "Design API contracts that survive contact with users: consistent, versioned, hard to misuse"
---
# api-design

An API is a promise. Every public surface you ship is a contract someone
else's code will depend on — design for the day after release, not the demo.

## Contract design

1. **Name consistently** — one verb vocabulary across the whole surface
   (get/list/create/update/delete, never a mix of fetch/query/retrieve).
   Same noun = same shape everywhere.
2. **Make errors first-class** — every failure path returns a structured,
   documented error with a stable code, a human message, and a machine-
   readable cause. Errors are API surface; a bare string is a contract hole.
3. **Design the unhappy path first** — invalid input, missing resource,
   partial failure, timeout, retry. An API is judged by what it does when
   things go wrong.
4. **Version from day one** — a version field or path segment, and a written
   policy for what counts as breaking (adding a REQUIRED field is breaking;
   adding an optional one is not).
5. **Idempotency where it matters** — anything that creates or charges must
   survive a retry with a client-supplied idempotency key or natural
   idempotent semantics.

## Review checklist

- Can a caller use this wrong by accident? Redesign until the wrong call is
  a compile/parse error or an explicit documented error, never silent
  success.
- Does every field have: a type, a nullability story, and a documented
  meaning? Undocumented = unspecified = will be misused.
- Is pagination, filtering and ordering on list endpoints CONSISTENT with
  every other list endpoint?
- Backward compatibility: run the old client against the new surface before
  shipping. Deprecate loudly (header/log/response field), remove never-rudely.

## Anti-patterns

- Boolean parameters that grow into three booleans (use a typed mode).
- Different shapes for the same entity in different endpoints.
- Errors that only the author can reproduce ("something went wrong").
- "Internal" fields in public responses — they become load-bearing within a
  week, and unremovable within a month.
