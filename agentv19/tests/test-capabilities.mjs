#!/usr/bin/env node
/**
 * forge — capability registry checks (v20.5 tool intelligence layer).
 *
 * Covers: metadata completeness for every built-in, the read/write invariant
 * against tools.js WRITE_TOOLS (regression compatibility), capability lookup
 * and ordering, lifecycle status (enabled/disabled/deprecated/experimental),
 * plugin discovery/registration, and OPERATION-level risk classification —
 * which must come from the real safety engine, not from a table of names.
 *
 * Zero network, zero writes outside a temp dir.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createRegistry, defaultRegistry, registerPlugins, BUILTIN_CAPABILITIES,
  operationRisk, classifyCall, checkWriteClassification, costScore,
  RISK, RISK_ORDER, CLASS, STATUS, riskRank, maxRisk, riskAtLeast,
} from "../forge/capabilities.js"
import { WRITE_TOOLS, TOOL_DEFS } from "../forge/tools.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

const reg = defaultRegistry({})

console.log("== every shipped tool is registered, with complete metadata ==")
{
  const wire = TOOL_DEFS.map((t) => t.function.name).sort()
  const registered = reg.names().sort()
  ok(`all ${wire.length} wire tools are in the registry`, wire.every((n) => registered.includes(n)))
  ok("no registry entry without a wire tool", registered.every((n) => wire.includes(n)))
  ok("registry built without validation errors", reg.errors().length === 0)

  const REQUIRED = [
    "name", "description", "capabilities", "klass", "classes", "risk", "read_only", "reversible",
    "parallel_safe", "requires_confirmation", "requires_network", "requires_filesystem",
    "timeout", "cost", "verification_required", "preferred_for", "avoid_when", "idempotent", "status",
  ]
  const incomplete = []
  for (const m of reg.list()) for (const f of REQUIRED) if (m[f] === undefined || m[f] === null) incomplete.push(`${m.name}.${f}`)
  ok(`no missing metadata field${incomplete.length ? " — " + incomplete.slice(0, 6).join(", ") : ""}`, incomplete.length === 0)

  const badTypes = reg.list().filter(
    (m) =>
      !Array.isArray(m.capabilities) || !m.capabilities.length ||
      typeof m.read_only !== "boolean" || typeof m.parallel_safe !== "boolean" ||
      !RISK_ORDER.includes(m.risk) || typeof m.timeout !== "number" ||
      typeof m.cost !== "object" || typeof m.cost.latency !== "number"
  )
  ok(`every entry is well-typed${badTypes.length ? " — " + badTypes.map((m) => m.name).join(", ") : ""}`, badTypes.length === 0)
  ok("every entry has a description", reg.list().every((m) => m.description.length > 10))
  ok("mutating tools declare a verification contract", reg.list({ readOnly: false }).every((m) => m.verification_required === true || m.name === "bash"))
}

console.log("== READ/WRITE classification agrees with the shipped WRITE_TOOLS (§4, regression) ==")
{
  ok("no read/write disagreement with tools.js", checkWriteClassification(reg).length === 0)
  for (const n of ["bash", "write_file", "edit_file", "multi_edit", "apply_patch"]) {
    ok(`${n} is write-class`, reg.get(n).read_only === false && WRITE_TOOLS.has(n))
  }
  for (const n of ["read_file", "grep_files", "glob_files", "list_dir", "git_status", "delegate", "think"]) {
    ok(`${n} is read-only`, reg.get(n).read_only === true && !WRITE_TOOLS.has(n))
  }
  ok("delegate is read-only but NOT free (medium baseline risk)", reg.get("delegate").read_only === true && reg.get("delegate").risk === RISK.MEDIUM)
  ok("classes carry the execution class", reg.get("bash").classes.includes(CLASS.EXECUTE) && reg.get("fetch_url").classes.includes(CLASS.NETWORK))
}

console.log("== parallel safety metadata (§12) ==")
{
  ok("independent readers are parallel_safe", ["read_file", "grep_files", "glob_files", "list_dir"].every((n) => reg.get(n).parallel_safe))
  ok("no write tool is parallel_safe", reg.list({ readOnly: false }).every((m) => m.parallel_safe === false))
  ok("shared-state readers are NOT parallel_safe (todo, memory)", !reg.get("todo").parallel_safe && !reg.get("memory").parallel_safe)
}

console.log("== capability lookup + ordering (§2, §10) ==")
{
  const editors = reg.providersOf("code_modification").map((m) => m.name)
  ok("code_modification resolves to the edit tools", editors.includes("edit_file") && editors.includes("apply_patch"))
  ok("cheapest editor first", editors[0] === "edit_file")
  const search = reg.providersOf("content_search").map((m) => m.name)
  ok("grep beats delegate for content_search (cost)", search.indexOf("grep_files") < search.indexOf("delegate"))
  ok("unknown capability resolves to nothing", reg.providersOf("teleportation").length === 0)
  ok("availability filter is honoured", reg.providersOf("file_read", { available: ["grep_files"] }).length === 0)
  ok("costScore orders cheap before expensive", costScore(reg.get("read_file")) < costScore(reg.get("delegate")))
}

console.log("== lifecycle: enabled / disabled / deprecated / experimental (§19) ==")
{
  const r2 = createRegistry({ config: { tools: { disabled: ["web_search"], deprecated: ["list_dir"] } } })
  ok("configured tool is disabled", r2.get("web_search").status === STATUS.DISABLED)
  ok("router never sees a disabled tool", !r2.providersOf("web_search").some((m) => m.name === "web_search"))
  ok("deprecated status applied", r2.get("list_dir").status === STATUS.DEPRECATED)
  const disc = r2.providersOf("file_discovery").map((m) => m.name)
  ok("deprecated tool ranks last / is skipped when alternatives exist", disc[0] !== "list_dir")

  // a deprecated tool is still usable when nothing else provides the capability
  const r3 = createRegistry({ config: { tools: { deprecated: ["git_status"] } } })
  ok("deprecated tool is used when it is the only provider", r3.providersOf("vcs_inspection").map((m) => m.name)[0] === "git_status")

  const r4 = createRegistry({ config: {} })
  r4.register({ name: "beta_tool", description: "an experimental capability", capabilities: ["beta_capability"], status: STATUS.EXPERIMENTAL, read_only: true })
  ok("experimental tools are registered", r4.get("beta_tool").status === STATUS.EXPERIMENTAL)
  ok("experimental tools are routable by default", r4.providersOf("beta_capability").length === 1)
  const r5 = createRegistry({ config: { tools: { experimental: false } } })
  r5.register({ name: "beta_tool", description: "an experimental capability", capabilities: ["beta_capability"], status: STATUS.EXPERIMENTAL, read_only: true })
  ok("experimental tools are skipped when opted out", r5.providersOf("beta_capability").length === 0)

  ok("setStatus flips a tool at runtime", r4.setStatus("beta_tool", STATUS.DISABLED).ok && r4.get("beta_tool").status === STATUS.DISABLED)
  ok("setStatus rejects an unknown status", !r4.setStatus("beta_tool", "haunted").ok)
  ok("setStatus rejects an unknown tool", !r4.setStatus("nope", STATUS.DISABLED).ok)
}

console.log("== plugin discovery registers through the SAME system (§18) ==")
{
  const r = createRegistry({})
  const added = registerPlugins(r, [
    { name: "jira_issue", readOnly: true, source: "jira.mjs", def: { function: { description: "Fetch a Jira issue" } }, capabilities: ["issue_lookup"], requires_network: true },
    { name: "deploy_app", readOnly: false, source: "deploy.mjs", def: { function: { description: "Deploy the app" } }, risk: RISK.HIGH, requires_confirmation: true },
    { name: "no_name_tool_meta", readOnly: true, source: "x.mjs", def: { function: { description: "declares nothing" } } },
  ])
  ok("plugins are registered", added.length === 3 && r.has("jira_issue") && r.has("deploy_app"))
  ok("declared plugin capability is routable", r.providersOf("issue_lookup").map((m) => m.name)[0] === "jira_issue")
  ok("read-only plugin defaults are safe", r.get("jira_issue").read_only && r.get("jira_issue").parallel_safe && r.get("jira_issue").risk === RISK.LOW)
  ok("write plugin defaults are conservative", !r.get("deploy_app").read_only && !r.get("deploy_app").parallel_safe && r.get("deploy_app").verification_required)
  ok("plugin-declared risk is honoured", r.get("deploy_app").risk === RISK.HIGH && r.get("deploy_app").requires_confirmation === true)
  ok("a plugin without declared capabilities still gets one", r.get("no_name_tool_meta").capabilities.length === 1)
  ok("plugin source is recorded", r.get("jira_issue").source.startsWith("plugin:"))
  ok("core needs no change for a new tool (17 + 3)", r.size() === BUILTIN_CAPABILITIES.length + 3)
}

console.log("== unknown tools are treated conservatively ==")
{
  const m = reg.resolve("something_new")
  ok("resolve() never returns null", !!m)
  ok("unknown tool is write-class, not parallel-safe, needs verification", !m.read_only && !m.parallel_safe && m.verification_required)
  ok("unknown tool defaults to medium risk", m.risk === RISK.MEDIUM)
  ok("get() still reports it as unregistered", reg.get("something_new") === null)
}

console.log("== operation risk comes from the real operation, not the tool name (§5) ==")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cap-"))
  fs.writeFileSync(path.join(tmp, "exists.txt"), "hello")
  const ctx = { cwd: tmp, root: tmp, registry: reg }

  ok("read_file is LOW", operationRisk("read_file", { path: "x" }, ctx).risk === RISK.LOW)
  ok("grep_files is LOW", operationRisk("grep_files", { pattern: "x" }, ctx).risk === RISK.LOW)
  ok("bash echo is LOW", operationRisk("bash", { command: "echo hi" }, ctx).risk === RISK.LOW)
  ok("bash npm test is LOW/MEDIUM", riskRank(operationRisk("bash", { command: "npm test" }, ctx).risk) <= riskRank(RISK.MEDIUM))
  ok("bash git commit is MEDIUM", operationRisk("bash", { command: "git commit -m x" }, ctx).risk === RISK.MEDIUM)
  // npm install is `confirm` in shellguard (it mutates installed packages) —
  // the registry inherits that judgement instead of second-guessing it.
  ok("bash npm install is MEDIUM+ (shellguard: confirm)", riskAtLeast(operationRisk("bash", { command: "npm install left-pad" }, ctx).risk, RISK.MEDIUM))
  ok("bash rm -rf of a project dir is HIGH+", riskAtLeast(operationRisk("bash", { command: "rm -rf build" }, ctx).risk, RISK.HIGH))
  ok("bash rm -rf / is CRITICAL", operationRisk("bash", { command: "rm -rf /" }, ctx).risk === RISK.CRITICAL)
  ok("bash sudo is CRITICAL/HIGH", riskAtLeast(operationRisk("bash", { command: "sudo rm -rf /etc" }, ctx).risk, RISK.HIGH))
  ok("edit_file is MEDIUM", operationRisk("edit_file", { path: "a.js" }, ctx).risk === RISK.MEDIUM)
  ok("write_file (new file) is LOW", operationRisk("write_file", { path: "new.txt" }, ctx).risk === RISK.LOW)
  ok("write_file (overwrite) is MEDIUM", operationRisk("write_file", { path: "exists.txt" }, ctx).risk === RISK.MEDIUM)
  ok("apply_patch that deletes files is HIGH", operationRisk("apply_patch", { patch: "--- a/x\n+++ /dev/null\n" }, ctx).risk === RISK.HIGH)
  ok("apply_patch (edit only) is MEDIUM", operationRisk("apply_patch", { patch: "--- a/x\n+++ b/x\n" }, ctx).risk === RISK.MEDIUM)
  ok("network request is MEDIUM", operationRisk("fetch_url", { url: "https://example.com" }, ctx).risk === RISK.MEDIUM)
  ok("memory clear is MEDIUM, memory read is LOW", operationRisk("memory", { action: "clear" }, ctx).risk === RISK.MEDIUM && operationRisk("memory", { action: "read" }, ctx).risk === RISK.LOW)
  ok("risk carries a human reason", operationRisk("bash", { command: "rm -rf /" }, ctx).reasons.join(" ").length > 5)
  ok("shellguard level is passed through, not re-derived", operationRisk("bash", { command: "rm -rf /" }, ctx).level === "block")

  console.log("== call classification (§4) ==")
  ok("a read call is parallel-safe", classifyCall("read_file", { path: "exists.txt" }, ctx).parallel_safe === true)
  ok("a write call is not", classifyCall("edit_file", { path: "exists.txt" }, ctx).parallel_safe === false)
  ok("bash is EXECUTE class", classifyCall("bash", { command: "ls" }, ctx).klass === CLASS.EXECUTE)
  ok("mutation flag is set for writes", classifyCall("write_file", { path: "n.txt" }, ctx).mutation === true)
  ok("mutation flag is clear for reads", classifyCall("read_file", { path: "exists.txt" }, ctx).mutation === false)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log("== risk helpers ==")
{
  ok("riskRank orders levels", riskRank(RISK.LOW) < riskRank(RISK.MEDIUM) && riskRank(RISK.MEDIUM) < riskRank(RISK.HIGH) && riskRank(RISK.HIGH) < riskRank(RISK.CRITICAL))
  ok("maxRisk picks the worst", maxRisk(RISK.LOW, RISK.HIGH, RISK.MEDIUM) === RISK.HIGH)
  ok("riskAtLeast compares", riskAtLeast(RISK.HIGH, RISK.MEDIUM) && !riskAtLeast(RISK.LOW, RISK.MEDIUM))
  ok("unknown risk string is treated as medium rank", riskRank("banana") === riskRank(RISK.MEDIUM))
}

console.log(`\n== capabilities suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
