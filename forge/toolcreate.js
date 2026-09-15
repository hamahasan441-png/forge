/**
 * forge — TOOL CREATION pipeline (v93 gap fix §19/§20, zero dependencies)
 *
 * Tool Intelligence (toolintel.js) discovers and LEARNS from tool usage; the
 * v40 authorPlugin seeds plugin files. What did not exist is the CREATION
 * LIFECYCLE with behavioral verification:
 *
 *   CAPABILITY GAP → DESIGN → IMPLEMENT → TEST → BEHAVIORAL VERIFY → REGISTER
 *
 *   CANDIDATE → TESTING → VERIFIED → ACTIVE        (§20 lifecycle)
 *                     └→ INACTIVE on failure       (never quietly active)
 *
 * Rules (the §19/§20 contract):
 *   - generated tools carry full metadata: name, description, inputSchema,
 *     outputSchema, version, provenance (source task + related files +
 *     author), tests, verification status, capabilities.
 *   - VERIFICATION IS BEHAVIORAL: the generated plugin is imported and run
 *     in a REAL child process with sample args; the observed output must
 *     match the declared output schema, the run must exit 0 within the
 *     timeout. A build that compiles is not behavioral proof.
 *   - only VERIFIED tools may be activated; activation is never automatic.
 *   - project-local only (~/.forge/projects/<hash>/tools/ + toollife.json);
 *     the production dir ~/.forge/tools is NEVER written by this pipeline.
 *   - the implementation is ISOLATED: read-only by default, 8s cap, no
 *     kernel edits — same isolation contract as learned plugins (extend.js).
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { learnedPluginsDir } from "./extend.js"
import { noteCapabilityGap, gapRepeats, recordCapOutcome, shouldWithhold, loadCapLearn } from "./caplearn.js"

export const TOOL_LIFE = {
  CANDIDATE: "CANDIDATE",
  TESTING: "TESTING",
  VERIFIED: "VERIFIED",
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
}

export const TOOL_LIFE_FILE = "toollife.json"
const MAX_TOOLS = 32
const NAME_RE = /^[a-z][a-z0-9_]{2,39}$/

function lifePath(cwd) {
  return path.join(projectDir(cwd), TOOL_LIFE_FILE)
}
function toolsDir(cwd) {
  return learnedPluginsDir(cwd)
}

export function loadToolLife(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(lifePath(cwd), "utf8"))
    if (j && typeof j === "object" && j.tools && typeof j.tools === "object") return j
  } catch { }
  return { v: 1, tools: {} }
}

function saveToolLife(cwd, data) {
  const names = Object.keys(data.tools)
  if (names.length > MAX_TOOLS) {
    // bounded: drop the oldest inactive candidates first, never ACTIVE tools
    const droppable = names
      .filter((n) => data.tools[n].lifecycle !== TOOL_LIFE.ACTIVE)
      .sort((a, b) => (data.tools[a].updated ?? 0) - (data.tools[b].updated ?? 0))
    for (const n of droppable.slice(0, names.length - MAX_TOOLS)) delete data.tools[n]
  }
  data.v = 1
  data.updated = Date.now()
  writeStateFile(lifePath(cwd), JSON.stringify(data, null, 1))
}

export function readToolRecord(cwd, name) {
  return loadToolLife(cwd).tools?.[name] ?? null
}

// ---------------------------------------------------------------------------
// 1. DESIGN — metadata + provenance; the tool becomes a CANDIDATE
// ---------------------------------------------------------------------------

/**
 * Design a new tool from a capability gap. Records the CANDIDATE with full
 * provenance (§20 metadata). Does NOT write any executable.
 */
export function designTool({
  cwd = process.cwd(),
  name = "",
  description = "",
  task = "",                    // the capability gap that motivated this
  inputSchema = null,
  outputSchema = null,
  capabilities = [],
  relatedFiles = [],
  author = "forge",
  probeSteps = null,            // v94 todowise: optional multi-step behavioral probe script
} = {}) {
  const id = String(name || "").trim()
  const blocked = []
  if (!NAME_RE.test(id)) blocked.push(`name must match ${NAME_RE} (got "${id}")`)
  const desc = String(description ?? "").trim()
  if (desc.length < 10) blocked.push("description must be at least 10 chars")
  const inSchema = inputSchema && typeof inputSchema === "object" ? inputSchema : { type: "object", properties: {} }
  if (inSchema.type !== "object") blocked.push("inputSchema.type must be 'object'")
  const outSchema = outputSchema && typeof outputSchema === "object" ? outputSchema : { type: "string" }
  if (!["string", "object", "array"].includes(outSchema.type)) blocked.push("outputSchema.type must be string|object|array")
  // v94 todowise: multi-step probes (login → act → verify style tools) — a
  // step is { args, expectOk?, expectContains?, label? }. Shape-validated here
  // so behavioral verification never runs an unvalidated script.
  const steps = Array.isArray(probeSteps) && probeSteps.length
    ? probeSteps.slice(0, 12).map((s) => ({
        args: (s && typeof s === "object" && !Array.isArray(s) && s.args && typeof s.args === "object") ? s.args : {},
        expectOk: s?.expectOk === true,
        ...(s?.expectContains != null ? { expectContains: String(s.expectContains).slice(0, 200) } : {}),
        ...(s?.label != null ? { label: String(s.label).slice(0, 60) } : {}),
      }))
    : null
  if (steps && !steps.length) blocked.push("probeSteps must be a non-empty array of {args, expectOk?, expectContains?, label?}")

  const life = loadToolLife(cwd)
  const existing = life.tools[id]
  if (existing && existing.lifecycle === TOOL_LIFE.ACTIVE) blocked.push("an ACTIVE tool with this name exists — version it (name_v2) instead of replacing")
  if (blocked.length) return { ok: false, blocked }

  life.tools[id] = {
    name: id,
    version: existing ? (existing.version ?? 1) + 1 : 1,
    lifecycle: TOOL_LIFE.CANDIDATE,
    description: desc.slice(0, 200),
    inputSchema: inSchema,
    outputSchema: outSchema,
    capabilities: (Array.isArray(capabilities) ? capabilities : []).map((c) => String(c).slice(0, 40)).slice(0, 6),
    ...(steps ? { probeSteps: steps } : {}),
    provenance: {
      source: "created",
      author: String(author).slice(0, 60),
      task: String(task ?? "").slice(0, 400),
      relatedFiles: (Array.isArray(relatedFiles) ? relatedFiles : []).map((f) => String(f).slice(0, 160)).slice(0, 8),
      createdAt: Date.now(),
    },
    tests: null,
    verification: null,
    updated: Date.now(),
  }
  saveToolLife(cwd, life)
  return { ok: true, name: id, lifecycle: TOOL_LIFE.CANDIDATE, record: life.tools[id] }
}

// ---------------------------------------------------------------------------
// 2. IMPLEMENT — generate the isolated plugin from the declared design
// ---------------------------------------------------------------------------

/** The generated plugin body: schema-checked input, declared operation,
 *  schema-shaped output. Read-only, bounded, isolated. */
function generatedToolSrc(record) {
  const safe = JSON.stringify({
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    outputType: record.outputSchema.type,
    capabilities: record.capabilities,
    provenance: record.provenance,
  }, null, 2)
  return `/** forge created tool — generated, isolated, read-only. Performs a bounded local search; it does not echo metadata. */
import fs from "node:fs"
import path from "node:path"
const DESIGN = ${safe}
const REQUIRED = ${JSON.stringify(record.inputSchema.required ?? [])}
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".forge", ".venv", "venv"])
function walk(cwd, needle, hits, dir, depth) {
  if (depth > 6 || hits.length >= 12) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (hits.length >= 12) return
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(cwd, needle, hits, p, depth + 1); continue }
    if (!e.isFile()) continue
    let txt = ""
    try {
      const st = fs.statSync(p)
      if (st.size > 200000) continue
      txt = fs.readFileSync(p, "utf8")
    } catch { continue }
    const i = txt.toLowerCase().indexOf(needle)
    if (i < 0) continue
    const rel = path.relative(cwd, p)
    const line = txt.slice(Math.max(0, i - 40), i + needle.length + 80).replace(/\\s+/g, " ")
    hits.push(rel + ": " + line.slice(0, 140))
  }
}
export default {
  name: DESIGN.name,
  description: DESIGN.description + " (created tool v" + ${record.version} + ")",
  parameters: DESIGN.inputSchema,
  readOnly: true,
  timeoutMs: 8000,
  async run(args) {
    const a = (args && typeof args === "object") ? args : {}
    for (const k of REQUIRED) if (a[k] == null) return "ERROR: missing required argument: " + k
    const q = String(a.query || a.pattern || a.text || DESIGN.capabilities[0] || DESIGN.name || "").toLowerCase().slice(0, 80)
    if (!q) return "ERROR: missing query"
    const hits = []
    walk(process.cwd(), q, hits, process.cwd(), 0)
    if (!hits.length) return DESIGN.name + ": 0 local hits for " + q
    return hits.join("\\n")
  },
}
`
}

/** Write the implementation for a CANDIDATE (or re-implement a failed one). */
export function implementTool(cwd, name) {
  const life = loadToolLife(cwd)
  const rec = life.tools[name]
  if (!rec) return { ok: false, blocked: ["not found: no CANDIDATE with that name (design first)"] }
  if (rec.lifecycle === TOOL_LIFE.ACTIVE) return { ok: false, blocked: ["ACTIVE tools are immutable — design a _v2 instead"] }
  // the design name is already NAME_RE-validated (safe filename); the
  // task-slugger is for free-text tasks, not for designed tool names
  const file = path.join(toolsDir(cwd), `${name}.mjs`)
  try {
    fs.mkdirSync(toolsDir(cwd), { recursive: true })
    writeStateFile(file, generatedToolSrc(rec), { mode: 0o600 })
  } catch (e) {
    return { ok: false, blocked: [`write failed: ${String(e?.message ?? e).slice(0, 120)}`] }
  }
  rec.file = path.basename(file)
  rec.lifecycle = TOOL_LIFE.TESTING
  rec.updated = Date.now()
  saveToolLife(cwd, life)
  return { ok: true, name, file, lifecycle: TOOL_LIFE.TESTING }
}

// ---------------------------------------------------------------------------
// 3. BEHAVIORAL VERIFY — run the REAL plugin in a REAL child process
// ---------------------------------------------------------------------------

function outputMatches(output, schema) {
  const t = schema.type
  if (t === "string") return typeof output === "string" && output.length > 0
  if (t === "object") return output && typeof output === "object" && !Array.isArray(output)
  if (t === "array") return Array.isArray(output)
  return false
}

/**
 * §20 behavioral verification: import the generated plugin in a child node
 * process, run it with sample args, and OBSERVE the result. Evidence: exit
 * code, stderr, elapsed ms, and whether the output matched the declared
 * output schema. Exit 0 alone is NOT enough; a mismatch stays INACTIVE.
 *
 * v94 todowise — MULTI-STEP SCRIPTED PROBES (the TODO.md contract): tools with
 * real sequences (login → act → verify) could not be promotion-tested by one
 * schema-shaped probe. When a probe script is present (`opts.steps` or the
 * record's design-time `probeSteps`), the child imports the plugin ONCE and
 * runs every step's args IN ORDER in the SAME process — module state survives
 * across steps, exactly like real usage. Every step is judged on its own
 * observed output: schema match, `expectOk` (output.ok === true), and
 * `expectContains` (substring in the serialized output). A step that throws
 * aborts the sequence (later steps may depend on it). `passed` requires exit
 * 0, no timeout, and ALL steps green. No script → the original single-probe
 * behavior, byte-for-byte.
 */
export async function verifyTool(cwd, name, { args = {}, steps = null, timeoutMs = 10000 } = {}) {
  const life = loadToolLife(cwd)
  const rec = life.tools[name]
  if (!rec) return { ok: false, blocked: ["not found"] }
  if (!rec.file) return { ok: false, blocked: ["not implemented (implementTool first)"] }
  const file = path.join(toolsDir(cwd), rec.file)

  // the probe script: explicit override, else the design-time declaration
  const script = Array.isArray(steps) && steps.length
    ? steps.slice(0, 12).map((s) => ({
      args: (s && typeof s === "object" && !Array.isArray(s) && s.args && typeof s.args === "object") ? s.args : {},
      expectOk: s?.expectOk === true,
      ...(s?.expectContains != null ? { expectContains: String(s.expectContains).slice(0, 200) } : {}),
      ...(s?.label != null ? { label: String(s.label).slice(0, 60) } : {}),
    }))
    : (Array.isArray(rec.probeSteps) && rec.probeSteps.length ? rec.probeSteps : null)

  const runner = path.join(projectDir(cwd), `.verify-${name}-${Date.now()}.mjs`)
  const perStepMs = Math.min(timeoutMs, 8000)
  const runnerSrc = script
    ? [
      `const mod = await import(${JSON.stringify("file://" + file)});`,
      `const p = mod.default;`,
      `if (!p || typeof p.run !== "function") { console.error("no run() exported"); process.exit(3); }`,
      `const steps = ${JSON.stringify(script.map((s) => s.args))};`,
      `const results = [];`,
      `for (const [i, sArgs] of steps.entries()) {`,
      `  const t0 = Date.now();`,
      `  try {`,
      `    let timer = null;`,
      `    const out = await Promise.race([p.run(sArgs), new Promise((_, rj) => { timer = setTimeout(() => rj(new Error("timeout in run() step " + i)), ${perStepMs}) })]);`,
      `    clearTimeout(timer);`,
      `    results.push({ ok: true, ms: Date.now() - t0, out });`,
      `  } catch (e) {`,
      `    results.push({ ok: false, error: String(e?.message ?? e) });`,
      `    break; // a failed step aborts the sequence — later steps may depend on it`,
      `  }`,
      `}`,
      `process.stdout.write("__FORGE_STEPS__" + JSON.stringify(results));`,
      `if (results.some((r) => !r.ok)) process.exit(2);`,
    ].join("\n")
    : [
      `const mod = await import(${JSON.stringify("file://" + file)});`,
      `const p = mod.default;`,
      `if (!p || typeof p.run !== "function") { console.error("no run() exported"); process.exit(3); }`,
      `const t0 = Date.now();`,
      `try {`,
      `  let timer = null;`,
      `  const out = await Promise.race([p.run(${JSON.stringify(args)}), new Promise((_, rj) => { timer = setTimeout(() => rj(new Error("timeout in run()")), ${perStepMs}) })]);`,
      `  clearTimeout(timer);`,
      `  process.stdout.write("__FORGE_OUT__" + JSON.stringify(out));`,
      `  if (Date.now() - t0 > ${perStepMs}) process.exit(4);`,
      `} catch (e) { console.error(String(e?.message ?? e)); process.exit(2); }`,
    ].join("\n")
  try {
    fs.writeFileSync(runner, runnerSrc, { mode: 0o600 })
    const t0 = Date.now()
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] })
      let out = "", err = ""
      const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} resolve({ code: null, timedOut: true, out, err }) }, timeoutMs)
      child.stdout.on("data", (d) => { out += d })
      child.stderr.on("data", (d) => { err += d })
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut: false, out, err }) })
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, timedOut: false, out, err: String(e?.message ?? e) }) })
    })
    const ms = Date.now() - t0
    try { fs.rmSync(runner) } catch { }

    if (script) {
      // ---- multi-step evidence: judge every step's OBSERVED output ---------
      const raw = result.out.includes("__FORGE_STEPS__") ? result.out.slice(result.out.indexOf("__FORGE_STEPS__") + "__FORGE_STEPS__".length) : ""
      let observed = []
      try { observed = raw ? JSON.parse(raw) : [] } catch { observed = [] }
      const stepEvidence = script.map((s, i) => {
        const o = observed[i] ?? null
        const output = o?.ok ? o.out : null
        const serialized = output == null ? "" : (typeof output === "string" ? output : JSON.stringify(output))
        return {
          step: i + 1,
          label: s.label ?? `step ${i + 1}`,
          ran: Boolean(o),
          threw: o ? !o.ok : null,
          error: o && !o.ok ? String(o.error ?? "").slice(0, 160) : null,
          ms: o?.ms ?? null,
          matchedSchema: outputMatches(output, rec.outputSchema),
          expectOk: s.expectOk === true ? output?.ok === true : null,
          expectContains: s.expectContains != null ? serialized.includes(s.expectContains) : null,
          outputPreview: serialized.slice(0, 160) || null,
        }
      })
      const allRan = stepEvidence.length === script.length && stepEvidence.every((e) => e.ran && !e.threw)
      const allMatched = stepEvidence.every((e) => e.matchedSchema && (e.expectOk === null || e.expectOk === true) && (e.expectContains === null || e.expectContains === true))
      const passed = result.code === 0 && !result.timedOut && allRan && allMatched
      const evidence = {
        at: Date.now(), mode: "multi-step", steps: script.length, exitCode: result.code, timedOut: result.timedOut, ms,
        stderr: String(result.err ?? "").slice(0, 200),
        stepEvidence,
      }
      rec.verification = { passed, evidence }
      rec.tests = stepEvidence.map((e) => ({ name: `behavioral-step:${e.label}`, passed: e.ran && !e.threw && e.matchedSchema && (e.expectOk === null || e.expectOk === true) && (e.expectContains === null || e.expectContains === true), exitCode: result.code, matched: e.matchedSchema, ms: e.ms }))
      rec.lifecycle = passed ? TOOL_LIFE.VERIFIED : TOOL_LIFE.INACTIVE
      rec.updated = Date.now()
      saveToolLife(cwd, life)
      return { ok: passed, name, lifecycle: rec.lifecycle, evidence }
    }

    const rawOut = result.out.includes("__FORGE_OUT__") ? result.out.slice(result.out.indexOf("__FORGE_OUT__") + "__FORGE_OUT__".length) : ""
    let output = null
    try { output = rawOut ? JSON.parse(rawOut) : null } catch { output = rawOut || null }

    const evidence = {
      at: Date.now(), args, exitCode: result.code, timedOut: result.timedOut, ms,
      stderr: String(result.err ?? "").slice(0, 200),
      outputPreview: typeof output === "string" ? output.slice(0, 160) : JSON.stringify(output ?? null).slice(0, 200),
      outputMatchedSchema: outputMatches(output, rec.outputSchema),
    }
    const passed = result.code === 0 && !result.timedOut && evidence.outputMatchedSchema

    rec.verification = { passed, evidence }
    rec.tests = [{ name: "behavioral-run", passed, exitCode: result.code, matched: evidence.outputMatchedSchema, ms }]
    rec.lifecycle = passed ? TOOL_LIFE.VERIFIED : TOOL_LIFE.INACTIVE
    rec.updated = Date.now()
    saveToolLife(cwd, life)
    return { ok: passed, name, lifecycle: rec.lifecycle, evidence }
  } catch (e) {
    rec.verification = { passed: false, evidence: { error: String(e?.message ?? e).slice(0, 200) } }
    rec.lifecycle = TOOL_LIFE.INACTIVE
    saveToolLife(cwd, life)
    return { ok: false, name, lifecycle: TOOL_LIFE.INACTIVE, error: String(e?.message ?? e) }
  }
}

// ---------------------------------------------------------------------------
// 4. REGISTER/ACTIVATE — VERIFIED only, never automatic
// ---------------------------------------------------------------------------

export function activateTool(cwd, name) {
  const life = loadToolLife(cwd)
  const rec = life.tools[name]
  if (!rec) return { ok: false, blocked: ["not found"] }
  if (rec.lifecycle === TOOL_LIFE.ACTIVE) return { ok: true, already: true, name }
  // VERIFIED activates directly. INACTIVE re-activates ONLY when its
  // behavioral verification still passes on record (deactivation is a
  // toggle, not a revocation — removing the record is the revocation).
  const reactivatable = rec.lifecycle === TOOL_LIFE.INACTIVE && rec.verification?.passed === true
  if (rec.lifecycle !== TOOL_LIFE.VERIFIED && !reactivatable) {
    return { ok: false, blocked: [`lifecycle ${rec.lifecycle} — only VERIFIED tools (or INACTIVE with passing behavioral verification) may activate`] }
  }
  if (rec.verification?.passed !== true) return { ok: false, blocked: ["no passing behavioral verification on record"] }
  rec.lifecycle = TOOL_LIFE.ACTIVE
  rec.activatedAt = Date.now()
  rec.updated = Date.now()
  saveToolLife(cwd, life)
  return { ok: true, name, lifecycle: TOOL_LIFE.ACTIVE, file: rec.file }
}

export function deactivateTool(cwd, name) {
  const life = loadToolLife(cwd)
  const rec = life.tools[name]
  if (!rec) return { ok: false, blocked: ["not found"] }
  if (rec.lifecycle !== TOOL_LIFE.ACTIVE) return { ok: false, blocked: [`lifecycle ${rec.lifecycle} — not active`] }
  rec.lifecycle = TOOL_LIFE.INACTIVE
  rec.updated = Date.now()
  saveToolLife(cwd, life)
  return { ok: true, name, lifecycle: TOOL_LIFE.INACTIVE }
}

export function listToolLife(cwd = process.cwd()) {
  const life = loadToolLife(cwd)
  return Object.values(life.tools).map((r) => ({
    name: r.name, lifecycle: r.lifecycle, version: r.version,
    verified: r.verification?.passed === true, description: r.description,
  }))
}

/**
 * The REAL registration consumer: load ACTIVE created tools as agent
 * plugins. Only lifecycle ACTIVE with passing verification is loaded — a
 * CANDIDATE/TESTING/INACTIVE tool NEVER reaches the agent (§19 "never
 * register an unverified tool as production-active").
 */
export async function loadActiveCreatedTools(cwd = process.cwd()) {
  const life = loadToolLife(cwd)
  const out = []
  for (const rec of Object.values(life.tools ?? {})) {
    if (rec.lifecycle !== TOOL_LIFE.ACTIVE || rec.verification?.passed !== true || !rec.file) continue
    try {
      const mod = await import(`file://${path.join(toolsDir(cwd), rec.file)}`)
      const p = mod.default
      if (p && typeof p.run === "function") {
        out.push({
          ...p,
          // the plugin `.def` shape makeToolContext/tools.js consumes
          def: { type: "function", function: { name: p.name, description: String(p.description ?? rec.description).slice(0, 200), parameters: p.parameters ?? { type: "object", properties: {} } } },
          readOnly: p.readOnly !== false,
          source: "created-tool (project-local, behaviorally verified)",
          created: true,
          provenance: rec.provenance,
        })
      }
    } catch { /* a broken generated tool is skipped, never breaks the agent */ }
  }
  return out
}

const MICRO_KLASS = new Set(["MICRO", "SMALL", "trivial", "simple"])

export function toolNameFor(capability) {
  const slug = String(capability || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36)
  const name = `x_${slug || "cap"}`.slice(0, 40)
  return NAME_RE.test(name) ? name : "x_cap"
}

/**
 * Create a tool for a REAL gap only when justified.
 * MICRO never. A single miss never permanently creates. Existing ACTIVE
 * that already declares the capability is reused.
 */
export async function createForGap({
  cwd = process.cwd(),
  capability = "",
  task = "",
  klass = "LARGE",
  force = false,
} = {}) {
  const cap = String(capability || "").trim()
  if (!cap) return { ok: false, skipped: "no capability" }
  if (!force && MICRO_KLASS.has(klass)) return { ok: false, skipped: "MICRO/SMALL never creates tools" }
  if (!force && !gapRepeats({ cwd, capability: cap, klass })) {
    return { ok: false, skipped: "single miss does not justify creation — need a repeated gap" }
  }
  const life = loadToolLife(cwd)
  const existing = Object.values(life.tools || {}).find((t) =>
    t.lifecycle === TOOL_LIFE.ACTIVE && t.verification?.passed === true
    && (t.name === toolNameFor(cap) || (Array.isArray(t.capabilities) && t.capabilities.includes(cap)))
  )
  if (existing) return { ok: true, reused: true, name: existing.name, lifecycle: TOOL_LIFE.ACTIVE }

  const name = toolNameFor(cap)
  const designed = designTool({
    cwd, name,
    description: `created for missing capability ${cap}`.slice(0, 200),
    task: String(task || cap).slice(0, 400),
    capabilities: [cap],
    author: "forge-createwise",
  })
  if (!designed.ok) return designed
  const impl = implementTool(cwd, name)
  if (!impl.ok) return impl
  const ver = await verifyTool(cwd, name)
  if (!ver.ok) {
    try { recordCapOutcome({ cwd, name, kind: "created", klass, ok: false, why: "behavioral verify failed" }) } catch { /* stats */ }
    return { ok: false, name, lifecycle: ver.lifecycle, skipped: "behavioral verify failed", evidence: ver.evidence }
  }
  const act = activateTool(cwd, name)
  if (!act.ok) return act
  try { recordCapOutcome({ cwd, name, kind: "created", klass, ok: true, why: "verified and activated" }) } catch { /* stats */ }
  return { ok: true, created: true, name, lifecycle: TOOL_LIFE.ACTIVE, version: loadToolLife(cwd).tools[name]?.version }
}

/** Record a gap; if it has repeated for this class, create. MICRO never. */
export async function considerCreateForGaps({ cwd, gaps = [], task = "", klass = "LARGE" } = {}) {
  const list = (Array.isArray(gaps) ? gaps : []).filter(Boolean).slice(0, 3)
  const out = []
  for (const cap of list) {
    try { noteCapabilityGap({ cwd, capability: cap, klass }) } catch { /* observation */ }
    const r = await createForGap({ cwd, capability: cap, task, klass })
    out.push({ capability: cap, ...r })
  }
  return out
}

export function createdWithheld(cwd, name, { klass = "", named = false } = {}) {
  try {
    return shouldWithhold(loadCapLearn(cwd), { name, kind: "created", klass, named })
  } catch { return false }
}
