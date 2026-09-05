#!/usr/bin/env node
/**
 * forge — repo map checks (v20.2 P3-1): symbol extraction across languages,
 * skip-dir and .gitignore exclusion, and output bounding. Temp tree, no network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildRepoMap } from "../forge/repomap.js"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-"))
const w = (rel, body) => { fs.mkdirSync(path.join(ROOT, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), body) }

w("src/util.js", "export function alpha(){}\nexport const beta = 1\nfunction notExported(){}\nexport class Gamma {}\n")
w("src/named.ts", "const a=1, b=2\nexport { a, b as bee }\n")
w("lib/thing.py", "import os\ndef top_func():\n    def nested():\n        pass\nclass MyClass:\n    def method(self): pass\n")
w("cmd/main.go", "package main\nfunc Exported(){}\nfunc unexported(){}\ntype Widget struct{}\n")
w("core/lib.rs", "pub fn do_it(){}\nfn private(){}\npub struct Config{}\n")
w("dist/bundle.js", "export function shouldNotAppear(){}\n")     // default skip
w("node_modules/dep/i.js", "export const nope = 1\n")            // default skip
w("secret/gen.js", "export function hidden(){}\n")               // via .gitignore
w(".gitignore", "secret/\n")

const map = buildRepoMap(ROOT)

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== symbol extraction ==")
ok("JS export function", /alpha/.test(map))
ok("JS export const", /beta/.test(map))
ok("JS export class", /Gamma/.test(map))
ok("non-exported JS omitted", !/notExported/.test(map))
ok("TS named export (aliased) uses the exported name", /bee/.test(map) && !/\bb as bee\b/.test(map))
ok("Python top-level def", /top_func/.test(map))
ok("Python class", /MyClass/.test(map))
ok("Python nested def omitted", !/nested/.test(map))
ok("Go exported func", /Exported/.test(map))
ok("Go unexported omitted", !/unexported/.test(map))
ok("Go type", /Widget/.test(map))
ok("Rust pub fn", /do_it/.test(map))
ok("Rust private omitted", !/private/.test(map))

console.log("== exclusions ==")
ok("dist/ excluded", !/shouldNotAppear/.test(map))
ok("node_modules/ excluded", !/nope/.test(map))
ok("gitignored dir excluded", !/hidden/.test(map))

console.log("== bounding ==")
const big = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-big-"))
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(big, `f${i}.js`), `export function fn${i}(){}\n`)
const bmap = buildRepoMap(big, { maxListed: 5, maxChars: 2000 })
ok("respects maxListed", (bmap.match(/^- /gm) || []).length <= 5)
ok("notes the omitted files", /more source files/.test(bmap))
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-map-empty-"))
fs.writeFileSync(path.join(empty, "readme.md"), "# hi")
ok("no source files → empty string", buildRepoMap(empty) === "")

try { for (const d of [ROOT, big, empty]) fs.rmSync(d, { recursive: true, force: true }) } catch {}
console.log(`\n== repomap suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
