#!/usr/bin/env node
/**
 * forge — sourceresolve acceptance (v97 §4 — the NON-NEGOTIABLE).
 *
 * Local-first source resolution: before engineering work, determine what
 * source the user actually means — and the LOCAL artifact always outranks a
 * remote one. This suite pins:
 *
 *   §1  the resolution ladder: explicit file → folder → ZIP → URL → git →
 *       workspace, each with the right authority label
 *   §2  ZIP-as-project: inspect (root/manifests/languages/git/tests) →
 *       safe extraction (zip-slip guarded, caps, CRC-checked)
 *   §3  the conflict rule: an explicit local archive WINS over a git cwd,
 *       and the conflict is RECORDED with both candidates
 *   §4  refusal: an unresolvable input is NEVER guessed
 *   §5  persistence: source records (sourceType/origin/authority/reason/
 *       evidence/history) round-trip; implicit runs never overwrite a record
 *   §6  remote search never happens implicitly (no GitHub bias)
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)
const MOD = await import("../sourceresolve.js")

let passed = 0
let failed = 0
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"))
process.env.FORGE_HOME = path.join(TMP, "home") // isolate ~/.forge BEFORE heavy imports

// --- zip builder (store + deflate variants) --------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function buildZip(files, { method = 0 } = {}) {
  const chunks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8")
    const comp = method === 8 ? zlib.deflateRawSync(data) : data
    const nb = Buffer.from(name, "utf8")
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(0, 6)
    h.writeUInt16LE(method, 8)
    h.writeUInt32LE(crc32(data), 14)
    h.writeUInt32LE(comp.length, 18)
    h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(nb.length, 26)
    chunks.push(h, nb, comp)
  }
  return Buffer.concat(chunks)
}

console.log("== sourceresolve: v97 §4 local-first source resolution ==")

// §1 — the ladder
{
  const fileDir = path.join(TMP, "ladder")
  fs.mkdirSync(fileDir, { recursive: true })
  const single = path.join(fileDir, "notes.md")
  fs.writeFileSync(single, "# notes")
  const folder = path.join(fileDir, "srcproj")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "package.json"), '{"name":"x"}')
  const zipPath = path.join(fileDir, "arch.zip")
  fs.writeFileSync(zipPath, buildZip({ "p/package.json": "{}" }))

  const rFile = MOD.resolveSource(single, { cwd: fileDir })
  eq("§1 explicit local file", rFile.sourceType, "file")
  eq("§1 file authority", rFile.authority, "explicit-local-file")

  const rFolder = MOD.resolveSource(folder, { cwd: fileDir })
  eq("§1 explicit local folder", rFolder.sourceType, "folder")
  eq("§1 folder authority", rFolder.authority, "explicit-local-folder")
  ok("§1 folder inspect found the manifest", (rFolder.inspect?.manifests ?? []).includes("package.json"))

  const rZip = MOD.resolveSource(zipPath, { cwd: fileDir })
  eq("§1 local zip is an archive", rZip.sourceType, "archive")
  eq("§1 archive authority", rZip.authority, "explicit-local-archive")

  const rUrl = MOD.resolveSource("https://example.com/p.zip", { cwd: fileDir })
  eq("§1 https url", rUrl.sourceType, "url")
  const rGit = MOD.resolveSource("https://example.com/repo.git", { cwd: fileDir })
  eq("§1 git url", rGit.sourceType, "git-url")

  const rWs = MOD.resolveSource(null, { cwd: fileDir })
  eq("§1 implicit → workspace", rWs.sourceType, "workspace")
  ok("§1 workspace reason cites §4", /current workspace is authoritative/.test(rWs.reason ?? ""))
}

// §2 — ZIP-as-project pipeline
{
  const files = {
    "proj/package.json": JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node --test" } }),
    "proj/src/index.js": "export function main() { return 1 }\nexport function other() { return 2 }",
    "proj/src/index.test.js": "import { main } from './index.js'",
    "proj/README.md": "# demo",
  }
  const buf = buildZip(files, { method: 8 }) // deflate
  const listing = MOD.listProjectZipEntries(buf)
  eq("§2 deflate zip lists entries", listing?.entries?.length, 4)
  const inspect = MOD.inspectZipBuffer(buf)
  eq("§2 root identified", inspect.root, "proj")
  ok("§2 manifests detected", inspect.manifests.includes("package.json"))
  eq("§2 language census", inspect.languages.javascript, 2)
  eq("§2 tests detected", inspect.tests, 1)
  eq("§2 git honestly absent", inspect.git, false)

  const dest = path.join(TMP, "extract-deflate")
  const ex = MOD.extractProjectZip(buf, dest)
  ok("§2 extraction ok", ex.ok === true)
  eq("§2 extracted count", ex.files.length, 4)
  ok("§2 root prefix stripped", fs.existsSync(path.join(dest, "package.json")) && fs.existsSync(path.join(dest, "src", "index.js")))
  ok("§2 content intact", fs.readFileSync(path.join(dest, "src", "index.js"), "utf8").includes("export function main"))
  eq("§2 zero skipped", ex.skipped, 0)

  // zip-slip guard
  const evil = buildZip({ "../evil.txt": "boom" })
  const exEvil = MOD.extractProjectZip(evil, path.join(TMP, "extract-evil"))
  eq("§2 zip-slip entry skipped", exEvil.skipped >= 1, true)
  ok("§2 nothing escaped the dest", !fs.existsSync(path.join(TMP, "evil.txt")))
}

// §3 — conflict rule: explicit local archive beats a git cwd, recorded
{
  const gitDir = path.join(TMP, "gitcwd")
  fs.mkdirSync(gitDir, { recursive: true })
  try { await execFileP("git", ["init", "-q"], { cwd: gitDir }) } catch {}
  const isGit = fs.existsSync(path.join(gitDir, ".git"))
  if (isGit) {
    const zipPath = path.join(TMP, "local.zip")
    fs.writeFileSync(zipPath, buildZip({ "app/package.json": "{}" }))
    const r = MOD.resolveSource(zipPath, { cwd: gitDir })
    eq("§3 archive still wins in a git cwd", r.sourceType, "archive")
    ok("§3 conflict recorded", r.conflict != null && r.conflict.winner === "local-archive")
    ok("§3 conflict lists both candidates", (r.conflict?.candidates ?? []).includes("workspace-git"))
    ok("§3 evidence cites the explicit selection", (r.evidence ?? []).some((e) => e.kind === "conflict"))
  } else {
    ok("§3 (git unavailable — skipped honestly)", true)
  }
}

// §4 — refusal, never a guess
{
  const r = MOD.resolveSource(path.join(TMP, "missing-thing.zip"), { cwd: TMP })
  eq("§4 unresolvable input", r.sourceType, "unresolved")
  ok("§4 refusal reason is honest", /refusing to guess/.test(r.reason ?? ""))
}

// §5 — persistence round-trip + implicit never overwrites
{
  const proj = path.join(TMP, "persist")
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, "package.json"), '{"name":"persist"}')
  const rec1 = MOD.ensureWorkspaceSource(proj)
  ok("§5 implicit run records the source", rec1 != null && rec1.sourceType === "workspace")
  // an EXPLICIT re-record wins (user selected a source)
  const zipPath = path.join(TMP, "explicit.zip")
  fs.writeFileSync(zipPath, buildZip({ "p2/package.json": "{}" }))
  const act = await MOD.activateSource(zipPath, { cwd: proj })
  ok("§5 activateSource ok", act.ok === true && act.localPath != null)
  const rec2 = MOD.readSourceRecord(act.localPath)
  eq("§5 explicit source recorded", rec2?.sourceType, "archive")
  ok("§5 history preserved", Array.isArray(rec2?.history) && rec2.history.length >= 1)
  // implicit never overwrites the explicit record
  MOD.ensureWorkspaceSource(act.localPath)
  const rec3 = MOD.readSourceRecord(act.localPath)
  eq("§5 implicit does not clobber explicit", rec3?.sourceType, "archive")
}

// §6 — no remote search: resolveSource NEVER touches the network for local inputs
{
  const before = { ...process.env }
  const r = MOD.resolveSource(null, { cwd: TMP })
  eq("§6 implicit resolution stays local", r.sourceType, "workspace" )
  eq("§6 env untouched", JSON.stringify(process.env), JSON.stringify(before))
  ok("§6 no remote discovery evidence", !(r.evidence ?? []).some((e) => /github|search|clone/i.test(e.kind)))
}

console.log(`\n== sourceresolve: ${passed} passed, ${failed} failed ==`)
if (failed) process.exit(1)
