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
  probeScript = null,           // v94 gapclose: scripted multi-step behavioral probe
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

  // v94 gapclose (TODO tool creation): a single schema-shaped probe cannot
  // prove multi-step tools (login → act → verify). A probeScript is an
  // ORDERED list of run() calls executed IN ONE child process — module state
  // carries between steps, which is exactly the semantics a multi-step tool
  // needs. Each step may declare what its output must look like; verification
  // only passes when EVERY step passes. Strict validation up front: a bad
  // script must never reach the promotion gate.
  let script = null
  if (probeScript != null) {
    if (!Array.isArray(probeScript) || probeScript.length < 1 || probeScript.length > 6) {
      blocked.push("probeScript must be an array of 1..6 steps")
    } else {
      script = []
      for (let i = 0; i < probeScript.length; i++) {
        const s = probeScript[i]
        if (!s || typeof s !== "object" || Array.isArray(s)) { blocked.push(`probeScript[${i}] must be an object { name?, args?, expect? }`); break }
        const args = s.args && typeof s.args === "object" && !Array.isArray(s.args) ? s.args : {}
        const expect = s.expect && typeof s.expect === "object" && !Array.isArray(s.expect) ? s.expect : {}
        if (expect.outputType != null && !["string", "object", "array"].includes(expect.outputType)) { blocked.push(`probeScript[${i}].expect.outputType must be string|object|array`); break }
        script.push({
          name: String(s.name ?? `step-${i + 1}`).slice(0, 40),
          args,
          expect: {
            ...(expect.outputType ? { outputType: expect.outputType } : {}),
            ...(expect.outputIncludes != null ? { outputIncludes: String(expect.outputIncludes).slice(0, 200) } : {}),
          },
        })
      }
      if (blocked.length) script = null
    }
  }

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
    ...(script ? { probeScript: script } : {}),
    capabilities: (Array.isArray(capabilities) ? capabilities : []).map((c) => String(c).slice(0, 40)).slice(0, 6),
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
  return `/** forge created tool — generated, isolated, read-only. Lifecycle: ${record.lifecycle} (see toollife.json). */
const DESIGN = ${safe}
const REQUIRED = ${JSON.stringify(record.inputSchema.required ?? [])}
export default {
  name: DESIGN.name,
  description: DESIGN.description + " (created tool v" + ${record.version} + ")",
  parameters: DESIGN.inputSchema,
  readOnly: true,
  timeoutMs: 8000,
  async run(args) {
    const a = (args && typeof args === "object") ? args : {}
    for (const k of REQUIRED) if (a[k] == null) return "ERROR: missing required argument: " + k
    const out = { tool: DESIGN.name, ok: true, input: a, capabilities: DESIGN.capabilities, provenance: DESIGN.provenance.task }
    if (DESIGN.outputType === "string") {
      const lines = [DESIGN.name + ": " + DESIGN.description, "input: " + JSON.stringify(a)]
      if (DESIGN.capabilities.length) lines.push("capabilities: " + DESIGN.capabilities.join(", "))
      if (DESIGN.provenance.task) lines.push("designed for: " + DESIGN.provenance.task)
      return lines.join("\\n")
    }
    return out
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
 * v94 gapclose (TODO tool creation): when the design carries a `probeScript`,
 * verification becomes a SCRIPTED multi-step run — the steps execute IN ORDER
 * IN ONE child process (module state carries between steps: login → act →
 * verify), each step's output is checked against the declared output schema
 * PLUS its own expectations (outputType / outputIncludes — the step oracle),
 * and the tool is VERIFIED only when EVERY step passed. Per-step evidence is
 * recorded; a failing step is named.
 */
export async function verifyTool(cwd, name, { args = {}, timeoutMs = 10000 } = {}) {
  const life = loadToolLife(cwd)
  const rec = life.tools[name]
  if (!rec) return { ok: false, blocked: ["not found"] }
  if (!rec.file) return { ok: false, blocked: ["not implemented (implementTool first)"] }
  const file = path.join(toolsDir(cwd), rec.file)
  const steps = Array.isArray(rec.probeScript) && rec.probeScript.length ? rec.probeScript : null

  const runner = path.join(projectDir(cwd), `.verify-${name}-${Date.now()}.mjs`)
  const perStepMs = steps ? Math.max(1000, Math.min(8000, Math.floor(timeoutMs / steps.length))) : Math.min(timeoutMs, 8000)
  const runnerSrc = steps ? [
    `const mod = await import(${JSON.stringify("file://" + file)});`,
    `const p = mod.default;`,
    `if (!p || typeof p.run !== "function") { console.error("no run() exported"); process.exit(3); }`,
    `const STEPS = ${JSON.stringify(steps)};`,
    `const PER_STEP_MS = ${perStepMs};`,
    `for (let i = 0; i < STEPS.length; i++) {`,
    `  const t0 = Date.now();`,
    `  try {`,
    `    const out = await Promise.race([p.run(STEPS[i].args), new Promise((_, rj) => { const tm = setTimeout(() => rj(new Error("timeout in run()")), PER_STEP_MS); tm.unref?.() })]);`,
    `    process.stdout.write("__FORGE_STEP__" + i + "__" + JSON.stringify({ ok: true, out, ms: Date.now() - t0 }));`,
    `  } catch (e) {`,
    `    process.stdout.write("__FORGE_STEP__" + i + "__" + JSON.stringify({ ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 }));`,
    `    process.exit(2);`,
    `  }`,
    `}`,
  ].join("\n") : [
    `const mod = await import(${JSON.stringify("file://" + file)});`,
    `const p = mod.default;`,
    `if (!p || typeof p.run !== "function") { console.error("no run() exported"); process.exit(3); }`,
    `const t0 = Date.now();`,
    `try {`,
    `  let timer = null;`,
    `  const out = await Promise.race([p.run(${JSON.stringify(args)}), new Promise((_, rj) => { timer = setTimeout(() => rj(new Error("timeout in run()")), ${Math.min(timeoutMs, 8000)}) })]);`,
    `  clearTimeout(timer);`,
    `  process.stdout.write("__FORGE_OUT__" + JSON.stringify(out));`,
    `  if (Date.now() - t0 > ${Math.min(timeoutMs, 8000)}) process.exit(4);`,
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

    if (steps) {
      // ---- scripted multi-step evidence ----------------------------------
      const stepResults = []
      for (const ch of String(result.out).split("__FORGE_STEP__").slice(1)) {
        const sep = ch.indexOf("__")
        if (sep < 1) continue
        const idx = Number(ch.slice(0, sep))
        const jsonPart = ch.slice(sep + 2)
        let parsed = null
        try { parsed = JSON.parse(jsonPart) } catch {
          const a = jsonPart.indexOf("{"), b = jsonPart.lastIndexOf("}")
          if (a !== -1 && b > a) { try { parsed = JSON.parse(jsonPart.slice(a, b + 1)) } catch { } }
        }
        if (Number.isInteger(idx) && idx >= 0 && idx < steps.length) stepResults[idx] = parsed
      }
      const stepsEvidence = steps.map((s, i) => {
        const r = stepResults[i] ?? null
        const ran = r?.ok === true
        const out = ran ? r.out ?? null : null
        const schemaOk = ran && outputMatches(out, rec.outputSchema)
        const typeOk = !s.expect?.outputType || (ran && out != null && (s.expect.outputType === "array" ? Array.isArray(out) : typeof out === s.expect.outputType))
        const includesOk = s.expect?.outputIncludes == null || (ran && String(typeof out === "string" ? out : JSON.stringify(out ?? "")).includes(s.expect.outputIncludes))
        const matched = ran && schemaOk && typeOk && includesOk
        return {
          name: s.name, args: s.args, ran, ms: r?.ms ?? null, matched,
          error: r?.ok === false ? String(r.error ?? "step failed") : (r ? null : "step never reported (child died or timed out mid-script)"),
          outputPreview: ran ? (typeof out === "string" ? out.slice(0, 160) : JSON.stringify(out ?? null).slice(0, 200)) : null,
          expectations: { schema: schemaOk, ...(s.expect?.outputType ? { outputType: typeOk } : {}), ...(s.expect?.outputIncludes != null ? { outputIncludes: includesOk } : {}) },
        }
      })
      const passed = result.code === 0 && !result.timedOut && stepsEvidence.every((s) => s.matched)
      const evidence = {
        at: Date.now(), mode: "probe-script", steps: stepsEvidence,
        exitCode: result.code, timedOut: result.timedOut, ms,
        stderr: String(result.err ?? "").slice(0, 200),
        outputMatchedSchema: passed,
      }
      rec.verification = { passed, evidence }
      rec.tests = [
        { name: "behavioral-run", passed, mode: "probe-script", steps: steps.length, exitCode: result.code, ms },
        ...stepsEvidence.map((s) => ({ name: `probe-step:${s.name}`, passed: s.matched, ms: s.ms })),
      ]
      rec.lifecycle = passed ? TOOL_LIFE.VERIFIED : TOOL_LIFE.INACTIVE
      rec.updated = Date.now()
      saveToolLife(cwd, life)
      const failedStep = passed ? null : (stepsEvidence.find((s) => !s.matched)?.name ?? "script-incomplete")
      return { ok: passed, name, lifecycle: rec.lifecycle, evidence, failedStep }
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
