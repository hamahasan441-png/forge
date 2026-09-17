#!/usr/bin/env node
/**
 * forge — v123 "hardereval": the instrument could not measure the thing forge is.
 *
 * MEASURED, not asserted. The starter set was 24 tasks and every one was the
 * same shape:
 *
 *   single-file            24/24
 *   names the exact file   24/24
 *   ends in "Fix it."      23/24
 *   median seed             4 lines   (largest task in the whole set: 6)
 *
 * So `forge eval` measured ONE model call's code generation. It could not
 * exercise search (the file is always named), decomposition (one file),
 * verification strategy (nothing to run) or recovery (no failure to recover
 * from) — which is exactly the stack `--ab` toggles. A live run against
 * deepseek-v4-flash-0731 scored an identical 23 PASS / 1 LIE in BOTH arms, and
 * that is why: not mainly a ceiling, but a treatment whose entire surface the
 * instrument never touched. Every claim v109-v122 makes about learning,
 * routing and planning was therefore unfalsifiable.
 *
 * Three tasks now reach past that. What this suite pins is not that they
 * exist — it is that they have TEETH: for each one, the PARTIAL fix (the one a
 * single model call would reach for) must FAIL. A hard task whose easy answer
 * passes is a trivial task wearing a costume, and it would quietly restore the
 * ceiling it was added to break.
 *
 * test-v114 already proves every task's bug fails its own oracle and its
 * solution passes it — including these — so that is not repeated here.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v123-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { EVAL_TASKS, runVerification } = await import("../evalbench.js")

const writeAll = (dir, files) => {
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(content))
  }
}
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `forge-v123-${tag}-`))
const byId = (id) => EVAL_TASKS.find((t) => t.id === id)

/** Write `files`, then the hidden oracle, then judge. The agent's own view of
 *  the world never includes verify.mjs — that is the whole contract. */
const judge = (task, files) => {
  const d = scratch(task.id)
  writeAll(d, files)
  writeAll(d, task.hiddenFiles)
  return runVerification(d, task.verify)
}

// ---------------------------------------------------------------------------
console.log("== 1. the set can now reach past one model call ==")
{
  const multi = EVAL_TASKS.filter((t) => Object.keys(t.files).length > 1)
  ok(`the set contains multi-file tasks (${multi.length})`, multi.length >= 3,
    multi.map((t) => t.id).join(", "))

  // The property that was 24/24 before and made search impossible: the prompt
  // naming the file the fix belongs in.
  const hidesTheCause = EVAL_TASKS.filter((t) => {
    const changed = Object.keys(t.files).filter((f) => t.files[f] !== t.solution[f])
    return changed.length > 0 && changed.some((f) => !t.prompt.includes(f))
  })
  ok(`some tasks do NOT name the file the fix belongs in (${hidesTheCause.length})`,
    hidesTheCause.length >= 2, hidesTheCause.map((t) => t.id).join(", "))

  const classes = new Set(EVAL_TASKS.map((t) => t.class))
  for (const c of ["cross-file", "verification", "incomplete-fix"]) {
    ok(`the set has a "${c}" class, so the report can locate weakness there`, classes.has(c))
  }
}

// ---------------------------------------------------------------------------
console.log("== 2. cross-file-cause: patching the caller is not fixing the cause ==")
{
  const t = byId("cross-file-cause")
  ok("the task exists", !!t)

  // The symptom is in the file the prompt names; the cause is one import away
  // in a file it never mentions.
  ok("the prompt names the symptom's file", t.prompt.includes("order.js"))
  ok("and never names the file holding the cause", !t.prompt.includes("money.js"))
  ok("the fix belongs in money.js", t.files["money.js"] !== t.solution["money.js"])
  ok("and order.js is left alone", t.files["order.js"] === t.solution["order.js"])

  // THE TEETH. Rounding in the caller makes refundTotal right while leaving
  // toCents wrong — the shape of a fix that treats the symptom. It must fail.
  // (no import of the primitive — a caller that bypasses toCents would not
  // keep importing it, and tests/ is scanned for real relative imports.)
  const patchedCaller = {
    "order.js": 'export function refundTotal(items) {\n  return items.reduce((a, i) => a + Math.round(i.price * i.qty * 100), 0)\n}\n',
    "money.js": t.files["money.js"],
  }
  const v = judge(t, patchedCaller)
  ok("bypassing the broken primitive in the caller does NOT pass",
    v.passed === false, String(v.output).replace(/\s+/g, " ").slice(0, 160))
  ok("and the oracle says which primitive is still wrong",
    /toCents|cents primitive/.test(String(v.output)), String(v.output).slice(0, 200))
}

// ---------------------------------------------------------------------------
console.log("== 3. green-but-wrong: a passing test is not proof of the requirement ==")
{
  const t = byId("green-but-wrong")
  ok("the task exists", !!t)

  // The point of this task: the workspace test is ALREADY GREEN before any
  // change. An agent that runs it, sees green and reports COMPLETED produces a
  // false completion — the metric this harness exists to measure, on the
  // failure mode most likely to cause it in a real repo.
  const d = scratch("green")
  writeAll(d, t.files)
  const visible = runVerification(d, ["node", ["test.mjs"]])
  ok("the visible test passes on the UNTOUCHED broken code", visible.passed === true,
    String(visible.output).slice(0, 200))

  const hidden = judge(t, t.files)
  ok("while the hidden oracle fails on that same code", hidden.passed === false)
  ok("the prompt states the requirement the visible test does not cover",
    /lowercase unless they are the first word/.test(t.prompt))

  // THE TEETH, both ways: the fix may not trade the covered case for the
  // uncovered one.
  const onlySmallWords = {
    ...t.files,
    "title.js": 'const SMALL = new Set(["a", "an", "and", "of", "the"])\nexport function titleCase(s) {\n  return String(s).split(" ").map((w) => (SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")\n}\n',
  }
  const v = judge(t, onlySmallWords)
  ok("lowercasing a leading small word does NOT pass either", v.passed === false,
    String(v.output).replace(/\s+/g, " ").slice(0, 160))

  const d2 = scratch("green2")
  writeAll(d2, t.solution)
  ok("and the real solution keeps the visible test green",
    runVerification(d2, ["node", ["test.mjs"]]).passed === true)
}

// ---------------------------------------------------------------------------
console.log("== 4. two-sites: changing the constant is not changing the behaviour ==")
{
  const t = byId("two-sites")
  ok("the task exists", !!t)
  ok("the prompt asks for agreement, not for one edit", /agree on the new limit/.test(t.prompt))

  // THE TEETH. The obvious single edit: bump the exported constant and stop.
  // validate.js hard-codes 100, so the system is left inconsistent.
  const halfDone = { "limits.js": "export const MAX_UPLOAD = 250\n", "validate.js": t.files["validate.js"] }
  const v = judge(t, halfDone)
  ok("updating only the constant does NOT pass", v.passed === false,
    String(v.output).replace(/\s+/g, " ").slice(0, 160))

  // …and the mirror image, so the task is not passable from one side only.
  const otherHalf = { "limits.js": t.files["limits.js"], "validate.js": t.solution["validate.js"] }
  ok("nor does updating only the validator", judge(t, otherHalf).passed === false)

  // The negative check: raising the limit must not accept everything.
  const wideOpen = {
    "limits.js": "export const MAX_UPLOAD = 250\n",
    "validate.js": "export function accepts() {\n  return true\n}\n",
  }
  ok("and accepting everything is not a fix", judge(t, wideOpen).passed === false)
}

// ---------------------------------------------------------------------------
console.log("== 5. the multi-file oracle really binds more than one module ==")
{
  // A cross-file check is only cross-file if the verify imports both sides.
  for (const id of ["cross-file-cause", "two-sites"]) {
    const src = byId(id).hiddenFiles["verify.mjs"]
    const imports = [...src.matchAll(/^import \* as (\w+) from "\.\/([\w.]+)"$/gm)]
    ok(`${id}'s oracle imports two modules`, imports.length === 2,
      JSON.stringify(imports.map((m) => m[2])))
    ok(`${id}'s oracle asserts against both`,
      imports.every(([, alias]) => new RegExp(`\\b${alias}\\.`).test(src)),
      src.slice(0, 160))
  }
}

// ---------------------------------------------------------------------------
console.log("== 6. the new tasks did not weaken the old contract ==")
{
  // Every guard test-v114 applies to the set must still hold for the additions:
  // the oracle is hidden, and deleting the feature is never a fix.
  const added = ["cross-file-cause", "green-but-wrong", "two-sites"].map(byId)
  for (const t of added) {
    const overlap = Object.keys(t.hiddenFiles).filter((f) => f in t.files)
    ok(`${t.id}: no hidden file is handed to the agent`, overlap.length === 0, overlap.join(", "))
    eq(`${t.id}: the solution replaces exactly the files given`,
      Object.keys(t.solution).sort(), Object.keys(t.files).sort())

    // An empty module is the laziest possible "fix".
    const emptied = Object.fromEntries(Object.keys(t.files).map((f) => [f, f.endsWith(".mjs") ? t.files[f] : ""]))
    ok(`${t.id}: an empty module does not pass`, judge(t, emptied).passed === false)
  }
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
