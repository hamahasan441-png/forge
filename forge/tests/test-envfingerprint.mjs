#!/usr/bin/env node
/**
 * forge — envfingerprint acceptance (v96 unifywise §50).
 *
 * The environment fingerprint + drift engine — the ONE missing intelligence
 * layer the upgrade spec demanded (§50): what environment a task ran in, and
 * what CHANGED since the last task in this project. Deterministic, bounded,
 * advisory-only (drift is a WARNING with impact notes, never a gate input).
 *
 * Coverage:
 *   1. capture — process facts + stat-only toolchain presence; versions are
 *      probed once per process and TTL-reused from the persisted file
 *   2. save/load round-trip through securefs (atomic, schema-gated)
 *   3. diff — added/removed/changed signals with deterministic impact notes;
 *      node major / arch / platform / toolchain presence + major version
 *   4. checkEnvironment — first run records (no drift), second run with a
 *      mutated fingerprint reports drift, persists the new one
 *   5. formatDrift — bounded one-line summary
 *   6. off-switch — FORGE_ENVFP=0 disables everything honestly
 *   7. meta wiring — the task-start check + ENVIRONMENT_DRIFT event exist
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-envfp-home-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-envfp-work-"))
process.chdir(work)

const envfp = await import("../envfingerprint.js")

console.log("== 1. capture ==")
{
  const fp = envfp.capture()
  ok("capture returns a fingerprint", Boolean(fp && fp.schema === 1))
  ok("process facts are recorded", fp.node === process.version && fp.arch === process.arch && fp.platform === process.platform && fp.cpuCount === os.cpus().length)
  ok("node itself is tracked as a toolchain (present)", fp.toolchains.node.present === true && typeof fp.toolchains.node.version === "string")
  ok("tracked toolchains bounded to the catalog", Object.keys(fp.toolchains).length <= 24)
  // a binary certainly NOT on PATH in a clean test env is honestly absent
  const absent = Object.entries(fp.toolchains).filter(([, t]) => !t.present)
  ok("absent binaries are recorded present:false, version:null (never guessed)", absent.every(([, t]) => t.version === null), JSON.stringify(Object.fromEntries(absent.slice(0, 3))))
}

console.log("== 2. save/load round-trip ==")
{
  const fp = envfp.capture()
  ok("saveEnv persists", envfp.saveEnv(fp, work) === true)
  const p = path.join(HOME, "projects")
  const projDir = fs.readdirSync(p).find((d) => fs.statSync(path.join(p, d)).isDirectory())
  ok("env.json exists under the project dir", Boolean(projDir && fs.existsSync(path.join(p, projDir, "env.json"))))
  const back = envfp.loadEnv(work)
  ok("loadEnv round-trips the fingerprint", Boolean(back && back.schema === 1 && back.arch === fp.arch))
  const corrupt = path.join(p, projDir, "env.json")
  fs.writeFileSync(corrupt, "{ not json")
  ok("corrupt env.json → loadEnv returns null (honest miss)", envfp.loadEnv(work) === null)
  envfp.saveEnv(fp, work) // restore for later sections
}

console.log("== 3. diff ==")
{
  const a = { node: "v20.1.0", arch: "x64", platform: "linux", toolchains: { node: { present: true, version: "20.1.0" }, docker: { present: true, version: "24.0.7" }, python: { present: false, version: null } } }
  const same = envfp.diff(a, { ...a, toolchains: { ...a.toolchains } })
  ok("identical environments → no drift", same.drifted === false && same.signals.length === 0)
  const b = { node: "v24.1.0", arch: "x64", platform: "linux", toolchains: { node: { present: true, version: "24.1.0" }, docker: { present: false, version: null }, python: { present: true, version: "3.12.1" } } }
  const d = envfp.diff(a, b)
  ok("node major + docker removed + python added are all detected", d.drifted === true && d.signals.length === 3, JSON.stringify(d.signals.map((s) => `${s.kind}:${s.key}`)))
  ok("each signal carries an impact note", d.signals.every((s) => typeof s.impact === "string" && s.impact.length > 10))
  ok("node drift mentions ABI/native modules", d.signals.find((s) => s.key === "node").impact.includes("native modules"))
  ok("docker removal mentions runtime strategies", d.signals.find((s) => s.key === "docker").impact.includes("runtime"))
  const patch = envfp.diff(a, { ...a, node: "v20.11.0", toolchains: { ...a.toolchains, node: { present: true, version: "20.11.0" } } })
  ok("same node MAJOR → no drift signal (patch changes are noise)", patch.drifted === false)
}

console.log("== 4. checkEnvironment ==")
{
  // first run in a fresh project: records, no drift
  const first = envfp.checkEnvironment({ cwd: work })
  ok("first check records the fingerprint", first.ok === true && first.saved === true)
  ok("no previous environment → no drift claimed", first.drift.drifted === false)
  // second run with a mutated persisted fingerprint: drift is reported
  const fp = envfp.loadEnv(work)
  fp.node = "v18.0.0"
  fp.toolchains.node.version = "18.0.0"
  envfp.saveEnv(fp, work)
  const second = envfp.checkEnvironment({ cwd: work })
  ok("mutated node major → drift reported", second.ok === true && second.drift.drifted === true)
  ok("drift names node", second.drift.signals.some((s) => s.key === "node" && s.kind === "changed"))
  // and the new fingerprint is persisted (drift is one-shot per change)
  const third = envfp.checkEnvironment({ cwd: work })
  ok("drift is not re-reported after the fingerprint is refreshed", third.drift.drifted === false)
}

console.log("== 5. formatDrift ==")
{
  const d = envfp.diff(
    { node: "v20.0.0", arch: "x64", platform: "linux", toolchains: {} },
    { node: "v24.0.0", arch: "x64", platform: "linux", toolchains: {} },
  )
  const line = envfp.formatDrift(d)
  ok("drift line is bounded and names the signal", line.startsWith("[env drift]") && line.includes("node") && line.length <= 300, line)
  eq("no drift → empty line", envfp.formatDrift({ drifted: false, signals: [] }), "")
}

console.log("== 6. off-switch ==")
{
  process.env.FORGE_ENVFP = "0"
  eq("FORGE_ENVFP=0 → capture returns null (honest off)", envfp.capture(), null)
  const r = envfp.checkEnvironment({ cwd: work })
  eq("FORGE_ENVFP=0 → check is a no-op", r, { ok: false, drift: null, saved: false, fingerprint: null })
  delete process.env.FORGE_ENVFP
}

console.log("== 7. meta wiring (source) ==")
{
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("meta checks the environment at task start", metaSrc.includes("checkEnvironment("))
  ok("drift becomes an advisory ENVIRONMENT_DRIFT event", metaSrc.includes('"ENVIRONMENT_DRIFT"') && metaSrc.includes("advisory: true"))
  ok("the check never breaks the run (advisory catch)", /environment fingerprinting is advisory/.test(metaSrc))
}

console.log(`\nenvfingerprint: ${PASS} passed, ${FAIL} failed`)
if (FAIL > 0) process.exit(1)
