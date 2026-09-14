---
name: data-migration
description: "Migrate data and schemas safely: reversible steps, dual-write, verified counts, tested rollback"
---
# data-migration

Data outlives code. A migration that cannot be undone is an outage waiting
for its moment. Every step must be: reversible, observable, and verifiable.

## Before touching data

1. **Inventory** — what exists, how much, where, and who reads it. Include
   counts and a checksum per table/collection/file.
2. **Backup** — a real, restorable backup, and a TESTED restore (an untested
   backup is a hope, not a backup). Record the restore procedure.
3. **Dry run** — the migration must have a mode that reports what it WOULD
   change and touches nothing. Run it on production-scale data first.

## The migration itself

4. **Expand** — add new schema/fields ALONGSIDE the old. Never mutate in
   place. Old readers keep working on old fields.
5. **Dual-write** — write both shapes during the transition (old first —
   old readers must never see the new-only state). Backfill in batches with
   progress checkpoints; a batch size that would lock the table is too big.
6. **Verify continuously** — counts old vs new, checksums on samples, a
   reconciliation report. Mismatch = stop, do not "fix while running".
7. **Switch reads** — flip consumers to the new shape behind a flag, one at
   a time, with the old path still live as instant rollback.
8. **Contract** — only after N days of clean reconciliation, remove the old
   shape — in a SEPARATE, later release, never the same one that switched
   the reads.

## Hard rules

- Every migration script has a tested DOWN path (or a documented, timed
  restore-from-backup procedure) before the UP path runs.
- Never migrate and deploy new code in the same step — one variable at a
  time, or the failure has two suspects.
- Batch everything: bounded memory, bounded locks, resumable progress
  (a crash mid-migration must resume, not restart).
- Log per-batch decisions: rows read, rows changed, rows skipped + why.
