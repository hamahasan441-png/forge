#!/usr/bin/env node
/**
 * v94 gapclose — PERSISTENT semantic-search chunk index (TODO semantic_search).
 *
 * Before: the BM25 corpus (per-file line-window chunks) was rebuilt from
 * scratch in every process — the first semantic_search of every run re-read
 * and re-chunked the whole repository. Now the chunks persist in the
 * project's forge state dir (~/.forge/projects/<hash>/semantic-index.json),
 * fingerprint-invalidated per file (mtime+size, world-model discipline):
 * a fresh process reuses every unchanged file and re-chunks only what
 * actually changed. FORGE_INDEX=0 disables it. The repository itself stays
 * pure read — the index NEVER lives inside the project tree.
 *
 * Cross-process reuse is proven with REAL child processes (a same-process
 * test could only prove the in-memory cache, which already existed).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-semidx-"))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-semidx-work-"))

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}

// a small but real repository: 3 source files with distinguishable content
fs.mkdirSync(path.join(WORK, "src"), { recursive: true })
fs.writeFileSync(path.join(WORK, "src", "alpha.js"), "export function alphaHandler(req) { return computeAlpha(req.body) }\nfunction computeAlpha(b) { return b * 2 }\n")
fs.writeFileSync(path.join(WORK, "src", "beta.py"), "def beta_service(payload):\n    return {'beta': len(payload)}\n")
fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "semidx-demo", scripts: { test: "node --test" } }, null, 1))

// child runner: one fresh process per search (proves disk reuse, not memory)
import { fileURLToPath } from "node:url"
const CODESEARCH = fileURLToPath(new URL("../codesearch.js", import.meta.url))
const RUNNER = path.join(HOME, "runner.mjs")
fs.writeFileSync(RUNNER, `
process.env.FORGE_HOME = ${JSON.stringify(HOME)}
const { semanticSearch, persistentIndexPath, chunkCacheSize } = await import(${JSON.stringify(CODESEARCH)})
const res = await semanticSearch(${JSON.stringify(WORK)}, process.argv[2] ?? "alpha handler")
process.stdout.write(JSON.stringify({
  hits: res.hits, ok: res.ok, files: res.files, chunks: res.chunks, index: res.index ?? null,
  cacheSize: chunkCacheSize(), indexPath: persistentIndexPath(${JSON.stringify(WORK)}),
}))
`)
const run = (query, env = {}) => {
  const out = execFileSync(process.execPath, [RUNNER, query], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, FORGE_HOME: HOME, ...env },
  })
  return JSON.parse(out)
}

console.log("== run 1: cold process builds and PERSISTS the index ==")
const r1 = run("alpha handler")
{
  ok("search works cold", r1.ok === true && r1.hits.length > 0, JSON.stringify(r1.hits))
  ok("honest stats: nothing loaded from disk, files chunked from source", r1.index && r1.index.loadedFromDisk === 0 && r1.index.rebuilt >= 3, JSON.stringify(r1.index))
  ok("index saved to disk", r1.index.saved === true && r1.index.entries >= 3, JSON.stringify(r1.index))
  ok("index file exists at the reported path", fs.existsSync(r1.indexPath), r1.indexPath)
  ok("index lives in the forge state dir, NOT inside the repository", r1.indexPath.startsWith(HOME) && !r1.indexPath.startsWith(WORK), r1.indexPath)
  ok("no index file was written into the project tree", !fs.existsSync(path.join(WORK, "semantic-index.json")) && !fs.existsSync(path.join(WORK, ".forge")))
  const j = JSON.parse(fs.readFileSync(r1.indexPath, "utf8"))
  ok("index records root + per-file fingerprints + docs", j.v === 1 && j.root === WORK && Object.values(j.entries).every((e) => typeof e.mtimeMs === "number" && typeof e.size === "number" && Array.isArray(e.docs)), JSON.stringify(Object.keys(j)))
}

console.log("== run 2: fresh process REUSES the persisted chunks ==")
const r2 = run("alpha handler")
{
  ok("same hits as the cold run", JSON.stringify(r2.hits) === JSON.stringify(r1.hits), JSON.stringify(r2.hits))
  ok("chunks loaded FROM DISK (not rebuilt)", r2.index.loadedFromDisk >= 3 && r2.index.rebuilt === 0, JSON.stringify(r2.index))
  ok("nothing re-saved — an unchanged repo never rewrites its index", r2.index.saved === false, JSON.stringify(r2.index))
}

console.log("== run 3: a changed file re-chunks, the rest is reused ==")
{
  const beta = path.join(WORK, "src", "beta.py")
  // ensure a distinct mtime + size (fingerprint = mtime+size)
  await new Promise((r) => setTimeout(r, 20))
  fs.writeFileSync(beta, fs.readFileSync(beta, "utf8") + "\ndef gamma added later():\n    return 'gammarker'\n")
  const r3 = run("gammarker added")
  ok("the NEW content is searchable immediately", r3.ok === true && r3.hits.some((h) => h.path.endsWith("beta.py")), JSON.stringify(r3.hits))
  ok("only the changed file was rebuilt", r3.index.rebuilt === 1, JSON.stringify(r3.index))
  ok("unchanged files were reused from disk", r3.index.loadedFromDisk >= 2, JSON.stringify(r3.index))
  ok("index re-saved after the change", r3.index.saved === true, JSON.stringify(r3.index))
}

console.log("== run 4: FORGE_INDEX=0 disables persistence entirely ==")
{
  const idxFile = r1.indexPath
  const updatedAtBefore = JSON.parse(fs.readFileSync(idxFile, "utf8")).updatedAt
  const r4 = run("alpha handler", { FORGE_INDEX: "0" })
  ok("search still works (cache off ≠ search off)", r4.ok === true && r4.hits.length > 0)
  ok("index reports persistent:false honestly", r4.index && r4.index.persistent === false, JSON.stringify(r4.index))
  ok("everything rebuilt from source", r4.index.rebuilt >= 3, JSON.stringify(r4.index))
  const updatedAtAfter = JSON.parse(fs.readFileSync(idxFile, "utf8")).updatedAt
  ok("the disabled run never rewrote the persisted index", updatedAtAfter === updatedAtBefore, `${updatedAtBefore} → ${updatedAtAfter}`)
}

console.log("== index invalidation is per-file, never all-or-nothing ==")
{
  // touch alpha.js (new content, new size) → run 5 must reuse beta/package.json
  await new Promise((r) => setTimeout(r, 20))
  fs.writeFileSync(path.join(WORK, "src", "alpha.js"), "export function alphaHandlerV2(req) { return req.id }\n")
  const r5 = run("alphaHandlerV2")
  ok("rebuilt exactly the touched file", r5.index.rebuilt === 1, JSON.stringify(r5.index))
  ok("reused the rest from disk", r5.index.loadedFromDisk >= 2, JSON.stringify(r5.index))
  ok("new symbol found", r5.hits.some((h) => h.path.endsWith("alpha.js")))
}

console.log(`\n== semantic-index-persist suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
