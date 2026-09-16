#!/usr/bin/env node
/**
 * forge — v107 "createwise": when a capability is missing, find / compose /
 * create / verify / register, then the NEXT task uses it. Failure feeds
 * existing caplearn. MICRO never creates. A single miss never creates.
 *
 * Acceptance is behavioral, not "a file exists".
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-create-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const {
  createForGap, loadActiveCreatedTools, listToolLife, TOOL_LIFE, toolNameFor,
} = await import("../toolcreate.js")
const { noteCapabilityGap, recordCapOutcome, shouldWithhold, loadCapLearn } = await import("../caplearn.js")
const { selectForTurn } = await import("../capindex.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-create-proj-"))
const CAP = "invoice_parse"

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
}

console.log("== MICRO and a single miss never create ==")
{
  const micro = await createForGap({ cwd: work, capability: CAP, task: "parse invoices", klass: "MICRO" })
  ok("MICRO skips creation", micro.ok === false && /MICRO/.test(micro.skipped || ""), JSON.stringify(micro))
  const once = await createForGap({ cwd: work, capability: CAP, task: "parse invoices", klass: "LARGE" })
  ok("a single LARGE miss does not create", once.ok === false && /repeated/.test(once.skipped || ""), JSON.stringify(once))
}

console.log("== Run 1: repeated gap → design → implement → verify → ACTIVE ==")
{
  noteCapabilityGap({ cwd: work, capability: CAP, klass: "LARGE" })
  noteCapabilityGap({ cwd: work, capability: CAP, klass: "LARGE" })
  const made = await createForGap({ cwd: work, capability: CAP, task: "parse vendor invoices from pdf", klass: "LARGE" })
  ok("creation succeeded", made.ok === true && made.created === true, JSON.stringify(made))
  ok("lifecycle ACTIVE", made.lifecycle === TOOL_LIFE.ACTIVE, made.lifecycle)
  const name = toolNameFor(CAP)
  ok("name is the capability slug", made.name === name, made.name)
  const life = listToolLife(work)
  ok("registry lists it ACTIVE + verified", life.some((t) => t.name === name && t.lifecycle === "ACTIVE" && t.verified === true))
  const loaded = await loadActiveCreatedTools(work)
  ok("loadActiveCreatedTools returns a real run() plugin", loaded.some((p) => p.name === name && typeof p.run === "function"))
}

console.log("== Run 2: similar task REUSES X, does not duplicate ==")
{
  noteCapabilityGap({ cwd: work, capability: CAP, klass: "LARGE" })
  noteCapabilityGap({ cwd: work, capability: CAP, klass: "LARGE" })
  const again = await createForGap({ cwd: work, capability: CAP, task: "parse more invoices", klass: "LARGE" })
  ok("second call reuses, does not fork", again.ok === true && again.reused === true, JSON.stringify(again))
  const n = listToolLife(work).filter((t) => t.name === toolNameFor(CAP)).length
  ok("still one registry row", n === 1)
  const sel = selectForTurn({
    task: "parse vendor invoices",
    klass: "LARGE",
    cwd: work,
    createdTools: listToolLife(work),
    pickSkillsFn: () => [],
    nativeNames: ["read_file"],
  })
  ok("future turn offers the created tool", (sel.created || []).some((t) => t.name === toolNameFor(CAP)))
}

console.log("== Run 3–4: X fails on LARGE → next LARGE withholds X ==")
{
  const name = toolNameFor(CAP)
  for (let i = 0; i < 3; i++) {
    recordCapOutcome({ cwd: work, name, kind: "created", klass: "LARGE", ok: false, why: "wrong schema on real invoices" })
  }
  const store = loadCapLearn(work)
  ok("created tool is withheld on LARGE", shouldWithhold(store, { name, kind: "created", klass: "LARGE" }) === true)
  const sel = selectForTurn({
    task: "parse vendor invoices",
    klass: "LARGE",
    cwd: work,
    createdTools: listToolLife(work),
    pickSkillsFn: () => [],
    nativeNames: ["read_file"],
  })
  ok("selectForTurn drops the broken created tool", !(sel.created || []).some((t) => t.name === name), JSON.stringify(sel.created))
  ok("the drop is explained", (sel.trimmed || []).some((t) => t.name === name && t.kind === "created"))
  ok("MICRO is not poisoned", shouldWithhold(store, { name, kind: "created", klass: "MICRO" }) === false)
}

console.log("== live agent path is wired, not a second brain ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent calls considerCreateForGaps", /considerCreateForGaps/.test(src))
  ok("agent passes createdTools into selectForTurn", /createdTools:/.test(src))
  ok("agent records created-tool outcomes", /createdNames:/.test(src))
  ok("MICRO/SMALL never enter the create branch", /turnKlass === "LARGE"/.test(src) && /ARCHITECTURAL/.test(src))
  ok("no ToolManager module exists", !fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "toolmanager.js")))
}

console.log(`\n== create suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
