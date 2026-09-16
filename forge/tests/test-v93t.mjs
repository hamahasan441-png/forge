#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 9: TOOL CREATION pipeline (§19/§20).
 *
 *  1. DESIGN: metadata + provenance recorded; invalid designs blocked.
 *  2. IMPLEMENT: isolated generated plugin (read-only, bounded, project-local
 *     — ~/.forge/tools is NEVER touched).
 *  3. BEHAVIORAL VERIFY: the REAL plugin runs in a REAL child process; exit
 *     code + output-schema match + timeout are OBSERVED evidence. Exit 0
 *     with a schema mismatch is NOT a pass (→ INACTIVE).
 *  4. LIFECYCLE: CANDIDATE → TESTING → VERIFIED → ACTIVE; INACTIVE on
 *     failure; activation impossible without passing behavioral evidence.
 *  5. REGISTRATION: only ACTIVE+verified tools load for the agent (§19
 *     "never register an unverified tool as production-active") — proven
 *     end-to-end through runAgent's plugin load.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93t-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93t-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const tc = await import("../toolcreate.js")
const { projectDir } = await import("../memory.js")
const { learnedPluginsDir } = await import("../extend.js")

const DESIGN = {
  cwd: WORK,
  name: "deploy_probe",
  description: "probe the deploy endpoint of the staging service",
  task: "ops asked for a repeatable staging probe during the incident",
  inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
  outputSchema: { type: "string" },
  capabilities: ["http_probe", "staging"],
  relatedFiles: ["runbooks/deploy.md"],
}

// ---------------------------------------------------------------------------
console.log("== 1. DESIGN — metadata + provenance ==")
{
  const r = tc.designTool(DESIGN)
  ok("design accepted", r.ok === true, JSON.stringify(r.blocked ?? ""))
  eq("lifecycle is CANDIDATE", r.record.lifecycle, "CANDIDATE")
  ok("provenance carries source task + related files", r.record.provenance.task.includes("incident") && r.record.provenance.relatedFiles.includes("runbooks/deploy.md"))
  ok("schema + capabilities recorded", r.record.inputSchema.required[0] === "env" && r.record.capabilities.includes("http_probe"))

  const bad = tc.designTool({ cwd: WORK, name: "Bad Name!", description: "x", task: "t" })
  ok("invalid name blocked", bad.ok === false && bad.blocked.length >= 1)
  const bad2 = tc.designTool({ cwd: WORK, name: "shortdesc", description: "tiny", task: "t" })
  ok("too-short description blocked", bad2.ok === false)

  const life = JSON.parse(fs.readFileSync(path.join(projectDir(WORK), "toollife.json"), "utf8"))
  ok("toollife.json persisted under the project dir", life.tools.deploy_probe != null)
}

// ---------------------------------------------------------------------------
console.log("== 2. IMPLEMENT — isolated, project-local ==")
{
  const r = tc.implementTool(WORK, "deploy_probe")
  ok("implement accepted", r.ok === true, JSON.stringify(r.blocked ?? ""))
  eq("lifecycle is TESTING", r.lifecycle, "TESTING")
  const file = path.join(learnedPluginsDir(WORK), "deploy_probe.mjs")
  ok("the plugin file exists in the PROJECT-LOCAL tools dir", fs.existsSync(file))
  ok("the PRODUCTION dir ~/.forge/tools was NEVER written", !fs.existsSync(path.join(HOME, "tools")))
  const src = fs.readFileSync(file, "utf8")
  ok("generated tool is read-only + bounded", /readOnly: true/.test(src) && /timeoutMs: 8000/.test(src))
  ok("generated tool embeds the design metadata", /deploy_probe/.test(src) && /staging/.test(src))
  ok("kernel untouched (no forge core writes)", !fs.readdirSync(path.join(path.dirname(file))).some((f) => /forge\.js|agent\.js|core\.js/.test(f)))
}

// ---------------------------------------------------------------------------
console.log("== 3. BEHAVIORAL VERIFY — real child process, observed evidence ==")
{
  const r = await tc.verifyTool(WORK, "deploy_probe", { args: { env: "staging" } })
  ok("behavioral verification PASSED", r.ok === true, JSON.stringify(r.evidence ?? r))
  eq("lifecycle is VERIFIED", tc.readToolRecord(WORK, "deploy_probe").lifecycle, "VERIFIED")
  const ev = r.evidence
  ok("evidence: exit code observed", ev.exitCode === 0)
  ok("evidence: elapsed ms recorded", typeof ev.ms === "number" && ev.ms >= 0)
  ok("evidence: output matched the declared schema", ev.outputMatchedSchema === true)
  ok("evidence: output preview recorded", typeof ev.outputPreview === "string" && /deploy_probe/.test(ev.outputPreview))

  // a schema MISMATCH must fail even with exit 0
  //
  // v113 audit: this used to declare `string` and then patch the GENERATED
  // FILE's "outputType" field to "object". verifyTool compares the observed
  // output against the RECORD's outputSchema (toolcreate.js:382,
  // `outputMatches(output, rec.outputSchema)`), never the file's metadata — and
  // patching that field does not change what the tool returns either. So the
  // record still said string, the tool still returned a string, they matched,
  // and the assertion failed while the product was behaving correctly.
  //
  // The mismatch is forced where verifyTool actually looks — the record. The
  // tool is designed and implemented as a string tool (so the generated body
  // really does return a string), and only then is the RECORD's declared
  // outputSchema changed to object. Now the observed value and the declared
  // contract genuinely disagree, which is the condition under test.
  //
  // (Declaring `object` up front no longer produces a mismatch: v113 fixed the
  // generator to shape its result to the declared type, so an object tool
  // returns an object. That fix is covered in test-todowise.)
  tc.designTool({ cwd: WORK, name: "shape_bad", description: "string tool whose declared schema is later changed", task: "t", outputSchema: { type: "string" } })
  tc.implementTool(WORK, "shape_bad")
  const lifeFile = path.join(projectDir(WORK), "toollife.json")
  const life = JSON.parse(fs.readFileSync(lifeFile, "utf8"))
  life.tools.shape_bad.outputSchema = { type: "object" }
  fs.writeFileSync(lifeFile, JSON.stringify(life), "utf8")
  const r2 = await tc.verifyTool(WORK, "shape_bad", { args: {} })
  ok("exit 0 + schema MISMATCH → NOT verified (never a fake pass)", r2.ok === false, JSON.stringify(r2.evidence ?? {}))
  ok("the mismatch is what failed it, not the exit code",
    r2.evidence?.exitCode === 0 && r2.evidence?.outputMatchedSchema === false, JSON.stringify(r2.evidence ?? {}))
  eq("mismatching tool goes INACTIVE", tc.readToolRecord(WORK, "shape_bad").lifecycle, "INACTIVE")
  ok("mismatch evidence recorded", r2.evidence?.outputMatchedSchema === false)

  // a crashing tool goes INACTIVE with stderr evidence
  const d3 = tc.designTool({ cwd: WORK, name: "crashy", description: "a tool that throws on run", task: "t", outputSchema: { type: "string" } })
  void d3
  tc.implementTool(WORK, "crashy")
  const f3 = path.join(learnedPluginsDir(WORK), "crashy.mjs")
  fs.writeFileSync(f3, "export default { name: 'crashy', description: 'x', parameters: { type: 'object', properties: {} }, readOnly: true, async run() { throw new Error('boom on purpose') } }", "utf8")
  const r3 = await tc.verifyTool(WORK, "crashy", { args: {} })
  ok("crashing tool NOT verified", r3.ok === false)
  eq("crashing tool INACTIVE", tc.readToolRecord(WORK, "crashy").lifecycle, "INACTIVE")
  ok("stderr captured as evidence", /boom/.test(r3.evidence?.stderr ?? ""))
}

// ---------------------------------------------------------------------------
console.log("== 4. LIFECYCLE — activation gates ==")
{
  const blocked = tc.activateTool(WORK, "shape_bad")
  ok("INACTIVE tool cannot activate", blocked.ok === false && /VERIFIED/.test(blocked.blocked[0]))
  const act = tc.activateTool(WORK, "deploy_probe")
  ok("VERIFIED tool activates", act.ok === true)
  eq("lifecycle is ACTIVE", tc.readToolRecord(WORK, "deploy_probe").lifecycle, "ACTIVE")
  const again = tc.activateTool(WORK, "deploy_probe")
  ok("re-activation is idempotent", again.ok === true && again.already === true)

  // ACTIVE tools are immutable — a redesign must version
  const redesign = tc.designTool({ ...DESIGN, description: "a redesigned probe with more detail" })
  ok("redesign of an ACTIVE name is blocked (version instead)", redesign.ok === false, JSON.stringify(redesign.blocked))

  const deact = tc.deactivateTool(WORK, "deploy_probe")
  eq("deactivation works", tc.readToolRecord(WORK, "deploy_probe").lifecycle, "INACTIVE")
  tc.activateTool(WORK, "deploy_probe") // restore for the agent test

  const list = tc.listToolLife(WORK)
  ok("listToolLife shows every state honestly", list.some((t) => t.lifecycle === "ACTIVE") && list.some((t) => t.lifecycle === "INACTIVE"))
}

// ---------------------------------------------------------------------------
console.log("== 5. REGISTRATION — only ACTIVE+verified reach the agent (BEHAVIORAL) ==")
{
  // the loader picks up ONLY the ACTIVE deploy_probe
  const loaded = await tc.loadActiveCreatedTools(WORK)
  eq("exactly the ACTIVE tool loads", loaded.length, 1)
  eq("its name", loaded[0].name, "deploy_probe")
  ok("it carries created provenance", loaded[0].created === true)

  // deactivate → it stops loading (no unverified registration, ever)
  tc.deactivateTool(WORK, "deploy_probe")
  const loaded2 = await tc.loadActiveCreatedTools(WORK)
  eq("a deactivated tool no longer loads", loaded2.length, 0)
  tc.activateTool(WORK, "deploy_probe")

  // END-TO-END: runAgent's real plugin load includes the created ACTIVE tool
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /chat\/completions$/.test(req.url)) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        let sawCreated = false
        try { sawCreated = JSON.parse(body).tools?.some((t) => t.function?.name === "deploy_probe") } catch {}
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
          choices: [{ index: 0, message: { role: "assistant", content: sawCreated ? "created tool reached the provider" : "no created tool" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { runAgent } = await import("../agent.js")
  const events = []
  try {
    const r = await runAgent({
      config: { providers: {}, tools: {}, agent: { autonomous: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
      task: "check the tool surface",
      onEvent: (e) => events.push(e),
      journal: false,
    })
    ok("the run completed", r.status === "COMPLETED")
    ok("the ACTIVE created tool reached the provider's tool defs", /created tool reached/.test(r.text))
    ok("the agent logged the created tool load event", events.some((e) => e.type === "info" && /created tool loaded: deploy_probe/.test(e.text)))
    ok("INACTIVE tools never load (shape_bad/crashy absent)", !events.some((e) => /created tool loaded: (shape_bad|crashy)/.test(e.text ?? "")) && !/shape_bad|crashy/.test(r.text))
  } finally { server.close() }
}

console.log(`\n== v93t: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
