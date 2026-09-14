#!/usr/bin/env node
/**
 * v93 GAP FIX — phase 8: DEEP LANGUAGE INTELLIGENCE (§15/§16/§13).
 *
 *  1. LSP documentSymbol extraction is REAL: a fake-but-faithful LSP server
 *     (stdio JSON-RPC, initialize → initialized → didOpen → documentSymbol)
 *     serves structured symbols; extractStructured returns them with
 *     provenance {layer: 3, source: "lsp:<name>"}.
 *  2. Lexical is FALLBACK ONLY: no server configured → layer 8 + honest
 *     fallback reason; server crash → layer 8 + "lsp-failed"; zero-symbol
 *     response → layer 8 + "lsp-returned-no-symbols" (never a fake success).
 *  3. parseLayered labels its sync extraction honestly (extractionProvenance
 *     always lexical; never claims structured semantics it did not use).
 *  4. §13 chain in the living loop: meta invalidates the world snapshot for
 *  the files a segment mutated (WORLD_INVALIDATED + durable snapshot drop).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93l-"))
process.env.FORGE_HOME = HOME
// v94 gapclose: these suites pin the empty-config → lexical-fallback contract;
// the LSP auto-start table (a host typescript-language-server could otherwise
// resolve .js mid-test) is pinned by tests/test-lsp-autostart.mjs instead.
process.env.FORGE_LSP_AUTOSTART = "0"
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v93l-work-"))
process.chdir(WORK)
fs.writeFileSync(path.join(WORK, "calc.js"), "export function add(a, b) { return a + b }\nexport const CALC_VERSION = 1\n")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------------------
// a minimal but faithful LSP server over stdio: JSON-RPC, Content-Length
// framing, initialize/initialized/didOpen/documentSymbol/shutdown/exit
// ---------------------------------------------------------------------------
const SERVER = path.join(WORK, "fake-lsp.mjs")
fs.writeFileSync(SERVER, `#!/usr/bin/env node
const SYMBOLS = [
  { name: "add", kind: 12, range: { start: { line: 0, character: 16 } }, selectionRange: { start: { line: 0, character: 16 } } },
  { name: "CALC_VERSION", kind: 14, range: { start: { line: 1, character: 13 } }, selectionRange: { start: { line: 1, character: 13 } } },
  { name: "MathLib", kind: 5, range: { start: { line: 3, character: 0 } }, selectionRange: { start: { line: 3, character: 6 } }, children: [
    { name: "innerHelper", kind: 6, range: { start: { line: 4, character: 2 } }, selectionRange: { start: { line: 4, character: 2 } } },
  ] },
]
const send = (obj) => { const s = JSON.stringify(obj); process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\\r\\n\\r\\n" + s) }
let buf = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n")
    if (idx < 0) break
    const header = buf.slice(0, idx).toString()
    const m = /Content-Length:\\s*(\\d+)/.exec(header)
    if (!m) { buf = buf.slice(idx + 4); continue }
    const len = Number(m[1])
    if (buf.length < idx + 4 + len) break
    const body = buf.slice(idx + 4, idx + 4 + len).toString()
    buf = buf.slice(idx + 4 + len)
    try {
      const msg = JSON.parse(body)
      if (msg.method === "initialize") send({ id: msg.id, result: { capabilities: { documentSymbolProvider: true, textDocumentSync: 1 } } })
      else if (msg.method === "textDocument/documentSymbol") send({ id: msg.id, result: SYMBOLS })
      else if (msg.method === "shutdown") send({ id: msg.id, result: null })
      else if (msg.method === "exit") process.exit(0)
      else if (msg.id != null) send({ id: msg.id, result: null })
    } catch {}
  }
})
`)

const config = { lsp: { servers: { fakelsp: { command: process.execPath, args: [SERVER], extensions: [".js"], languageId: "javascript" } } } }

// ---------------------------------------------------------------------------
console.log("== 1. LSP documentSymbol units ==")
{
  const { normalizeSymbols } = await import("../lsp.js")
  const flat = normalizeSymbols([{ name: "a", kind: 12, location: { uri: "file:///x", range: { start: { line: 2 } } } }])
  eq("flat SymbolInformation normalized", flat, [{ name: "a", kind: "function", line: 3 }])
  const hier = normalizeSymbols([{ name: "Cls", kind: 5, range: { start: { line: 0 } }, children: [{ name: "m", kind: 6, range: { start: { line: 1 } } }] }])
  eq("hierarchical DocumentSymbol flattened incl. children", hier, [{ name: "Cls", kind: "class", line: 1 }, { name: "m", kind: "method", line: 2 }])
  eq("garbage input → [] (never throws)", normalizeSymbols(null), [])
  eq("non-string names dropped", normalizeSymbols([{ name: 42, kind: 12 }]), [])
}

// ---------------------------------------------------------------------------
console.log("== 2. extractStructured — LSP-first, REAL server (BEHAVIORAL) ==")
{
  const { extractStructured } = await import("../langadapter.js")
  const r = await extractStructured("calc.js", fs.readFileSync(path.join(WORK, "calc.js"), "utf8"), { config, cwd: WORK })
  ok("structured symbols returned from the LSP server", r.symbols.includes("add") && r.symbols.includes("CALC_VERSION") && r.symbols.includes("MathLib"), JSON.stringify(r.symbols))
  ok("hierarchical children extracted (innerHelper)", r.symbols.includes("innerHelper"))
  eq("provenance layer is 3 (LSP, the real parser)", r.provenance.layer, 3)
  eq("provenance names the server", r.provenance.source, "lsp:fakelsp")
  eq("no fallback", r.fallback, null)
  ok("structured entries carry kind + line", r.structured.every((s) => s.kind && s.line))

  // the lexical result for the SAME file is the fallback, and it differs
  const lex = await extractStructured("calc.js", fs.readFileSync(path.join(WORK, "calc.js"), "utf8"), { config: {}, cwd: WORK })
  eq("no server configured → lexical fallback layer 8", lex.provenance.layer, 8)
  eq("fallback reason is explicit", lex.fallback, "lsp-not-configured")
  ok("lexical fallback still extracts the top-level symbols", lex.symbols.includes("add"))
  eq("no structured claim", lex.structured, null)
}

// ---------------------------------------------------------------------------
console.log("== 3. failure honesty — never fake a structured success ==")
{
  const { extractStructured } = await import("../langadapter.js")
  // a server that dies on start
  const badCfg = { lsp: { servers: { dead: { command: process.execPath, args: ["/definitely/not/here.mjs"], extensions: [".js"] } } } }
  const r = await extractStructured("calc.js", "export const x = 1", { config: badCfg, cwd: WORK })
  eq("dead server → lexical layer 8", r.provenance.layer, 8)
  ok("fallback reason says lsp-failed", /^lsp-failed/.test(r.fallback), r.fallback)
  ok("symbols still available (the fallback did its job)", r.symbols.includes("x"))

  // zero-symbol response is NOT a structured success — serve empty via a stub
  const EMPTY = path.join(WORK, "empty-lsp.mjs")
fs.writeFileSync(EMPTY, `#!/usr/bin/env node
const send = (obj) => { const s = JSON.stringify(obj); process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\\r\\n\\r\\n" + s) }
let buf = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n")
    if (idx < 0) break
    const header = buf.slice(0, idx).toString()
    const m = /Content-Length:\\s*(\\d+)/.exec(header)
    if (!m) { buf = buf.slice(idx + 4); continue }
    const len = Number(m[1])
    if (buf.length < idx + 4 + len) break
    const body = buf.slice(idx + 4, idx + 4 + len).toString()
    buf = buf.slice(idx + 4 + len)
    try {
      const msg = JSON.parse(body)
      if (msg.method === "textDocument/documentSymbol") send({ id: msg.id, result: [] })
      else if (msg.method === "initialize") send({ id: msg.id, result: { capabilities: {} } })
      else if (msg.id != null) send({ id: msg.id, result: null })
    } catch {}
  }
})
`)

const emptyCfg = { lsp: { servers: { empty: { command: process.execPath, args: [EMPTY], extensions: [".js"] } } } }
  const r2 = await extractStructured("calc.js", "export function add(a,b){return a+b}", { config: emptyCfg, cwd: WORK })
  eq("zero-symbol server → lexical layer 8 (no fake success)", r2.provenance.layer, 8)
  eq("fallback names the zero-symbol case", r2.fallback, "lsp-returned-no-symbols")
}

// ---------------------------------------------------------------------------
console.log("== 4. parseLayered — honest sync provenance ==")
{
  const { parseLayered } = await import("../langadapter.js")
  const p = parseLayered("calc.js", "export function add(a,b){return a+b}", { config })
  ok("ladder reports lsp available (configured)", p.layers.some((l) => l.name === "lsp" && l.available))
  eq("sync extraction provenance is lexical layer 8", p.extractionProvenance.layer, 8)
  ok("provenance note points at the structured path (no false claim)", /extractStructured/.test(p.extractionProvenance.note))
  const p2 = parseLayered("calc.js", "export const x = 1", { config: {} })
  ok("no-config note says lexical is the only layer", /only layer/.test(p2.extractionProvenance.note))
}

// ---------------------------------------------------------------------------
console.log("== 5. §13 chain — meta invalidates what the segment mutated ==")
{
  // source-level: the wiring exists in the living loop
  const metaSrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("meta invalidates the world snapshot for changed files", /WORLD_INVALIDATED/.test(metaSrc) && /createWorldModel\(\{ cwd: process\.cwd\(\) \}\)\.invalidate/.test(metaSrc))
  // behavioral: runMeta with a mutating mock emits WORLD_INVALIDATED with the file
  const meta = await import("../meta.js")
  const events = []
  const PLAN = JSON.stringify([{ id: "n1", objective: "change calc.js", role: "coder", targetFiles: ["calc.js"] }])
  const r = await meta.runMeta({
    config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} },
    provider: { name: "x", model: "m" },
    task: "change calc.js",
    runAgent: async (o) => {
      if (o.planOnly) return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] }
      fs.appendFileSync(path.join(WORK, "calc.js"), "export function extraFn() { return 2 }\n")
      return {
        text: "changed calc.js",
        toolRecords: [{ tool: "edit_file", files_changed: [path.join(WORK, "calc.js")] }],
        commandChecks: [{ command: "node --check calc.js", exitCode: 0, passed: true, tail: "ok" }],
        toolLog: [],
      }
    },
    onEvent: (e) => events.push(e),
  })
  const inv = events.find((e) => e.type === "WORLD_INVALIDATED")
  ok("WORLD_INVALIDATED emitted for the mutated file", inv != null && inv.files.includes("calc.js"), JSON.stringify(inv ?? null))

  // durable: the snapshot record for calc.js was dropped → next build re-extracts it
  const { createWorldModel } = await import("../worldmodel.js")
  const wm = createWorldModel({ cwd: WORK })
  const w = wm.build()
  ok("the invalidated file was re-extracted (new symbol visible)", (w.files.find((f) => f.path === "calc.js")?.symbols ?? []).includes("extraFn"))
  ok("the re-extraction is counted incrementally", (w.stats.incremental?.reextracted ?? 0) >= 1, JSON.stringify(w.stats.incremental))
  void r
}

console.log(`\n== v93l: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
