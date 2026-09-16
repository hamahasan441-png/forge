#!/usr/bin/env node
/**
 * forge — v104 "boundwise": the workspace boundary, enforced in CODE.
 *
 * v103 gave the runtime a workspace identity and told the MODEL about it. A
 * prompt line is guidance, not an invariant — so this suite is about the part
 * that has to hold whatever the model decides to do.
 *
 * THREE FINDINGS, each reproduced against the real tool layer before any code
 * was written:
 *
 *  1. TRAVERSAL WAS UNBOUNDED. `grep_files` pointed at $HOME scanned it for
 *     8.65 SECONDS; `list_dir "/"` walked bin/, boot/, dev/; `glob_files`
 *     listed a sibling directory's files. Nothing stopped any of it.
 *
 *  2. THE GUARD FLAG WAS NEVER READ. `allowOutsideProject` has been plumbed
 *     from config through agent.js and chat.js into every tool context since
 *     v21 — and `grep -n "ctx.allowOutsideProject" tools.js` returned nothing.
 *     A privilege flag whose guard was never implemented.
 *
 *  3. AND IT WAS GRANTED BY DEFAULT ANYWAY. agent.js read it as
 *     `unrestricted || config.tools?.allowOutsideProject === true`, and
 *     `unrestricted` ships TRUE (config.js:97) — so a user setting
 *     `allowOutsideProject: false` changed nothing. Found by running the real
 *     CLI from an external workspace AFTER the guard was added and watching it
 *     scan /root anyway: the fix was inert until that run.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v104-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

/** An EXTERNAL project, with a sibling tree that must stay out of reach. */
function makeWorkspace() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v104-parent-"))
  const work = path.join(parent, "acme-api")
  fs.mkdirSync(path.join(work, "src"), { recursive: true })
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"acme-api"}\n')
  fs.writeFileSync(path.join(work, "src", "handler.js"), "export function handler(){ return { ok: true } }\nconst NEEDLE = 1\n")
  fs.writeFileSync(path.join(parent, "sibling-secret.env"), "NEEDLE=hunter2\n")
  return { parent, work }
}

const { makeToolContext, traversalBoundary } = await import("../tools.js")
const { outsideWorkspace, resolveWorkspace } = await import("../workspace.js")

// ---------------------------------------------------------------------------
console.log("== 1. traversalBoundary: containment, not a guess ==")
{
  const { parent, work } = makeWorkspace()
  const ctx = { root: work, cwd: work }
  eq("the workspace itself is inside", traversalBoundary(ctx, work), null)
  eq("a subdirectory is inside", traversalBoundary(ctx, path.join(work, "src")), null)
  ok("the PARENT is outside", typeof traversalBoundary(ctx, parent) === "string")
  ok("the filesystem root is outside", typeof traversalBoundary(ctx, "/") === "string")
  ok("the home directory is outside", typeof traversalBoundary(ctx, os.homedir()) === "string")
  ok("the refusal names the boundary", /outside the workspace/.test(traversalBoundary(ctx, "/")))
  ok("...and the exact grant that lifts it", /tools\.allowOutsideProject true/.test(traversalBoundary(ctx, "/")))
  eq("an explicit grant lifts it", traversalBoundary({ ...ctx, allowOutsideTraversal: true }, "/"), null)
  eq("no root resolved → nothing to compare, never a false refusal", traversalBoundary({}, "/"), null)

  // a sibling whose path merely starts with the same characters is NOT inside
  const lookalike = `${work}-other`
  fs.mkdirSync(lookalike, { recursive: true })
  ok("a path-prefix lookalike is outside, not inside", typeof traversalBoundary(ctx, lookalike) === "string", lookalike)
}

console.log("== 2. the SCOPE grant is separate from the RISK master switch ==")
{
  // `unrestricted` ships true (config.js:97). Before this it implied
  // allowOutsideProject, so the user's own `false` was dead letter.
  const { defaultConfig } = await import("../config.js")
  const cfg = defaultConfig()
  ok("unrestricted really does ship true (the reason this matters)", cfg.tools?.unrestricted === true)
  eq("and allowOutsideProject ships false", cfg.tools?.allowOutsideProject, false)

  const work = makeWorkspace().work
  const t = makeToolContext({ cwd: work, root: work, allowOutsideProject: true, allowOutsideTraversal: false })
  eq("the RISK grant alone does NOT open traversal", typeof traversalBoundary(t.ctx, "/"), "string")
  const t2 = makeToolContext({ cwd: work, root: work, allowOutsideTraversal: true })
  eq("only the explicit SCOPE grant does", traversalBoundary(t2.ctx, "/"), null)
}

// ---------------------------------------------------------------------------
console.log("== 3. the REAL tool layer refuses to leave the workspace ==")
{
  const { parent, work } = makeWorkspace()
  const prev = process.cwd()
  process.chdir(work)
  try {
    const t = makeToolContext({ cwd: work, root: work, assumeYes: true, autonomous: true })
    const call = async (n, a) => String(await t.exec(n, a))

    // inside: everything still works exactly as before
    ok("grep INSIDE the workspace finds the needle", /NEEDLE/.test(await call("grep_files", { pattern: "NEEDLE", path: "." })))
    ok("list_dir INSIDE works", /handler\.js/.test(await call("list_dir", { path: "src" })))
    ok("glob INSIDE works", /handler\.js/.test(await call("glob_files", { pattern: "*.js", path: "src" })))

    // outside: refused, and FAST — the whole point is not doing the work
    for (const [label, name, args] of [
      ["grep the home directory", "grep_files", { pattern: "NEEDLE", path: os.homedir() }],
      ["grep the parent directory", "grep_files", { pattern: "NEEDLE", path: parent }],
      ["list the filesystem root", "list_dir", { path: "/" }],
      ["glob the parent directory", "glob_files", { pattern: "*.env", path: parent }],
    ]) {
      const t0 = Date.now()
      const r = await call(name, args)
      const ms = Date.now() - t0
      ok(`BLOCKED: ${label}`, r.startsWith("BLOCKED:"), r.slice(0, 90))
      ok(`  ...and refused without doing the work (${ms}ms)`, ms < 250, `${ms}ms`)
    }

    // the sibling secret is never disclosed by a search
    ok("a sibling secret is not reachable by globbing the parent",
      !/sibling-secret/.test(await call("glob_files", { pattern: "*", path: parent })))

    // with the explicit grant, the old behavior is back — unchanged, not crippled
    const g = makeToolContext({ cwd: work, root: work, assumeYes: true, autonomous: true, allowOutsideTraversal: true })
    ok("the explicit grant restores traversal outside", /sibling-secret/.test(String(await g.exec("glob_files", { pattern: "*", path: parent }))))
  } finally { process.chdir(prev) }
}

console.log("== 4. writes outside the workspace are reported, not silently taken ==")
{
  const { parent, work } = makeWorkspace()
  const ws = resolveWorkspace({ cwd: work, task: "add a version field" })
  eq("a file inside is inside", outsideWorkspace(ws, path.join(work, "src", "handler.js")), false)
  eq("a file in the parent is outside", outsideWorkspace(ws, path.join(parent, "sibling-secret.env")), true)
  eq("an unknown shell target is never guessed at", outsideWorkspace(ws, "(shell write)"), false)
  eq("no workspace → nothing to compare", outsideWorkspace(null, "/etc/passwd"), false)

  const { reviewRun } = await import("../review.js")
  const rev = reviewRun({
    klass: "SMALL", objective: "add a version field",
    records: [{ files_changed: ["/etc/evil.conf"] }],
    workspace: ws, outside: ["/etc/evil.conf"],
  })
  ok("an outside write earns a review even for a small task", rev.required === true)
  ok("and it is a BLOCKER", rev.blockers.some((b) => b.id === "writes_stay_in_workspace"), JSON.stringify(rev.blockers))
  ok("naming the file and the workspace", /etc\/evil\.conf/.test(rev.blockers.find((b) => b.id === "writes_stay_in_workspace").detail))

  const clean = reviewRun({ klass: "LARGE", objective: "x", records: [{ files_changed: ["src/a.js"] }], workspace: ws, outside: [] })
  ok("a run that stayed inside is not flagged",
    !clean.blockers.some((b) => b.id === "writes_stay_in_workspace"), JSON.stringify(clean.blockers))
}

// ---------------------------------------------------------------------------
console.log("== 5. the REAL agent, run from an EXTERNAL workspace ==")
{
  // forge's runtime lives elsewhere; every operation must happen in the
  // project, and the escape attempts must be refused by code, not by advice.
  const { runAgent } = await import("../agent.js")
  const { parent, work } = makeWorkspace()

  const script = [
    ["grep_files", { pattern: "NEEDLE", path: "." }],
    ["edit_file", { path: "src/handler.js", old: "ok: true", new: "ok: true, version: 2" }],
    ["bash", { command: "pwd" }],
    ["grep_files", { pattern: "NEEDLE", path: os.homedir() }],
    ["list_dir", { path: "/" }],
    ["glob_files", { pattern: "*.env", path: parent }],
  ]
  let n = 0
  const results = []
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      try {
        const msgs = JSON.parse(b).messages
        const last = msgs[msgs.length - 1]
        if (last?.role === "tool") results.push(String(last.content ?? ""))
      } catch { /* shape probes are not the assertion */ }
      const step = script[n++]
      const message = step
        ? { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { role: "assistant", content: "Done." }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  let res
  try {
    process.chdir(work)
    res = await runAgent({
      // the shipped defaults: unrestricted true, allowOutsideProject false
      //
      // v113 audit — cognition off here, deliberately. This section exercises
      // the TRAVERSAL BOUNDARY: the script drives grep/bash/read at paths
      // outside the workspace and counts the boundary's refusals. The governor
      // (v101) refuses those same calls first, for its own inspect-first
      // reasons, so the boundary was never reached and its three expected
      // refusals came back as zero — the layer under test stopped being
      // tested at all. Governor authority keeps its own coverage in
      // test-authority.mjs; the boundary needs the calls to actually arrive.
      config: { providers: {}, tools: { unrestricted: true, assumeYes: true }, agent: { autonomous: false, maxSteps: 12, verifyNudge: false, cognition: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task: "bump the handler version", journal: false,
    })
  } finally { process.chdir(prev); server.close() }

  const all = results.join("\n")
  ok("the in-workspace grep found the needle", /NEEDLE/.test(results[0] ?? ""), String(results[0] ?? "").slice(0, 80))
  ok("the edit landed in the EXTERNAL workspace",
    /ok: true, version: 2/.test(fs.readFileSync(path.join(work, "src", "handler.js"), "utf8")))
  ok("bash ran with the workspace as its cwd", results.some((r) => r.includes(work)), JSON.stringify(results.slice(0, 5).map((r) => r.slice(0, 40))))
  eq("exactly three escape attempts were refused", (all.match(/BLOCKED: .*outside the workspace/g) || []).length, 3)
  ok("nothing was written outside the workspace", (res.outsideWrites ?? []).length === 0, JSON.stringify(res.outsideWrites))
  ok("the resolved target is the external project, not forge's runtime",
    res.workspace?.targetWorkspace === fs.realpathSync(work) || res.workspace?.targetWorkspace === work, res.workspace?.targetWorkspace)
  ok("and forge's own runtime is still reported, separately", /forge/.test(String(res.workspace?.forgeRoot)))
}

console.log(`\n== v104 boundwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
