#!/usr/bin/env node
/**
 * forge — P0 true read-only mode.
 *
 * "readOnly" must mean: no file mutation, no persistent Forge-state mutation,
 * no plugin mutation, no configuration mutation. Before this suite, `memory`
 * (learn/append/replace), `todo` (write actions) and plugin tooling were
 * reachable from a read-only agent, and a read-only bash allow-list approved
 * `echo hi > file` purely because the prefix `echo` was on the list.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ro-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ro-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "keep.js"), "export const keep = 1\n")

const tools = await import("../forge/tools.js")
const { makeToolContext, isReadOnlyViolation, hasWriteRedirection, verificationAllows } = tools
const { loadToolPlugins } = await import("../forge/plugins.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const denied = (name, out) => ok(name, typeof out === "string" && /^BLOCKED/.test(out))

// write a plugin that would mutate a file if it were ever reachable
const pluginDir = path.join(HOME, "tools")
fs.mkdirSync(pluginDir, { recursive: true })
fs.writeFileSync(path.join(pluginDir, "evil.mjs"), `
import fsMod from "node:fs"
export default {
  name: "evil_tool",
  description: "mutates a file if it is ever reachable",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run(args) { fsMod.writeFileSync(args.path, "pwned"); return "wrote it" },
}
`)
const loaded = await loadToolPlugins(pluginDir)
const plugins = loaded.tools

const ctx = makeToolContext({
  cwd: WORK, root: WORK, timeoutSec: 5, maxToolOutput: 4000, plugins,
  memoryPath: path.join(HOME, "memory.md"), todoPath: path.join(HOME, "todo.json"),
  readOnly: true, skillsDir: null, searchUrl: "", signal: null,
})

console.log("== no FILE mutation ==")
{
  denied("write_file", await ctx.exec("write_file", { path: "a.js", content: "x" }))
  denied("edit_file", await ctx.exec("edit_file", { path: "keep.js", old: "1", new: "2" }))
  denied("multi_edit", await ctx.exec("multi_edit", { path: "keep.js", edits: [{ old: "1", new: "2" }] }))
  denied("apply_patch", await ctx.exec("apply_patch", { patch: "--- a/keep.js\n+++ b/keep.js\n@@ -1,1 +1,1 @@\n-1\n+2" }))
  denied("mutating bash", await ctx.exec("bash", { command: "rm -f keep.js" }))
  denied("install bash", await ctx.exec("bash", { command: "npm install lodash" }))
  denied("git commit", await ctx.exec("bash", { command: "git commit -m x" }))
  denied("redirection (echo >)", await ctx.exec("bash", { command: "echo hi > stolen.txt" }))
  denied("redirection (cat >)", await ctx.exec("bash", { command: "cat keep.js > copy.js" }))
  denied("redirection (printf >)", await ctx.exec("bash", { command: "printf x > y.js" }))
  denied("tee", await ctx.exec("bash", { command: "npm test | tee out.log" }))
  ok("nothing was written", !fs.existsSync(path.join(WORK, "stolen.txt")) && !fs.existsSync(path.join(WORK, "copy.js")))
  ok("existing file untouched", fs.readFileSync(path.join(WORK, "keep.js"), "utf8").includes("keep = 1"))
}

console.log("== no PERSISTENT STATE mutation (memory / todo) ==")
{
  denied("memory learn", await ctx.exec("memory", { action: "learn", text: "poison" }))
  denied("memory append", await ctx.exec("memory", { action: "append", text: "poison" }))
  denied("memory replace", await ctx.exec("memory", { action: "replace", text: "poison" }))
  denied("todo set", await ctx.exec("todo", { action: "set", items: [{ content: "x", status: "pending" }] }))
  denied("todo add", await ctx.exec("todo", { action: "add", item: { content: "x" } }))
  denied("todo toggle", await ctx.exec("todo", { action: "toggle", index: 0 }))
  const mem = await ctx.exec("memory", { action: "read" })
  ok("memory READ is allowed", typeof mem === "string" && !/^BLOCKED/.test(mem))
  const list = await ctx.exec("todo", { action: "list" })
  ok("todo LIST is allowed", typeof list === "string" && !/^BLOCKED/.test(list))
}

console.log("== no CONFIGURATION / PLUGIN mutation ==")
{
  denied("forge config set", await ctx.exec("bash", { command: "forge config set tools.assumeYes true" }))
  denied("write to config file", await ctx.exec("write_file", { path: ".forge/config.json", content: "{}" }))
  denied("plugin tool that mutates", await ctx.exec("evil_tool", { path: "pwned-by-plugin.txt" }))
  ok("plugin wrote nothing", !fs.existsSync(path.join(WORK, "pwned-by-plugin.txt")))
  ok("plugin tool is not exposed in read-only mode", !ctx.defs.some((t) => t.function.name === "evil_tool"))
}

console.log("== read + approved verification commands still work ==")
{
  const r = await ctx.exec("read_file", { path: "keep.js" })
  ok("read_file works", typeof r === "string" && r.includes("keep"))
  for (const cmd of ["npm test", "npm run build", "npx vitest run keep.test.js", "node --check keep.js", "tsc --noEmit", "npm run lint", "git status", "ls -la"]) {
    ok(`approved: ${cmd}`, isReadOnlyViolation("bash", { command: cmd }, true) === null)
  }
  for (const cmd of ["npm install x", "rm -rf .", "git push", "echo x > y", "cat a | tee b", "npm test > out.txt"]) {
    ok(`refused:  ${cmd}`, isReadOnlyViolation("bash", { command: cmd }, true) !== null)
  }
}

console.log("== redirection detection is precise ==")
{
  ok("echo > f", hasWriteRedirection("echo hi > f"))
  ok("append >> f", hasWriteRedirection("echo hi >> f"))
  ok("cat > f", hasWriteRedirection("cat a > b"))
  ok("tee", hasWriteRedirection("cat a | tee b"))
  ok("not: 2>&1", !hasWriteRedirection("npm test 2>&1"))
  ok("not: > /dev/null", !hasWriteRedirection("ls > /dev/null"))
  ok('not: quoted >', !hasWriteRedirection('node -e "console.log(2>1)"'))
  ok("not: plain command", !hasWriteRedirection("npm test"))
}

console.log("== a write-capable context still works (no over-blocking) ==")
{
  const rw = makeToolContext({
    cwd: WORK, root: WORK, timeoutSec: 5, maxToolOutput: 4000,
    memoryPath: path.join(HOME, "memory.md"), todoPath: path.join(HOME, "todo.json"),
    readOnly: false, skillsDir: null, searchUrl: "", signal: null,
  })
  const out = await rw.exec("write_file", { path: "allowed.js", content: "export const a = 1" })
  ok("write_file allowed when not read-only", typeof out === "string" && !/^BLOCKED/.test(out))
  ok("file exists", fs.existsSync(path.join(WORK, "allowed.js")))
  const mem = await rw.exec("memory", { action: "learn", text: "a durable fact" })
  ok("memory learn allowed when not read-only", typeof mem === "string" && !/^BLOCKED/.test(mem))
}

console.log("== the verifier tool set is enforced even in a write-capable ctx ==")
{
  ok("verificationAllows forbids write_file", verificationAllows("write_file", {}).ok === false)
  ok("verificationAllows forbids memory", verificationAllows("memory", { action: "learn" }).ok === false)
  ok("verificationAllows forbids todo", verificationAllows("todo", { action: "set" }).ok === false)
  ok("verificationAllows allows read_file", verificationAllows("read_file", { path: "a" }).ok === true)
  ok("verificationAllows allows approved bash", verificationAllows("bash", { command: "npm test" }).ok === true)
  ok("verificationAllows refuses mutating bash", verificationAllows("bash", { command: "npm install x" }).ok === false)
}

console.log(`\n== readonly-state suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
