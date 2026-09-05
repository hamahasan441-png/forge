#!/usr/bin/env node
/**
 * forge — walk-policy checks (v20.2 P1-2). One shared SKIP set across
 * list_dir/grep_files/glob_files, plus best-effort .gitignore directory
 * awareness. Uses the real tools against a temp tree. Zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execTool } from "../forge/tools.js"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-walk-"))
const w = (rel, body) => { fs.mkdirSync(path.join(ROOT, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), body) }

w("src/keep.txt", "FINDME here\n")
w("dist/gen.txt", "FINDME generated\n")          // dist is a default skip
w("node_modules/pkg/index.txt", "FINDME dep\n")   // default skip
w("generated/out.txt", "FINDME custom\n")         // skipped only via .gitignore
w(".gitignore", "generated/\n# comment\n*.log\n!keep\n")

const ctx = {
  cwd: ROOT, root: ROOT, timeoutSec: 5, maxToolOutput: 8000, skillsDir: null,
  readOnly: false, allowOutsideProject: false, allowSudo: false, assumeYes: false,
  fetchPrivateUrls: false,
}

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== grep_files honors the shared skip + .gitignore ==")
const g = await execTool(ctx, "grep_files", { pattern: "FINDME", path: "." })
ok("finds the real source file", /src\/keep\.txt/.test(g))
ok("skips dist/ (default)", !/dist\/gen\.txt/.test(g))
ok("skips node_modules/ (default)", !/node_modules/.test(g))
ok("skips generated/ (from .gitignore)", !/generated\/out\.txt/.test(g))

console.log("== glob_files honors the shared skip + .gitignore ==")
const gl = await execTool(ctx, "glob_files", { pattern: "**/*.txt", path: "." })
ok("globs the real source file", /src\/keep\.txt/.test(gl))
ok("glob skips dist/", !/dist\/gen\.txt/.test(gl))
ok("glob skips generated/ (gitignore)", !/generated\/out\.txt/.test(gl))

console.log("== list_dir honors the shared skip + .gitignore ==")
const ls = await execTool(ctx, "list_dir", { path: "." })
ok("lists src/", /src\//.test(ls))
ok("list_dir hides dist/", !/dist\//.test(ls))
ok("list_dir hides generated/ (gitignore)", !/generated\//.test(ls))

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
console.log(`\n== walk suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
