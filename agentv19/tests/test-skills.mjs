#!/usr/bin/env node
/**
 * forge — skill linting checks (v20.2 P2-5): checkSkills validates names,
 * descriptions, broken markdown links (ignoring placeholders), and size.
 * Synthetic skill tree, zero network. Also asserts the bundled skills are clean.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkSkills } from "../forge/skills.js"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-"))
const skill = (name, files) => {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(DIR, name, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, body)
  }
}

skill("good", { "SKILL.md": "# Good Skill\n\nDoes a thing. See [helper](scripts/run.py).\n", "scripts/run.py": "print(1)\n" })
skill("brokenlink", { "SKILL.md": "# Broken\n\nRun [it](scripts/missing.py) now.\n" })
skill("placeholders", { "SKILL.md": "# Placeholders\n\nExamples: [x](URL) ![y](path/to/image.jpg) `scripts/...` [z](https://example.com/a).\n" })
skill("nodesc", { "SKILL.md": "# \n\n" })
skill("empty", { "SKILL.md": "" })
skill("notaskill", { "README.md": "no SKILL.md here" })

const rep = checkSkills(DIR)
const by = Object.fromEntries(rep.skills.map((s) => [s.name, s]))

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== checkSkills ==")
ok("counts only real skill dirs (SKILL.md present)", rep.total === 5 && !by.notaskill)
ok("valid skill passes", by.good && by.good.ok && by.good.issues.length === 0)
ok("broken markdown link detected", by.brokenlink && !by.brokenlink.ok && by.brokenlink.issues.some((i) => /missing\.py/.test(i)))
ok("placeholders are NOT flagged", by.placeholders && by.placeholders.ok)
ok("missing description flagged", by.nodesc && by.nodesc.issues.some((i) => /description/i.test(i)))
ok("empty SKILL.md flagged", by.empty && by.empty.issues.some((i) => /empty/i.test(i)))
ok("overall not ok when any skill fails", rep.ok === false && rep.failed >= 3)
ok("size reported in KB", typeof by.good.sizeKB === "number")

console.log("== oversized skill flagged ==")
skill("huge", { "SKILL.md": "# Huge\n\n" + "x".repeat(70 * 1024) })
const rep2 = checkSkills(DIR)
ok("large SKILL.md flagged", rep2.skills.find((s) => s.name === "huge").issues.some((i) => /KB/.test(i)))

console.log("== bundled skills are clean ==")
const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge", "skills")
if (fs.existsSync(bundled)) {
  const rb = checkSkills(bundled)
  ok(`all ${rb.total} bundled skills valid`, rb.ok === true)
  if (!rb.ok) for (const s of rb.skills.filter((x) => !x.ok)) console.log(`      ${s.name}: ${s.issues.join("; ")}`)
} else {
  ok("bundled skills dir present", false)
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== skills suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
