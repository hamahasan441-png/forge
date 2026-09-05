#!/usr/bin/env node
/**
 * forge — plan persistence checks (v20.2 P1-9): slugify, save, list, read
 * (by slug and by 1-based index). Temp cwd, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { slugify, savePlan, listPlans, readPlan, plansDir } from "../forge/plans.js"

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plans-"))
let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== slugify ==")
ok("spaces and punctuation → dashes", slugify("Add retry to the fetch layer!") === "add-retry-to-the-fetch-layer")
ok("empty falls back to 'plan'", slugify("") === "plan")
ok("capped and trimmed", slugify("x".repeat(200)).length <= 50)

console.log("== savePlan / listPlans ==")
const s1 = savePlan("Add retry to fetch", "1. wrap fetch\n2. test", CWD)
ok("savePlan reports the file", s1.ok && fs.existsSync(s1.file))
ok("saved under .forge/plans", s1.file.startsWith(plansDir(CWD)))
ok("plan file carries a header + body", /# Plan: Add retry to fetch/.test(fs.readFileSync(s1.file, "utf8")) && /wrap fetch/.test(fs.readFileSync(s1.file, "utf8")))
savePlan("Second task here", "do the thing", CWD)
const plans = listPlans(CWD)
ok("listPlans returns both", plans.length === 2)
ok("newest first", plans[0].slug === "second-task-here")

console.log("== readPlan ==")
ok("read by slug", readPlan("add-retry-to-fetch", CWD).text.includes("wrap fetch"))
ok("read by 1-based index", /do the thing|wrap fetch/.test(readPlan(1, CWD).text))
ok("unknown ref errors", readPlan("nope", CWD).ok === false)

console.log("== re-saving the same task overwrites, not duplicates ==")
savePlan("Add retry to fetch", "updated steps", CWD)
ok("still two plans after re-save", listPlans(CWD).length === 2)
ok("content updated in place", readPlan("add-retry-to-fetch", CWD).text.includes("updated steps"))

console.log("== empty state ==")
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plans-empty-"))
ok("no plans → empty list", listPlans(empty).length === 0)
ok("readPlan on empty errors", readPlan(1, empty).ok === false)

try { fs.rmSync(CWD, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }) } catch {}
console.log(`\n== plans suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
