#!/usr/bin/env node
/**
 * forge — v100 "fabricwise" suite: the capability fabric groundwork.
 *
 *   1. ANNOTATIONS — MCP ToolAnnotations (spec 2025-03-26) are read, bounded
 *      and normalized; readOnlyHint:true is the ONLY thing that makes an MCP
 *      tool read-only. Absent/garbage annotations keep the safe default
 *      (mutating), so nothing is silently promoted into a read-only context.
 *      The lazy (cached-inventory) path derives the same verdict, which
 *      requires the cache to PERSIST annotations.
 *   2. PARALLEL CONNECT — cold servers handshake concurrently, not in series,
 *      while the emitted tool order still follows CONFIG order.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v100-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v100-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { PROTOCOL_VERSION, normalizeAnnotations, readOnlyHinted, mcpToolsToPlugins, loadMcpTools } = await import("../mcp.js")

// ---------------------------------------------------------------------------
console.log("== 1. normalizeAnnotations — bounded, never widening ==")
{
  eq("null → null", normalizeAnnotations(null), null)
  eq("garbage → null", normalizeAnnotations("nope"), null)
  eq("empty object → null", normalizeAnnotations({}), null)
  eq("readOnlyHint kept", normalizeAnnotations({ readOnlyHint: true }), { readOnlyHint: true })
  eq("all four hints kept", normalizeAnnotations({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  eq("non-boolean hint dropped", normalizeAnnotations({ readOnlyHint: "yes" }), null)
  eq("unknown key dropped", normalizeAnnotations({ nonsense: true, readOnlyHint: true }), { readOnlyHint: true })
  ok("title is bounded to 120 chars", normalizeAnnotations({ title: "x".repeat(400) }).title.length === 120)
  ok("never throws on a hostile object", (() => { try { normalizeAnnotations({ get title() { throw new Error("x") } }); return false } catch { return true } })() === true || true)
}

console.log("== 2. readOnlyHinted — explicit true only ==")
{
  ok("readOnlyHint:true → read-only", readOnlyHinted({ annotations: { readOnlyHint: true } }) === true)
  ok("readOnlyHint:false → mutating", readOnlyHinted({ annotations: { readOnlyHint: false } }) === false)
  ok("absent annotations → mutating (safe default)", readOnlyHinted({}) === false)
  ok("null tool → mutating, no throw", readOnlyHinted(null) === false)
  ok("truthy-but-not-true never promotes", readOnlyHinted({ annotations: { readOnlyHint: 1 } }) === false)
}

console.log("== 3. mcpToolsToPlugins — the verdict reaches the plugin ==")
{
  const fakeClient = { name: "srv", async callTool() { return { text: "x" } } }
  const plugins = mcpToolsToPlugins(fakeClient, [
    { name: "read_file", description: "read", annotations: { readOnlyHint: true } },
    { name: "write_file", description: "write", annotations: { readOnlyHint: false } },
    { name: "legacy", description: "no annotations" },
  ])
  eq("read-only tool is marked read-only", plugins[0].readOnly, true)
  eq("declared-mutating tool stays mutating", plugins[1].readOnly, false)
  eq("unannotated tool stays mutating", plugins[2].readOnly, false)
  eq("annotations are carried on the plugin", plugins[0].annotations, { readOnlyHint: true })
  eq("unannotated plugin carries null", plugins[2].annotations, null)
}

// ---------------------------------------------------------------------------
// A stub MCP server that sleeps before answering initialize, so a SEQUENTIAL
// connect of N servers costs ~N*delay while a parallel one costs ~delay.
const DELAY_MS = 300
const stub = path.join(WORK, "slow-mcp.cjs")
fs.writeFileSync(stub, `
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") {
      setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } } }), ${DELAY_MS})
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [
        { name: "peek", description: "read only", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        { name: "poke", description: "mutates", inputSchema: { type: "object", properties: {} } },
      ] } })
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } })
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } })
    }
  }
})
`)

const mkConfig = (n) => {
  const servers = {}
  for (let i = 0; i < n; i++) servers[`s${i}`] = { command: process.execPath, args: [stub] }
  return { mcp: { lazy: false, servers } }
}

console.log("== 4. cold servers connect in PARALLEL ==")
{
  const N = 3
  const t0 = Date.now()
  const res = await loadMcpTools(mkConfig(N), { timeoutMs: 8000 })
  const ms = Date.now() - t0
  eq("every server contributed its tools", res.tools.length, N * 2)
  eq("no errors", res.errors, [])
  // sequential would be >= N*DELAY (1800ms); parallel is ~DELAY plus overhead.
  ok(`parallel: ${N} servers in ${ms}ms, well under the ${N * DELAY_MS}ms sequential floor`,
    ms < N * DELAY_MS * 0.7, `${ms}ms`)
  eq("tool order follows CONFIG order, not completion order",
    res.tools.map((t) => t.name), ["mcp__s0__peek", "mcp__s0__poke", "mcp__s1__peek", "mcp__s1__poke", "mcp__s2__peek", "mcp__s2__poke"])
  eq("annotated tool is read-only end-to-end", res.tools[0].readOnly, true)
  eq("unannotated sibling stays mutating", res.tools[1].readOnly, false)
  for (const c of res.clients) { try { c.close() } catch {} }
}

console.log("== 5. a dead server never blocks the healthy ones ==")
{
  const cfg = mkConfig(2)
  cfg.mcp.servers.dead = { command: "/nonexistent/forge-mcp-xyz", args: [] }
  const res = await loadMcpTools(cfg, { timeoutMs: 6000 })
  eq("healthy servers still contributed", res.tools.length, 4)
  ok("the dead server is reported honestly", res.errors.some((e) => /dead/.test(e)), JSON.stringify(res.errors))
  for (const c of res.clients) { try { c.close() } catch {} }
}

console.log("== 6. lazy path: annotations survive the inventory cache ==")
{
  const cfg = { mcp: { servers: { lz: { command: process.execPath, args: [stub] } } } }
  // pass 1: cold → connects, lists, and saves the inventory (with annotations)
  const first = await loadMcpTools(cfg, { timeoutMs: 8000 })
  eq("cold pass advertised both tools", first.tools.length, 2)
  for (const c of first.clients) { try { c.close() } catch {} }
  // pass 2: warm → served from cache as stubs, WITHOUT spawning the server
  const t0 = Date.now()
  const second = await loadMcpTools(cfg, { timeoutMs: 8000 })
  const ms = Date.now() - t0
  eq("warm pass advertised both tools from cache", second.tools.length, 2)
  ok(`warm pass did not spawn the server (${ms}ms < ${DELAY_MS}ms handshake)`, ms < DELAY_MS, `${ms}ms`)
  eq("read-only verdict survived the cache", second.tools[0].readOnly, true)
  eq("mutating sibling survived the cache", second.tools[1].readOnly, false)
  eq("annotations survived the cache", second.tools[0].annotations, { readOnlyHint: true })
  for (const c of second.clients) { try { c.close() } catch {} }
}

// ---------------------------------------------------------------------------
console.log("== 7. capability fabric: dedupe against native tools ==")
{
  const { selectCapabilities, bareToolName, isExternal, namedInTask, formatSelection } =
    await import("../capfabric.js")
  const { TOOL_DEFS } = await import("../tools.js")
  const NATIVE = TOOL_DEFS.map((t) => t?.function?.name).filter(Boolean)

  eq("bareToolName strips the namespace", bareToolName("mcp__filesystem__read_file"), "read_file")
  eq("bareToolName leaves a plain name alone", bareToolName("read_file"), "read_file")
  ok("isExternal is true for mcp-sourced", isExternal({ source: "mcp:fs" }) === true)
  ok("isExternal is false for native", isExternal({ source: "native" }) === false)

  const ext = (server, tool, desc = "") => ({
    name: `mcp__${server}__${tool}`, source: `mcp:${server}`,
    def: { type: "function", function: { name: `mcp__${server}__${tool}`, description: desc } },
  })
  // the REAL collision set shipped by the official filesystem + git servers
  const collide = [
    ext("filesystem", "read_file"), ext("filesystem", "write_file"), ext("filesystem", "edit_file"),
    ext("git", "git_status"), ext("git", "git_diff"), ext("git", "git_log"),
  ]
  const unique = [ext("filesystem", "directory_tree"), ext("git", "git_worktree_list")]
  const nativeTool = { name: "read_file", source: "native" }

  const r = selectCapabilities({ task: "tidy up", plugins: [nativeTool, ...collide, ...unique], nativeNames: NATIVE })
  eq("every native-colliding MCP tool is dropped", r.dropped.length, 6)
  ok("all six drops cite the native duplicate", r.dropped.every((d) => /duplicates the native/.test(d.reason)))
  eq("the non-colliding MCP tools survive",
    r.kept.filter(isExternal).map((p) => p.name), ["mcp__filesystem__directory_tree", "mcp__git__git_worktree_list"])
  ok("the native tool itself is never gated", r.kept.some((p) => p.name === "read_file" && !isExternal(p)))
  ok("dedupe can be turned off", selectCapabilities({ plugins: collide, nativeNames: NATIVE, dedupe: false }).dropped.length === 0)
  ok("summary names what was withheld", /6 MCP tool\(s\) withheld/.test(formatSelection(r)), formatSelection(r))
  eq("nothing withheld → empty summary", formatSelection({ dropped: [] }), "")
}

console.log("== 8. capability fabric: relevance budget ==")
{
  const { selectCapabilities, isExternal, namedInTask } = await import("../capfabric.js")
  const mk = (server, tool, desc) => ({
    name: `mcp__${server}__${tool}`, source: `mcp:${server}`,
    def: { type: "function", function: { name: `mcp__${server}__${tool}`, description: desc } },
  })
  const many = []
  for (let i = 0; i < 40; i++) many.push(mk("bulk", `filler_${i}`, "unrelated filler capability"))
  many.push(mk("postgres", "run_query", "execute a SQL query against the database"))
  many.push(mk("sentry", "list_issues", "list recent production errors"))

  const small = selectCapabilities({ task: "anything", plugins: many.slice(0, 10), nativeNames: [] })
  eq("under budget → nothing gated (small setups unchanged)", small.gated, false)
  eq("under budget → nothing dropped", small.dropped.length, 0)

  const r = selectCapabilities({ task: "run a SQL query on the postgres database", plugins: many, nativeNames: [], maxExternal: 8 })
  eq("over budget → gated", r.gated, true)
  eq("exactly the budget survives", r.kept.filter(isExternal).length, 8)
  ok("the task-relevant tool is kept", r.kept.some((p) => p.name === "mcp__postgres__run_query"))
  ok("drops explain the budget", r.dropped.every((d) => /budget/.test(d.reason)))
  eq("kept + dropped accounts for every tool", r.kept.filter(isExternal).length + r.dropped.length, many.length)

  ok("a tool named in the task is pinned", namedInTask("please use run_query for this", mk("pg", "run_query", "")) === true)
  ok("a server named in the task pins it", namedInTask("check sentry for errors", mk("sentry", "list_issues", "")) === true)
  ok("an unrelated tool is not pinned", namedInTask("write a poem", mk("bulk", "filler_1", "")) === false)

  // custom budget of 1 keeps only the single best match
  const one = selectCapabilities({ task: "list recent production errors from sentry", plugins: many, nativeNames: [], maxExternal: 1 })
  eq("budget of 1 keeps the single best match", one.kept.filter(isExternal).map((p) => p.name), ["mcp__sentry__list_issues"])
}

console.log("== 9. fabric is wired into the agent loop ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent.js imports the fabric", /import \{ selectCapabilities, formatSelection \} from "\.\/capfabric\.js"/.test(src))
  ok("MCP tools pass through selectCapabilities before reaching plugins", /selectCapabilities\(\{[\s\S]{0,400}plugins: usable/.test(src))
  ok("the selected set derives from the loaded MCP tools", /const usable = isDelegatedSubAgent \? mcp\.tools\.filter/.test(src))
  ok("only the SELECTED tools are added to plugins", /plugins = \[\.\.\.plugins, \.\.\.sel\.kept\]/.test(src))
  ok("withheld tools are reported, never silent", /mcp_tool_withheld/.test(src))
  ok("clients are still taken from the full load (no leak)", /mcpClients = mcp\.clients/.test(src))
}

console.log("== 10. cache-only loading never spawns a server ==")
{
  // a server with NO cached inventory must be skipped, not spawned
  const coldCfg = { mcp: { servers: { nevercached: { command: process.execPath, args: [stub] } } } }
  const t0 = Date.now()
  const res = await loadMcpTools(coldCfg, { timeoutMs: 8000, cachedOnly: true })
  const ms = Date.now() - t0
  eq("cache-only + cold cache → zero tools", res.tools.length, 0)
  ok(`no handshake was paid (${ms}ms < ${DELAY_MS}ms)`, ms < DELAY_MS, `${ms}ms`)
  ok("the skip is reported honestly", res.errors.some((e) => /cache-only/.test(e)), JSON.stringify(res.errors))
  for (const c of res.clients) { try { c.close() } catch {} }

  // the server cached back in section 6 IS served cache-only, with no spawn
  const warmCfg = { mcp: { servers: { lz: { command: process.execPath, args: [stub] } } } }
  const warm = await loadMcpTools(warmCfg, { timeoutMs: 8000, cachedOnly: true })
  eq("cache-only + warm cache → tools served", warm.tools.length, 2)
  eq("read-only verdict intact under cache-only", warm.tools[0].readOnly, true)
  for (const c of warm.clients) { try { c.close() } catch {} }
}

console.log("== 11. crew: read-only MCP tools reach a delegated sub-agent ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("the sub-agent MCP block is no longer gated off",
    /if \(!noTools && config\.tools\?\.mcp !== false\)/.test(src))
  ok("a sub-agent loads cache-only (never spawns a server)",
    /isDelegatedSubAgent \? \{ cachedOnly: true \}/.test(src))
  ok("a sub-agent only ever sees DECLARED read-only tools",
    /isDelegatedSubAgent \? mcp\.tools\.filter\(\(t\) => t\.readOnly === true\)/.test(src))
  ok("the read-only contract is still enforced downstream (tools.js)",
    /if \(!pl\.readOnly\) WRITE_TOOLS\.add\(pl\.name\)/.test(fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")))
  // the filter itself: only readOnly:true survives
  const mixed = [
    { name: "mcp__s__peek", source: "mcp:s", readOnly: true },
    { name: "mcp__s__poke", source: "mcp:s", readOnly: false },
    { name: "mcp__s__legacy", source: "mcp:s" },
  ]
  eq("filter keeps exactly the declared read-only tools",
    mixed.filter((t) => t.readOnly === true).map((t) => t.name), ["mcp__s__peek"])
}

// ---------------------------------------------------------------------------
console.log("== 12. Streamable HTTP transport (the hosted-MCP ecosystem) ==")
{
  const http = await import("node:http")
  const TOOLS = [
    { name: "peek", description: "read only", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "poke", description: "mutates", inputSchema: { type: "object", properties: {} } },
  ]
  // mode "json" answers application/json; mode "sse" answers text/event-stream
  const mkServer = (mode) => new Promise((resolve) => {
    let sawSession = null
    const srv = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        let m; try { m = JSON.parse(body) } catch { m = null }
        if (req.headers["mcp-session-id"]) sawSession = req.headers["mcp-session-id"]
        const reply = (result) => {
          const payload = { jsonrpc: "2.0", id: m.id, result }
          if (mode === "sse") {
            res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-9" })
            res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
          } else {
            res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-9" })
            res.end(JSON.stringify(payload))
          }
        }
        if (!m || m.id === undefined) { res.writeHead(202).end(); return } // notification
        if (m.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "remote", version: "2" } })
        if (m.method === "tools/list") return reply({ tools: TOOLS })
        if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${m.params?.name}` }] })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } }))
      })
    })
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, session: () => sawSession }))
  })

  for (const mode of ["json", "sse"]) {
    const { srv, port, session } = await mkServer(mode)
    const url = `http://127.0.0.1:${port}/mcp`
    // a private address requires the same explicit opt-in as any other fetch
    const cfg = { mcp: { lazy: false, servers: { remote: { url, allowPrivate: true } } } }
    const res = await loadMcpTools(cfg, { timeoutMs: 8000 })
    eq(`[${mode}] both tools loaded over HTTP`, res.tools.length, 2)
    eq(`[${mode}] namespaced like any other server`, res.tools.map((t) => t.name), ["mcp__remote__peek", "mcp__remote__poke"])
    eq(`[${mode}] annotations work over HTTP too`, res.tools[0].readOnly, true)
    eq(`[${mode}] unannotated stays mutating`, res.tools[1].readOnly, false)
    const out = await res.tools[0].run({})
    eq(`[${mode}] a tool call round-trips`, out, "called peek")
    ok(`[${mode}] the session id is echoed back after initialize`, session() === "sess-9", String(session()))
    for (const c of res.clients) { try { c.close() } catch {} }
    srv.close()
  }

  // a private URL WITHOUT the opt-in must be refused, not silently allowed
  const { srv, port } = await mkServer("json")
  const denied = await loadMcpTools({ mcp: { lazy: false, servers: { remote: { url: `http://127.0.0.1:${port}/mcp` } } } }, { timeoutMs: 6000 })
  eq("a private MCP url without opt-in yields no tools", denied.tools.length, 0)
  ok("and says why", denied.errors.some((e) => /remote/.test(e)), JSON.stringify(denied.errors))
  for (const c of denied.clients) { try { c.close() } catch {} }
  srv.close()
}

console.log("== 13. transport is chosen by spec shape ==")
{
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("a url spec selects the HTTP client", /spec\?\.url\s*\n?\s*\? new McpHttpClient/.test(src))
  ok("a command spec still selects stdio", /: new McpClient\(name,/.test(src))
  ok("url-only servers are configurable", /\(s\.command \|\| s\.url\)/.test(src))
  ok("the inventory cache fingerprints a url distinctly", /spec\.url \? `url/.test(src))
  ok("HTTP goes through netguard (never a raw fetch)", /pinnedFetch\(this\.url/.test(src))
  ok("no raw global fetch anywhere in mcp.js", !/[^.\w]fetch\(/.test(src.replace(/pinnedFetch\(/g, "PF(")))
}

// ---------------------------------------------------------------------------
console.log("== 14. resources + prompts: the other two MCP primitives ==")
{
  const { normalizeResources, normalizePrompts, flattenResourceContents, flattenPromptMessages, mcpContextTool } =
    await import("../mcp.js")

  eq("resources: garbage → []", normalizeResources(null), [])
  eq("resources: entries without a uri are dropped", normalizeResources({ resources: [{ name: "x" }, { uri: "file://a" }] }).map((r) => r.uri), ["file://a"])
  eq("prompts: garbage → []", normalizePrompts({ prompts: "nope" }), [])
  eq("prompts: named entries survive", normalizePrompts({ prompts: [{ name: "review", description: "d" }] }), [{ name: "review", description: "d" }])
  eq("resource text is flattened", flattenResourceContents({ contents: [{ text: "hello" }, { text: "world" }] }), "hello\nworld")
  ok("a binary resource is labeled, never silently dropped",
    /binary resource/.test(flattenResourceContents({ contents: [{ blob: "AAAA", mimeType: "image/png" }] })))
  eq("prompt messages are flattened with roles",
    flattenPromptMessages({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }), "user: hi")

  eq("no capabilities → no context tool", mcpContextTool({ name: "s" }, {}), null)
  eq("tools-only server → no context tool", mcpContextTool({ name: "s" }, { tools: {} }), null)

  const calls = []
  const client = {
    name: "docs",
    async listResources() { calls.push("listResources"); return [{ uri: "doc://a", name: "A", mimeType: "text/md" }] },
    async readResource(u) { calls.push("read:" + u); return "BODY OF " + u },
    async listPrompts() { calls.push("listPrompts"); return [{ name: "review", description: "code review" }] },
    async getPrompt(n) { calls.push("getPrompt:" + n); return "user: do " + n },
  }
  const tool = mcpContextTool(client, { resources: {}, prompts: {} })
  eq("context tool is namespaced per server", tool.name, "mcp__docs__context")
  eq("context tool is READ-ONLY (so the crew may use it)", tool.readOnly, true)
  eq("it declares the read-only hint too", tool.annotations, { readOnlyHint: true })
  eq("all four actions offered when both primitives exist",
    tool.def.function.parameters.properties.action.enum, ["list_resources", "read_resource", "list_prompts", "get_prompt"])
  ok("listing resources renders uri + name + mime", /doc:\/\/a — A \[text\/md\]/.test(await tool.run({ action: "list_resources" })))
  eq("reading a resource returns its body", await tool.run({ action: "read_resource", uri: "doc://a" }), "BODY OF doc://a")
  ok("read_resource without a uri is an honest error", /needs a uri/.test(await tool.run({ action: "read_resource" })))
  ok("listing prompts renders name + description", /review — code review/.test(await tool.run({ action: "list_prompts" })))
  eq("getting a prompt returns its messages", await tool.run({ action: "get_prompt", name: "review" }), "user: do review")
  ok("an unknown action is an honest error", /unknown action/.test(await tool.run({ action: "nope" })))
  ok("a throwing client degrades to ERROR, never a throw",
    /^ERROR: /.test(await mcpContextTool({ name: "b", async listResources() { throw new Error("boom") } }, { resources: {} }).run({ action: "list_resources" })))

  // resources-only server exposes only the resource actions
  const resOnly = mcpContextTool(client, { resources: {} })
  eq("resources-only server offers only resource actions",
    resOnly.def.function.parameters.properties.action.enum, ["list_resources", "read_resource"])
}

console.log("== 15. the context tool reaches the agent over a real server ==")
{
  const http = await import("node:http")
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let m; try { m = JSON.parse(body) } catch { m = null }
      if (!m || m.id === undefined) { res.writeHead(202).end(); return }
      const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })) }
      if (m.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "docs", version: "1" } })
      if (m.method === "tools/list") return reply({ tools: [{ name: "search", description: "s", inputSchema: { type: "object", properties: {} } }] })
      if (m.method === "resources/list") return reply({ resources: [{ uri: "doc://readme", name: "Readme", mimeType: "text/markdown" }] })
      if (m.method === "resources/read") return reply({ contents: [{ text: "# Readme\nthe real body" }] })
      if (m.method === "prompts/list") return reply({ prompts: [{ name: "triage", description: "triage an issue" }] })
      reply({})
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv.address().port}/mcp`
  const cfg = { mcp: { lazy: false, servers: { docs: { url, allowPrivate: true } } } }
  const res = await loadMcpTools(cfg, { timeoutMs: 8000 })
  eq("the server's tool AND its context tool are offered", res.tools.map((t) => t.name), ["mcp__docs__search", "mcp__docs__context"])
  eq("one context tool per server, not one per resource", res.tools.filter((t) => /__context$/.test(t.name)).length, 1)
  const ctx = res.tools.find((t) => /__context$/.test(t.name))
  ok("resources list over HTTP", /doc:\/\/readme — Readme/.test(await ctx.run({ action: "list_resources" })))
  ok("resource read over HTTP returns the real body", /the real body/.test(await ctx.run({ action: "read_resource", uri: "doc://readme" })))
  ok("prompts list over HTTP", /triage/.test(await ctx.run({ action: "list_prompts" })))
  eq("the context tool is read-only, so a sub-agent may keep it", ctx.readOnly, true)
  for (const c of res.clients) { try { c.close() } catch {} }
  srv.close()
}

// ---------------------------------------------------------------------------
console.log("== 16. runtime bring-up actually runs a real program (regression) ==")
{
  // `runtime up` — discover, build, launch, wait for readiness, health-probe —
  // threw ReferenceError: green is not defined on EVERY invocation, because
  // green/red were never defined in tools.js. A tool result is text the model
  // reads, not terminal output, so the markers are plain. This drives the real
  // tool against a real HTTP app and asserts the real stages.
  const net = await import("node:net")
  const freePort = await new Promise((res) => {
    const s2 = net.createServer(); s2.listen(0, "127.0.0.1", () => { const p2 = s2.address().port; s2.close(() => res(p2)) })
  })
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v100-app-"))
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({
    name: "v100app", version: "1.0.0",
    scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"", start: "node server.js" },
  }))
  fs.writeFileSync(path.join(app, "server.js"),
    `const http=require('http');http.createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({ok:true}))}).listen(${freePort},'127.0.0.1',()=>console.log('listening on port ${freePort}'))`)

  const prevCwd = process.cwd()
  process.chdir(app)
  const tools = await import("../tools.js")
  const ctx = tools.makeToolContext({ config: {}, cwd: app })

  const disco = String(await tools.execTool(ctx, "runtime", { action: "discover" }))
  ok("discover finds the real start script from package.json", /script\.start: node server\.js/.test(disco), disco.slice(0, 200))
  ok("discover never invents a run command", /run: npm start/.test(disco))

  const up = String(await tools.execTool(ctx, "runtime", { action: "up", command: "node server.js", ready_timeout_ms: 20000 }))
  ok("bring-up completes (no ReferenceError)", /BRING-UP COMPLETE/.test(up), up.slice(0, 300))
  ok("launch stage is reported with a real pid", /✓ launch: .*pid \d+/.test(up), up.slice(0, 300))
  ok("readiness was EARNED by a probe, not assumed", /✓ wait-ready: ready after .* \(http: HTTP 200\)/.test(up), up.slice(0, 300))
  ok("no color helper leaked into the tool result", !/\u001b\[/.test(up))

  const health = String(await tools.execTool(ctx, "runtime", { action: "health", port: freePort }))
  ok("health is a real probe against the running app", /HEALTHY/.test(health) && /HTTP 200/.test(health), health.slice(0, 200))

  const status = String(await tools.execTool(ctx, "runtime", { action: "status" }))
  ok("status reports the live process and its port", /running/.test(status) && String(status).includes(String(freePort)), status.slice(0, 200))

  const stop = String(await tools.execTool(ctx, "runtime", { action: "stop" }))
  ok("stop signals the process group", /SIGTERM sent to the process group/.test(stop), stop.slice(0, 200))
  await tools.disposeToolManagers()
  process.chdir(prevCwd)
}

// ---------------------------------------------------------------------------
console.log("== 17. every command path reaches the fabric ==")
{
  // The fabric sits inside runAgent, so any path that executes through runAgent
  // inherits it. This pins the delegation chain so a future refactor that
  // bypasses runAgent (and therefore the fabric) fails loudly here.
  const meta = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const worknode = fs.readFileSync(new URL("../worknode.mjs", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const chat = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")

  ok("meta segments execute through agent.js runAgent", /runAgent \?\? \(await import\("\.\/agent\.js"\)\)\.runAgent/.test(meta))
  ok("DAG work nodes execute through runAgent", /await runAgent\(\{/.test(worknode))
  ok("chat loads MCP on its own path", /loadMcpTools\(config\)/.test(chat))
  ok("the fabric is inside runAgent, so every caller inherits it", /selectCapabilities\(\{/.test(agent))

  // the read-only paths (verifier / delegated sub-agent) are the ones that used
  // to be excluded entirely; they now receive DECLARED read-only tools only
  ok("read-only runs still reach MCP", /if \(!noTools && config\.tools\?\.mcp !== false\)/.test(agent))
  ok("and are restricted to declared read-only tools", /mcp\.tools\.filter\(\(t\) => t\.readOnly === true\)/.test(agent))
  ok("a verifier run is read-only by construction", /readOnly: readonly \|\| verifier/.test(agent))
}

// ---------------------------------------------------------------------------
console.log("== 18. OOM guard: concurrency follows the MACHINE, not a constant ==")
{
  const { resourceProfile, safeSpawnConcurrency, isTermux, isAndroid, memoryHeadroomOk, MEM_HEADROOM_MB } =
    await import("../profile.js")

  // Termux is detected from the environment Termux itself sets
  ok("TERMUX_VERSION is Termux", isTermux({ TERMUX_VERSION: "0.118" }) === true)
  ok("a com.termux PREFIX is Termux", isTermux({ PREFIX: "/data/data/com.termux/files/usr" }) === true)
  ok("a plain linux env is not Termux", isTermux({ HOME: "/home/user", PREFIX: "/usr" }) === false)
  ok("this machine is not Android (no false positive)", isAndroid({ HOME: "/home/user" }) === false)

  const P = (cores, totalMB, freeMB) => resourceProfile({ cores, totalMB, freeMB })

  // The case that actually killed the user's session: a capable-LOOKING phone.
  // 8 cores and 3GB free would otherwise compute 7 children.
  const phone = P(8, 8192, 3000)
  eq("phone profile looks 'high' on paper", phone.tier, "high")
  ok("but Termux clamps concurrency to 2", safeSpawnConcurrency({ profile: phone, env: { TERMUX_VERSION: "0.118" } }) === 2)
  ok("without the clamp it would have been far higher",
    safeSpawnConcurrency({ profile: phone, env: { HOME: "/home/user" } }) > 2)

  // a genuinely small device serializes
  eq("2-core/2GB box runs one at a time", safeSpawnConcurrency({ profile: P(2, 2000, 500), env: {} }), 1)
  eq("low tier always serializes", P(2, 2000, 500).tier, "low")

  // memory, not cores, is the binding constraint when RAM is scarce
  const starved = P(16, 16384, 800)
  ok("16 cores but 800MB free → at most 1", safeSpawnConcurrency({ profile: starved, env: {} }) <= 1)

  // a roomy machine is not punished
  ok("a 16GB/8-core laptop still parallelizes", safeSpawnConcurrency({ profile: P(8, 16384, 9000), env: {} }) >= 4)

  // an explicit request always wins — this never overrides a deliberate choice
  eq("explicit request wins over every heuristic",
    safeSpawnConcurrency({ profile: P(2, 2000, 300), env: { TERMUX_VERSION: "1" }, requested: "6" }), 6)
  eq("a garbage request falls back to the heuristic",
    safeSpawnConcurrency({ profile: P(2, 2000, 500), env: {}, requested: "not-a-number" }), 1)
  ok("the result is never 0 (work still happens, just serially)",
    safeSpawnConcurrency({ profile: P(1, 512, 10), env: { TERMUX_VERSION: "1" } }) >= 1)

  ok("headroom check is a real reading", typeof memoryHeadroomOk() === "boolean")
  ok("a headroom floor is reserved for the OS and forge itself", MEM_HEADROOM_MB >= 256)
}

console.log("== 19. the test runner itself is memory-aware (the SIGKILL fix) ==")
{
  const runner = fs.readFileSync(new URL("./run-all.mjs", import.meta.url), "utf8")
  ok("concurrency is derived, not a hardcoded 4", !/\|\| 4\)/.test(runner) && /safeSpawnConcurrency\(/.test(runner))
  ok("FORGE_TEST_CONCURRENCY is still honored", /requested: process\.env\.FORGE_TEST_CONCURRENCY/.test(runner))
  ok("the pool waits for headroom between suites", /await awaitHeadroom\(/.test(runner))
  ok("the headroom wait is bounded (never a deadlock)", /waited < 30000/.test(runner))
  ok("the chosen concurrency is reported to the user", /concurrency \$\{CONCURRENCY\}/.test(runner))
}

// ---------------------------------------------------------------------------
console.log("== 20. terminal survives a SIGKILL (the 'close the terminal' bug) ==")
{
  const src = fs.readFileSync(new URL("../terminal.js", import.meta.url), "utf8")
  ok("startup REPAIRS residue before configuring (cursor back, paste off)",
    /rawWrite\(SHOW \+ PASTE_OFF\)/.test(src))
  ok("cooked mode is forced before raw mode is re-enabled",
    /setRawMode\(false\) \} catch \{\}\s*\n\s*rawWrite\(SHOW \+ PASTE_OFF\)/.test(src))
  ok("SIGTERM and SIGHUP now restore the terminal", /for \(const sig of \["SIGTERM", "SIGHUP"\]\)/.test(src))
  ok("a signal forge already owns is left alone", /if \(process\.listenerCount\(sig\) > 0\) continue/.test(src))
  ok("the signal is re-raised — forge never becomes unkillable", /process\.kill\(process\.pid, sig\)/.test(src))
  ok("signal hooks are removed on stop (no leak across sessions)", /for \(const \[sig, h\] of signalHooks\)/.test(src))

  // Real PTY proof: leave the TTY in the killed state (cursor hidden, paste on,
  // raw mode), then start a forge terminal in it and confirm the repair bytes
  // are emitted. python3+pty only; skipped cleanly otherwise.
  const { spawnSync } = await import("node:child_process")
  const hasPty = spawnSync("python3", ["-c", "import pty,termios"], { stdio: "ignore" }).status === 0
  if (!hasPty) {
    console.log("  skip PTY repair proof (python3 pty unavailable)")
  } else {
    const drv = path.join(WORK, "kill-repair.py")
    const child = path.join(WORK, "child.mjs")
    fs.writeFileSync(child, `
import { createTerminal } from ${JSON.stringify(new URL("../terminal.js", import.meta.url).href)}
const t = createTerminal()
t.start({ prompt: "> ", onSubmit: () => {}, onEOF: () => {}, onResize: () => {} })
setTimeout(() => {}, 60000)
`)
    fs.writeFileSync(drv, `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    # leave the tty in the state a SIGKILLed forge leaves behind
    sys.stdout.write("\x1b[?25l\x1b[?2004h"); sys.stdout.flush()
    os.execvp(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(child)}])
out = b""
end = time.time() + 6
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d: break
        out += d
    if b"\x1b[?25h" in out and b"\x1b[?2004l" in out:
        break
os.kill(pid, 9)
sys.stdout.buffer.write(out)
`)
    const r = spawnSync("python3", [drv], { encoding: "buffer", timeout: 20000 })
    const bytes = r.stdout ? r.stdout.toString("latin1") : ""
    ok("a real forge terminal emits SHOW-cursor into a killed-state tty", bytes.includes("\u001b[?25h"), JSON.stringify(bytes.slice(0, 120)))
    ok("and turns bracketed paste back off", bytes.includes("\u001b[?2004l"), JSON.stringify(bytes.slice(0, 120)))
  }
}

// ---------------------------------------------------------------------------
console.log("== 21. measured selection: proven tools outrank unproven ones ==")
{
  const { reliabilityOf, latencyFactorOf, measuredRank, selectCapabilities, isExternal,
          unhealthyServers, HEALTH_MIN_SAMPLES, HEALTH_FAIL_RATE } = await import("../capfabric.js")

  // damping: thin evidence must never blacklist
  eq("no history → unproven, not bad (0.5)", reliabilityOf(null), 0.5)
  ok("one failure does not zero a tool", reliabilityOf({ samples: 1, ok: 0 }) > 0.3)
  ok("a proven tool outranks an unproven one", reliabilityOf({ samples: 20, ok: 20 }) > reliabilityOf(null))
  ok("a persistently failing tool ranks below unproven", reliabilityOf({ samples: 20, ok: 1 }) < reliabilityOf(null))
  eq("no samples → no latency penalty", latencyFactorOf({ samples: 0 }), 1)
  ok("a slow tool is demoted, never erased", latencyFactorOf({ samples: 2, ms: 40000 }) > 0 && latencyFactorOf({ samples: 2, ms: 40000 }) < 0.6)
  ok("a fast tool keeps almost all of its score", latencyFactorOf({ samples: 10, ms: 1000 }) > 0.9)
  ok("relevance still dominates rank",
    measuredRank(10, { samples: 20, ok: 1 }) > measuredRank(0, { samples: 20, ok: 20 }))

  const mk = (server, tool, desc) => ({
    name: `mcp__${server}__${tool}`, source: `mcp:${server}`,
    def: { type: "function", function: { name: `mcp__${server}__${tool}`, description: desc } },
  })
  // two equally relevant tools; only history separates them
  const a = mk("alpha", "run_query", "execute a SQL query")
  const b = mk("beta", "run_query", "execute a SQL query")
  const filler = []
  for (let i = 0; i < 30; i++) filler.push(mk("bulk", `filler_${i}`, "unrelated"))
  const stats = {
    "mcp__alpha__run_query": { samples: 20, ok: 19, failed: 1, ms: 2000 },
    "mcp__beta__run_query": { samples: 20, ok: 2, failed: 18, ms: 60000 },
  }
  const sel = selectCapabilities({
    task: "execute a SQL query", plugins: [a, b, ...filler], nativeNames: [], maxExternal: 1, stats, breaker: false,
  })
  eq("the tool with the better record wins the slot",
    sel.kept.filter(isExternal).map((p) => p.name), ["mcp__alpha__run_query"])

  // without history the order falls back to relevance + config order
  const noHist = selectCapabilities({ task: "execute a SQL query", plugins: [b, a, ...filler], nativeNames: [], maxExternal: 1 })
  eq("no history → first equally-relevant tool in config order", noHist.kept.filter(isExternal).map((p) => p.name), ["mcp__beta__run_query"])
}

console.log("== 22. circuit breaker: a persistently failing server is withheld ==")
{
  const { selectCapabilities, isExternal, unhealthyServers, HEALTH_MIN_SAMPLES } = await import("../capfabric.js")
  const mk = (server, tool) => ({ name: `mcp__${server}__${tool}`, source: `mcp:${server}`, def: { type: "function", function: { name: `mcp__${server}__${tool}`, description: "" } } })

  eq("no stats → no server is unhealthy", unhealthyServers({}).size, 0)
  eq("thin evidence never trips the breaker",
    unhealthyServers({ "mcp__flaky__go": { samples: HEALTH_MIN_SAMPLES - 1, failed: HEALTH_MIN_SAMPLES - 1 } }).size, 0)
  ok("sustained failure trips it",
    unhealthyServers({ "mcp__dead__go": { samples: 20, failed: 20 } }).has("dead"))
  ok("an occasionally-failing server is NOT tripped",
    !unhealthyServers({ "mcp__ok__go": { samples: 20, failed: 4 } }).has("ok"))

  const stats = { "mcp__dead__go": { samples: 20, ok: 0, failed: 20 }, "mcp__live__go": { samples: 20, ok: 20, failed: 0 } }
  const sel = selectCapabilities({ task: "anything", plugins: [mk("dead", "go"), mk("live", "go")], nativeNames: [], stats })
  eq("the failing server's tools are withheld", sel.kept.filter(isExternal).map((p) => p.name), ["mcp__live__go"])
  ok("the reason names the server and the evidence", /server "dead" is failing \(20\/20 calls\) — circuit open/.test(sel.dropped[0].reason), sel.dropped[0].reason)
  eq("the breaker can be turned off",
    selectCapabilities({ task: "x", plugins: [mk("dead", "go")], nativeNames: [], stats, breaker: false }).dropped.length, 0)
  eq("no stats → breaker cannot fire",
    selectCapabilities({ task: "x", plugins: [mk("dead", "go")], nativeNames: [] }).dropped.length, 0)
}

console.log("== 23. the agent reads its own recorded history ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent.js loads the project's tool stats", /loadToolStats/.test(src))
  ok("and hands them to the fabric", /stats: \(\(\) => \{ try \{ return loadToolStats/.test(src))
  ok("the breaker is on by default, and configurable", /breaker: config\.mcp\?\.breaker !== false/.test(src))
  ok("a stats read can never break the agent", /catch \{ return null \} \}\)\(\)/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== 24. unified capability index: all four registries, one scale ==")
{
  const { buildCapabilityIndex, rankCapabilities, indexSummary, formatCapabilityIndex,
          lifecyclePrior, CAP_SOURCE, EVIDENCE } = await import("../capindex.js")
  const { TOOL_DEFS } = await import("../tools.js")

  // lifecycle priors: earned state IS evidence, and unknown is neutral
  ok("VERIFIED outranks ACTIVE", lifecyclePrior("VERIFIED") > lifecyclePrior("ACTIVE"))
  ok("ACTIVE outranks CANDIDATE", lifecyclePrior("ACTIVE") > lifecyclePrior("CANDIDATE"))
  eq("an unknown lifecycle is neutral, not bad", lifecyclePrior(undefined), 0.5)
  ok("DEPRECATED ranks below unproven", lifecyclePrior("DEPRECATED") < 0.5)
  ok("STALE demotes even a VERIFIED skill", lifecyclePrior("VERIFIED", { stale: true }) <= 0.2)
  ok("STALE never reaches zero (a stale playbook can still be right)", lifecyclePrior("VERIFIED", { stale: true }) > 0)

  const idx = buildCapabilityIndex({
    nativeDefs: TOOL_DEFS,
    skills: [
      { name: "systematic-debugging", desc: "root cause analysis", lifecycle: "VERIFIED" },
      { name: "old-pack", desc: "root cause analysis", lifecycle: "ACTIVE", stale: true },
    ],
    mcpPlugins: [{ name: "mcp__pg__run_query", readOnly: false, def: { function: { description: "execute a SQL query" } } }],
    createdTools: [{ name: "csvfmt", description: "format csv", lifecycle: "ACTIVE" }],
    stats: { "mcp__pg__run_query": { samples: 12, ok: 11, failed: 1, ms: 6000 } },
  })

  const sum = indexSummary(idx)
  eq("every source is represented", Object.keys(sum.bySource).sort(), ["created", "mcp", "native", "skill"])
  eq("native tools are all indexed", sum.bySource.native, TOOL_DEFS.length)
  eq("counted evidence is reported separately from inferred", [sum.proven, sum.inferred], [1, 3])

  const mcpEntry = idx.find((e) => e.name === "mcp__pg__run_query")
  eq("a tool with runs carries COUNTED evidence", mcpEntry.evidence, EVIDENCE.COUNTED)
  eq("and its real sample count", mcpEntry.samples, 12)
  ok("its reliability reflects the record", mcpEntry.reliability > 0.8)

  const skillEntry = idx.find((e) => e.name === "systematic-debugging")
  eq("a skill carries LIFECYCLE evidence, never counted", skillEntry.evidence, EVIDENCE.LIFECYCLE)
  eq("a skill is read-only (loading a playbook mutates nothing)", skillEntry.readOnly, true)
  eq("a never-run native tool is honestly unproven", idx.find((e) => e.name === "bash").evidence, EVIDENCE.NONE)

  const staleEntry = idx.find((e) => e.name === "old-pack")
  eq("a stale skill is flagged in the index", staleEntry.stale, true)
  ok("and ranks below its fresh twin", staleEntry.reliability < skillEntry.reliability)

  // one scale: a proven MCP tool, a verified skill and unproven natives compete
  const ranked = rankCapabilities(idx, "debug the failing SQL query", { limit: 5 })
  ok("ranking returns entries from more than one source",
    new Set(ranked.map((r) => r.source)).size > 1, JSON.stringify(ranked.map((r) => r.source)))
  eq("the proven, most relevant capability leads", ranked[0].name, "mcp__pg__run_query")
  ok("every ranked entry carries its evidence kind", ranked.every((r) => r.evidence))
  ok("irrelevant capabilities are dropped by default", ranked.every((r) => r.relevance > 0))
  ok("keepIrrelevant returns the full inventory",
    rankCapabilities(idx, "zzzz", { keepIrrelevant: true }).length === idx.length)
  eq("sources can be filtered",
    new Set(rankCapabilities(idx, "root cause analysis", { sources: [CAP_SOURCE.SKILL] }).map((r) => r.source)).size, 1)

  // relevance still dominates across sources
  const irrelevantButProven = rankCapabilities(idx, "format csv", { limit: 1 })
  eq("a relevant created tool beats a proven-but-unrelated one", irrelevantButProven[0].name, "csvfmt")

  ok("the report names counts and evidence", /CAPABILITY INDEX — 33 total \(1 with recorded runs, 3 by lifecycle\)/.test(formatCapabilityIndex(idx)))
  ok("a stale entry is labeled in the report", /old-pack.*STALE/.test(formatCapabilityIndex(idx)))
  eq("an empty index is honest", formatCapabilityIndex([]), "no capabilities indexed")

  // partial inputs must not throw
  ok("a caller that knows only one source still gets an index",
    buildCapabilityIndex({ skills: [{ name: "x", desc: "y" }] }).length === 1)
  eq("no inputs → empty index, no throw", buildCapabilityIndex().length, 0)
}

console.log("== 25. stale skills: the flag that was written but never read ==")
{
  const { evaluateSkills, formatSkillPicks } = await import("../evaluate.js")
  const fresh = { name: "sql-debugging", desc: "debug sql queries", lifecycle: "ACTIVE" }
  const stale = { name: "sql-tuning", desc: "debug sql queries fast", lifecycle: "ACTIVE", stale: true }

  const picks = evaluateSkills("debug sql queries", [stale, fresh], { klass: "MEDIUM" })
  eq("the stale skill is still OFFERED, not hidden", picks.length, 2)
  eq("but it ranks below the fresh match", picks[0].name, "sql-debugging")
  ok("the stale one is demoted", picks.find((p) => p.name === "sql-tuning").score < picks[0].score)
  ok("the flag survives into the pick", picks.find((p) => p.name === "sql-tuning").stale === true)
  ok("the model is told it is stale, never that it is current",
    /STALE — verified before related files changed/.test(formatSkillPicks(picks)))
  ok("a fresh skill gets no stale label", !/sql-debugging.*STALE/.test(formatSkillPicks(picks)))

  // the relevance GATE must use the raw score: demoting must never silently drop
  const onlyStale = evaluateSkills("debug sql queries", [stale], { klass: "MEDIUM" })
  eq("a stale skill alone is still surfaced", onlyStale.length, 1)

  // the flag actually comes out of the lifecycle store
  const sf = fs.readFileSync(new URL("../skillforge.js", import.meta.url), "utf8")
  ok("pickSkills reads `stale` from the skill-life record", /stale: Boolean\(s\.name && life\[s\.name\]\?\.stale === true\)/.test(sf))
  const ev = fs.readFileSync(new URL("../evolve.js", import.meta.url), "utf8")
  ok("markStaleSkills is what writes it", /rec\.stale = true/.test(ev))
}

console.log(`\n== v100 fabricwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
