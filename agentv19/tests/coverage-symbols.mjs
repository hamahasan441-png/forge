#!/usr/bin/env node
/**
 * forge — export coverage report (v20.3, P2-2).
 *
 * For every `export` in forge/*.js, check whether the symbol's name appears
 * anywhere under tests/. Deliberately crude and honest about it: it over-counts
 * (a trivial constant merely mentioned counts as covered) and under-counts
 * (symbols exercised indirectly through the e2e never appear by name). It is a
 * direction indicator, not a truth — but a number beats a feeling, and it makes
 * "this module has no direct test at all" impossible to miss.
 *
 * Usage:  node tests/coverage-symbols.mjs [--json] [--min <pct>]
 * Exits non-zero only when --min is given and the total falls below it.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, "..", "forge")
const args = process.argv.slice(2)
const asJson = args.includes("--json")
const minIdx = args.indexOf("--min")
const min = minIdx !== -1 ? Number(args[minIdx + 1]) : null

// every exported symbol name in a module
function exportsOf(src) {
  const names = new Set()
  let m
  const reDecl = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  while ((m = reDecl.exec(src))) names.add(m[1])
  const reList = /^\s*export\s*\{([^}]+)\}/gm
  while ((m = reList.exec(src))) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/i).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  return [...names]
}

const testBlob = fs.readdirSync(HERE)
  .filter((f) => /\.(mjs|sh)$/.test(f) && f !== path.basename(fileURLToPath(import.meta.url)))
  .map((f) => { try { return fs.readFileSync(path.join(HERE, f), "utf8") } catch { return "" } })
  .join("\n")

const rows = []
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".js")).sort()) {
  let src = ""
  try { src = fs.readFileSync(path.join(SRC, f), "utf8") } catch { continue }
  const names = exportsOf(src)
  if (!names.length) continue
  const hit = names.filter((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(testBlob))
  rows.push({ module: f, total: names.length, covered: hit.length, missing: names.filter((n) => !hit.includes(n)) })
}

const total = rows.reduce((a, r) => a + r.total, 0)
const covered = rows.reduce((a, r) => a + r.covered, 0)
const pct = total ? Math.round((covered / total) * 1000) / 10 : 0

if (asJson) {
  console.log(JSON.stringify({ total, covered, pct, modules: rows }, null, 2))
} else {
  console.log("export coverage — exported symbols named by at least one test\n")
  const width = Math.max(...rows.map((r) => r.module.length))
  for (const r of rows.sort((a, b) => (a.covered / a.total) - (b.covered / b.total) || a.module.localeCompare(b.module))) {
    const p = Math.round((r.covered / r.total) * 100)
    const bar = "█".repeat(Math.round(p / 10)).padEnd(10, "·")
    const miss = r.missing.length ? `  missing: ${r.missing.slice(0, 6).join(", ")}${r.missing.length > 6 ? ` +${r.missing.length - 6}` : ""}` : ""
    console.log(`  ${r.module.padEnd(width)}  ${bar} ${String(p).padStart(3)}%  ${r.covered}/${r.total}${miss}`)
  }
  console.log(`\n  TOTAL: ${covered}/${total} exported symbols (${pct}%) across ${rows.length} modules`)
  console.log("  (heuristic: name-appears-in-tests; indirect e2e coverage is invisible to it)")
}

if (min !== null && pct < min) {
  console.error(`\n✗ export coverage ${pct}% is below the --min ${min}%`)
  process.exit(1)
}
