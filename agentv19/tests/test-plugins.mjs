#!/usr/bin/env node
/**
 * forge — tool plugin loader checks (v20.2 P3-5): valid single/multi exports,
 * every rejection reason, def shape, readOnly flag, and that a loaded tool runs.
 * Temp plugin dir, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadToolPlugins, PLUGINS_DIR } from "../forge/plugins.js"
import { makeToolContext, BUILTIN_TOOL_NAMES } from "../forge/tools.js"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plugins-"))
const w = (name, body) => fs.writeFileSync(path.join(DIR, name), body)

w("good.mjs", `export default { name: "hello_tool", description: "says hi", parameters: { type: "object", properties: { who: { type: "string" } } }, readOnly: true, async run(a){ return "hi " + (a?.who ?? "world") } }`)
w("multi.mjs", `export const tools = [
  { name: "tool_a", description: "a", parameters: { type: "object", properties: {} }, run(){ return "A" } },
  { name: "tool_b", description: "b", parameters: { type: "object", properties: {} }, readOnly: true, run(){ return "B" } },
]`)
w("badname.mjs", `export default { name: "9bad name", description: "x", parameters: { type: "object", properties: {} }, run(){} }`)
w("collide.mjs", `export default { name: "bash", description: "x", parameters: { type: "object", properties: {} }, run(){} }`)
w("nodesc.mjs", `export default { name: "no_desc", description: "  ", parameters: { type: "object", properties: {} }, run(){} }`)
w("badparams.mjs", `export default { name: "bad_params", description: "x", parameters: { nope: true }, run(){} }`)
w("norun.mjs", `export default { name: "no_run", description: "x", parameters: { type: "object", properties: {} } }`)
w("noexport.mjs", `export const notATool = 1`)
w("throws.mjs", `throw new Error("boom at import")`)
w("ignored.txt", `not a module`)

const { tools, errors } = await loadToolPlugins(DIR, { reserved: ["bash", "read_file", "write_file"] })

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const names = tools.map((t) => t.name)
const errStr = errors.join("\n")

console.log("== valid tools load ==")
ok("single default export loaded", names.includes("hello_tool"))
ok("multi-export both loaded", names.includes("tool_a") && names.includes("tool_b"))
ok("exactly the 3 valid tools", tools.length === 3)
ok("def has wire shape", (() => { const t = tools.find((x) => x.name === "hello_tool"); return t.def.type === "function" && t.def.function.name === "hello_tool" && t.def.function.parameters.type === "object" })())
ok("readOnly flag preserved", tools.find((t) => t.name === "hello_tool").readOnly === true)
ok("default (no readOnly) is write-class", tools.find((t) => t.name === "tool_a").readOnly === false)

console.log("== a loaded tool runs ==")
ok("run() executes", await tools.find((t) => t.name === "hello_tool").run({ who: "forge" }) === "hi forge")

console.log("== every bad plugin is rejected with a reason ==")
ok("invalid name rejected", /badname\.mjs:.*invalid tool name/.test(errStr))
ok("built-in collision rejected", /collide\.mjs:.*collides with a built-in/.test(errStr))
ok("missing description rejected", /nodesc\.mjs:.*no description/.test(errStr))
ok("bad parameters rejected", /badparams\.mjs:.*parameters must be/.test(errStr))
ok("missing run rejected", /norun\.mjs:.*run must be a function/.test(errStr))
ok("no default export rejected", /noexport\.mjs:.*no default export/.test(errStr))
ok("import error captured (not thrown)", /throws\.mjs:.*import failed/.test(errStr))
ok("bad plugins did not load", !names.some((n) => ["9bad name", "bash", "no_desc", "bad_params", "no_run"].includes(n)))

console.log("== integration: makeToolContext + execTool ==")
{
  // a read-only plugin and a write-class plugin
  const roTool = tools.find((t) => t.name === "hello_tool")   // readOnly: true
  const wrTool = tools.find((t) => t.name === "tool_a")       // write-class
  // add a plugin whose output contains a secret to prove redaction runs
  const secretPlugin = { name: "leaky", readOnly: true, def: { type: "function", function: { name: "leaky", description: "d", parameters: { type: "object", properties: {} } } }, run: () => "token=sk-abcdef1234567890abcdef1234567890" }

  const full = makeToolContext({ cwd: DIR, root: DIR, plugins: [roTool, wrTool, secretPlugin] })
  ok("plugin defs exposed to the model", full.defs.some((d) => d.function.name === "hello_tool") && full.defs.some((d) => d.function.name === "leaky"))
  ok("plugin executes through execTool", (await full.exec("hello_tool", { who: "ctx" })) === "hi ctx")
  ok("plugin output is secret-redacted", !/sk-abcdef1234567890/.test(await full.exec("leaky", {})))
  ok("unknown tool still errors", String(await full.exec("nonexistent_xyz", {})).startsWith("ERROR: unknown tool"))

  // read-only context excludes write-class plugins, keeps read-only ones
  const ro = makeToolContext({ cwd: DIR, root: DIR, readOnly: true, plugins: [roTool, wrTool] })
  ok("read-only context hides write-class plugin", !ro.defs.some((d) => d.function.name === "tool_a"))
  ok("read-only context keeps read-only plugin", ro.defs.some((d) => d.function.name === "hello_tool"))
  ok("built-in names still reserved", BUILTIN_TOOL_NAMES.has("bash") && BUILTIN_TOOL_NAMES.has("read_file"))
}

console.log("== empty / missing dir ==")
ok("PLUGINS_DIR is defined", typeof PLUGINS_DIR === "string" && PLUGINS_DIR.length > 0)
const r = await loadToolPlugins(path.join(DIR, "does-not-exist"))
ok("missing dir → empty result, no throw", r.tools.length === 0 && r.errors.length === 0)

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== plugins suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
