/**
 * forge — cross-language graph (v33, zero dependencies)
 *
 * UNIFIED §7: one connected system, not per-language silos.
 *   source → contract → consumer → runtime → test → deploy
 *
 * Contracts are regex (no Tree-sitter): HTTP routes, SQL tables, proto
 * messages/services, OpenAPI paths, Docker services, CI jobs. Linking is
 * name-normalized (routes `/:id` ≡ `/{id}`, case-folded tables). Unknown
 * language is still discovered — a miss is no edge, never a throw.
 *
 * Records come from the v32 index (repomap walkIndexed). This module does
 * not walk the filesystem and does not import index.js / repomap.js
 * (no cycles).
 *
 * §19 add-on: testsForFiles / skipUnchangedTests. A ledger is optional;
 * without one nothing is skipped (never fake a green test).
 */
import path from "node:path"

export const XEDGE = Object.freeze({
  IMPORT: "IMPORT",
  CONTRACT: "CONTRACT",
  CONSUMES: "CONSUMES",
  IMPLEMENTS: "IMPLEMENTS",
  TEST: "TEST",
  DEPLOY: "DEPLOY",
})

const CAP = 24

function uniqPush(out, item, keyFn) {
  const k = keyFn(item)
  if (out._seen?.has(k)) return
  if (!out._seen) out._seen = new Set()
  out._seen.add(k)
  out.push(item)
}

function posixRel(p) {
  return String(p || "").replace(/\\/g, "/")
}

export function normRoute(p) {
  let s = String(p || "").trim()
  if (!s) return ""
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname
  } catch { /* keep s */ }
  s = s.split("?")[0].split("#")[0]
  s = s.replace(/\{[^}]+\}/g, ":param").replace(/:([A-Za-z_]\w*)/g, ":param")
  if (s.length > 1) s = s.replace(/\/+$/, "")
  if (s && !s.startsWith("/") && !s.startsWith(".")) s = "/" + s
  return s.toLowerCase()
}

export function normName(s) {
  return String(s || "").trim().replace(/[`"'[\]]/g, "").toLowerCase()
}

function add(out, kind, name, extra = {}) {
  const n = String(name || "").trim()
  if (!n || n.length > 96) return
  if (/^(https?:)?\/?\/?(localhost|127\.|0\.0\.0\.0)/i.test(n) && kind === "route") {
    const r = normRoute(n)
    if (!r || r === "/") return
    uniqPush(out, { kind, name: r, role: extra.role || "produce" }, (c) => `${c.kind}|${c.role}|${c.name}`)
    return
  }
  const rec = { kind, name: kind === "route" ? (normRoute(n) || n) : n, role: extra.role || "produce" }
  if (!rec.name || rec.name === "/") return
  uniqPush(out, rec, (c) => `${c.kind}|${c.role}|${normName(c.name)}`)
}

/**
 * Extract cross-language contracts from one file. Bounded, best-effort.
 */
export function extractContracts(file, src) {
  const out = []
  const s = String(src || "")
  const base = path.basename(String(file || "")).toLowerCase()
  const rel = posixRel(file).toLowerCase()
  if (!s) return out

  // HTTP producers: Express / Fastify / Nest / Flask / FastAPI / Gin / Axum
  const prodRoute = /(?:\.(?:get|post|put|patch|delete|options|head|all)|HandleFunc|\.Handle|@(?:Get|Post|Put|Patch|Delete|RequestMapping)|@app\.route|@router\.(?:get|post|put|patch|delete)|@app\.(?:get|post|put|patch|delete)|#\[(?:get|post|put|patch|delete))\s*(?:\([^)]*)?\(\s*['"`]([^'"`]+)['"`]/gi
  let m
  while ((m = prodRoute.exec(s)) && out.length < CAP) {
    if (String(m[1]).startsWith("/")) add(out, "route", m[1], { role: "produce" })
  }
  // Gin/Echo: r.GET("/x"
  const goRoute = /\.(?:GET|POST|PUT|PATCH|DELETE|Any|HEAD)\s*\(\s*["`]([^"`]+)["`]/g
  while ((m = goRoute.exec(s)) && out.length < CAP) {
    if (String(m[1]).startsWith("/")) add(out, "route", m[1], { role: "produce" })
  }

  // HTTP consumers: fetch / axios / requests / httpx
  const consRoute = /(?:fetch|axios\.(?:get|post|put|patch|delete)|requests\.(?:get|post|put|patch|delete)|httpx\.(?:get|post|put|patch|delete)|http\.Get)\s*\(\s*['"`]([^'"`]+)['"`]/gi
  while ((m = consRoute.exec(s)) && out.length < CAP) {
    const raw = m[1]
    if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) add(out, "route", raw, { role: "consume" })
  }

  // SQL tables
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?[`"]?([A-Za-z_]\w*)[`"]?/gi
  while ((m = create.exec(s)) && out.length < CAP) add(out, "table", m[1], { role: "produce" })
  const from = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?(?:\w+\.)?[`"]?([A-Za-z_]\w*)[`"]?/gi
  while ((m = from.exec(s)) && out.length < CAP) {
    const name = m[1]
    if (!/^(select|where|set|values|as|on|inner|left|right|outer|join|table)$/i.test(name)) {
      add(out, "table", name, { role: "consume" })
    }
  }
  const knex = /\.from\(\s*['"`]([A-Za-z_]\w*)['"`]/g
  while ((m = knex.exec(s)) && out.length < CAP) add(out, "table", m[1], { role: "consume" })

  // protobuf / graphql
  const proto = /^\s*(?:service|message)\s+(\w+)/gm
  while ((m = proto.exec(s)) && out.length < CAP) add(out, "proto", m[1], { role: "produce" })
  const rpc = /^\s*rpc\s+(\w+)/gm
  while ((m = rpc.exec(s)) && out.length < CAP) add(out, "proto", m[1], { role: "produce" })
  const gql = /^\s*type\s+(\w+)/gm
  if (/\.(graphql|gql)$/i.test(base) || /\btype\s+Query\b/.test(s)) {
    while ((m = gql.exec(s)) && out.length < CAP) add(out, "type", m[1], { role: "produce" })
  }

  // OpenAPI / Swagger paths
  if (/\bpaths\s*:/.test(s) && (/\bopenapi\s*:/.test(s) || /\bswagger\s*:/.test(s) || /openapi|swagger/i.test(base))) {
    const pathKey = /^\s+(\/[\w/{}\-.:]+)\s*:/gm
    while ((m = pathKey.exec(s)) && out.length < CAP) add(out, "route", m[1], { role: "produce" })
  }

  // Docker compose services + Dockerfile FROM
  if (/^docker-compose|^compose\.|dockerfile/i.test(base) || /compose\.ya?ml$/.test(rel)) {
    const fromImg = /^\s*FROM\s+(\S+)/gim
    while ((m = fromImg.exec(s)) && out.length < CAP) add(out, "image", m[1].split(":")[0], { role: "produce" })
    const img = /^\s*image:\s*['"]?([^\s'"]+)/gm
    while ((m = img.exec(s)) && out.length < CAP) add(out, "image", m[1].split(":")[0], { role: "produce" })
    yamlBlockKeys(s, "services").forEach((k) => add(out, "service", k, { role: "produce" }))
  }

  // GitHub Actions / CI jobs
  if (rel.includes(".github/workflows/") || /gitlab-ci|\.travis|azure-pipelines/i.test(base)) {
    yamlBlockKeys(s, "jobs").forEach((k) => add(out, "job", k, { role: "produce" }))
  }

  out._seen = undefined
  return out.slice(0, CAP)
}

function yamlBlockKeys(src, header) {
  const keys = []
  const re = new RegExp("^" + header + "\\s*:\\s*$", "im")
  const m = re.exec(src)
  if (!m) return keys
  const rest = src.slice(m.index + m[0].length)
  for (const line of rest.split("\n")) {
    if (!line.trim()) continue
    if (/^\S/.test(line)) break
    const km = /^  ([A-Za-z_][\w-]*)\s*:/.exec(line)
    if (km) keys.push(km[1])
    if (keys.length >= 16) break
  }
  return keys
}

function contractKey(c) {
  const kind = c.kind === "route" ? "route" : c.kind
  const name = kind === "route" ? normRoute(c.name) : normName(c.name)
  return kind + "\0" + name
}

const IMPORT_EXT = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs"]

export function resolveImport(fromRel, spec, relSet) {
  const specS = String(spec || "")
  if (!specS.startsWith(".")) return null
  const from = posixRel(fromRel)
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""
  let raw = posixRel(path.posix.normalize((dir ? dir + "/" : "") + specS))
  if (raw.startsWith("./")) raw = raw.slice(2)
  while (raw.startsWith("../")) return null
  const tries = []
  for (const ext of IMPORT_EXT) tries.push(raw + ext)
  tries.push(raw + "/index.js", raw + "/index.ts", raw + "/__init__.py")
  for (const t of tries) {
    if (relSet.has(t)) return t
  }
  return null
}

/**
 * Link indexed records into a cross-language graph.
 * @param {Array<{rel, lang, symbols, imports, test, config, contracts}>} records
 */
export function linkRecords(records = []) {
  const files = []
  const edges = []
  const relSet = new Set()
  const byRel = new Map()
  for (const rec of records || []) {
    const rel = posixRel(rec.rel || rec.path || "")
    if (!rel) continue
    relSet.add(rel)
    const node = {
      path: rel,
      lang: rec.lang || "unknown",
      symbols: rec.symbols || [],
      imports: rec.imports || [],
      contracts: Array.isArray(rec.contracts) ? rec.contracts : [],
      isTest: !!rec.test,
      isConfig: !!rec.config,
    }
    byRel.set(rel, node)
    files.push(node)
  }

  const producers = new Map() // key → [rel]
  const consumers = new Map()
  for (const n of files) {
    for (const c of n.contracts) {
      const k = contractKey(c)
      const bucket = (c.role === "consume" ? consumers : producers)
      if (!bucket.has(k)) bucket.set(k, [])
      bucket.get(k).push({ rel: n.path, contract: c })
      edges.push({ from: n.path, to: `${c.kind}:${c.name}`, kind: XEDGE.CONTRACT, via: c.kind })
    }
  }

  for (const n of files) {
    for (const spec of n.imports) {
      const target = resolveImport(n.path, spec, relSet)
      if (!target) continue
      edges.push({ from: n.path, to: target, kind: XEDGE.IMPORT })
      if (n.isTest) edges.push({ from: n.path, to: target, kind: XEDGE.TEST })
    }
  }

  for (const [k, prods] of producers) {
    const cons = consumers.get(k) || []
    const langs = new Set(prods.map((p) => byRel.get(p.rel)?.lang))
    if (langs.size >= 2 && prods.length >= 2) {
      for (let i = 0; i < prods.length; i++) {
        for (let j = i + 1; j < prods.length; j++) {
          if (prods[i].rel === prods[j].rel) continue
          const a = byRel.get(prods[i].rel)?.lang
          const b = byRel.get(prods[j].rel)?.lang
          if (a && b && a !== b) {
            edges.push({ from: prods[i].rel, to: prods[j].rel, kind: XEDGE.IMPLEMENTS, via: k.split("\0")[1] })
            edges.push({ from: prods[j].rel, to: prods[i].rel, kind: XEDGE.IMPLEMENTS, via: k.split("\0")[1] })
          }
        }
      }
    }
    for (const c of cons) {
      for (const p of prods) {
        if (c.rel === p.rel) continue
        edges.push({ from: c.rel, to: p.rel, kind: XEDGE.CONSUMES, via: k.split("\0")[1] })
      }
    }
  }

  // deploy: docker/ci file mentions a service/job that matches a producer basename or contract
  for (const n of files) {
    const deployKinds = n.contracts.filter((c) => c.kind === "service" || c.kind === "job" || c.kind === "image")
    if (!deployKinds.length) continue
    for (const d of deployKinds) {
      edges.push({ from: n.path, to: `${d.kind}:${d.name}`, kind: XEDGE.DEPLOY, via: d.name })
    }
  }

  return {
    files,
    edges,
    stats: {
      files: files.length,
      edges: edges.length,
      contracts: edges.filter((e) => e.kind === XEDGE.CONTRACT).length,
      implements: edges.filter((e) => e.kind === XEDGE.IMPLEMENTS).length,
      consumes: edges.filter((e) => e.kind === XEDGE.CONSUMES).length,
      tests: edges.filter((e) => e.kind === XEDGE.TEST).length,
      deploys: edges.filter((e) => e.kind === XEDGE.DEPLOY).length,
    },
  }
}

function relOf(file, cwd, graph) {
  const s = posixRel(file)
  if (graphIndex(graph).byPath.has(s)) return s
  if (cwd) {
    try {
      const r = posixRel(path.relative(cwd, path.resolve(cwd, s)))
      if (graphIndex(graph).byPath.has(r)) return r
    } catch { /* ignore */ }
  }
  const base = path.basename(s)
  const hits = graphIndex(graph).byBase.get(base) || []
  return hits.length === 1 ? hits[0].path : s
}

// ---------------------------------------------------------------------------
// v89 perf: adjacency index. Graphs are immutable once built (walkIndexed /
// linkRecords / JSON-parsed snapshots always produce fresh objects), so the
// index is keyed on the graph object itself (WeakMap) and built at most once
// per graph. Before this, every neighbors() call scanned ALL edges and every
// visited node did an O(files) .find() — O(V×E) per traversal, repeated for
// each tool verification and each compose in a run (60% of agent-step CPU on
// a 400-file repo). Results are byte-identical; only the lookup cost changed.
// ---------------------------------------------------------------------------
const graphIndexCache = new WeakMap()

function graphIndex(graph) {
  if (!graph || typeof graph !== "object") {
    const empty = new Map()
    return { byPath: new Map(), byBase: new Map(), out: new Map(), inc: new Map(), _empty: empty }
  }
  let ix = graphIndexCache.get(graph)
  if (ix) return ix
  const byPath = new Map()
  const byBase = new Map()
  const out = new Map()
  const inc = new Map()
  for (const f of graph.files || []) {
    if (!f || !f.path) continue
    byPath.set(f.path, f)
    const b = path.basename(f.path)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(f)
  }
  for (const e of graph.edges || []) {
    if (!e || !e.from || !e.to) continue
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from).push(e)
    if (!inc.has(e.to)) inc.set(e.to, [])
    inc.get(e.to).push(e)
  }
  ix = { byPath, byBase, out, inc }
  graphIndexCache.set(graph, ix)
  return ix
}

function neighbors(graph, rel, kinds, { reverse = false } = {}) {
  const ix = graphIndex(graph)
  const edges = (reverse ? ix.inc : ix.out).get(rel) || []
  if (!kinds || !kinds.length) return edges.map((e) => (reverse ? e.from : e.to))
  const kindSet = kinds.length === 1 ? null : new Set(kinds)
  const only = kinds[0]
  const out = []
  for (const e of edges) {
    if (kindSet ? !kindSet.has(e.kind) : e.kind !== only) continue
    out.push(reverse ? e.from : e.to)
  }
  return out
}

/** Memo for testsForFiles: same graph object + same start set + same cwd →
 *  the identical result (returned as a copy — callers may mutate it). */
const testsMemo = new WeakMap()

/**
 * Tests transitively connected to `files` via IMPORT / CONSUMES / IMPLEMENTS.
 */
export function testsForFiles(files, graph, { cwd = "" } = {}) {
  if (!graph?.files?.length) return []
  const ix = graphIndex(graph)
  const start = (files || []).map((f) => relOf(f, cwd, graph)).filter(Boolean)
  if (!start.length) return []
  let memo = testsMemo.get(graph)
  if (!memo) { memo = new Map(); testsMemo.set(graph, memo) }
  const key = cwd + "\u0000" + [...new Set(start)].sort().join("\u0001")
  const hit = memo.get(key)
  if (hit) return [...hit]
  // BFS over the adjacency index — O(V+E), was O(V×E)
  const seen = new Set(start)
  const stack = [...start]
  const tests = new Set()
  for (const p of start) {
    const node = ix.byPath.get(p)
    if (node?.isTest) tests.add(p)
  }
  const KINDS = [XEDGE.IMPORT, XEDGE.CONSUMES, XEDGE.IMPLEMENTS, XEDGE.TEST]
  while (stack.length) {
    const cur = stack.pop()
    for (const n of neighbors(graph, cur, KINDS, { reverse: true })) {
      if (!n || seen.has(n) || n.includes(":")) continue
      seen.add(n)
      stack.push(n)
      const node = ix.byPath.get(n)
      if (node?.isTest) tests.add(n)
    }
    for (const n of neighbors(graph, cur, KINDS)) {
      if (!n || seen.has(n) || n.includes(":")) continue
      seen.add(n)
      stack.push(n)
      const node = ix.byPath.get(n)
      if (node?.isTest) tests.add(n)
    }
  }
  const result = [...tests]
  memo.set(key, result)
  return [...result]
}

export function consumersOf(files, graph, { cwd = "" } = {}) {
  if (!graph?.files?.length) return []
  const ix = graphIndex(graph)
  const start = (files || []).map((f) => relOf(f, cwd, graph)).filter(Boolean)
  const startSet = new Set(start)
  const out = new Set()
  for (const s of start) {
    for (const n of neighbors(graph, s, [XEDGE.IMPORT, XEDGE.CONSUMES, XEDGE.IMPLEMENTS], { reverse: true })) {
      if (n.includes(":")) continue
      const node = ix.byPath.get(n)
      if (node?.isTest) continue
      if (!startSet.has(n)) out.add(n)
    }
  }
  return [...out]
}

/**
 * Implementation files a test imports (TEST / IMPORT / CONSUMES outgoing).
 * Empty graph or non-test starts → []. Never invents a path.
 */
export function implForFiles(files, graph, { cwd = "" } = {}) {
  if (!graph?.files?.length) return []
  const ix = graphIndex(graph)
  const start = (files || []).map((f) => relOf(f, cwd, graph)).filter(Boolean)
  const out = new Set()
  for (const s of start) {
    const node = ix.byPath.get(s)
    if (!node?.isTest) continue
    for (const n of neighbors(graph, s, [XEDGE.IMPORT, XEDGE.TEST, XEDGE.CONSUMES])) {
      if (!n || n.includes(":")) continue
      const t = ix.byPath.get(n)
      if (t?.isTest) continue
      out.add(n)
    }
  }
  return [...out]
}

/**
 * Skip tests whose fingerprint (and imported deps) match an optional ledger.
 * No ledger → skip nothing. Never invents a green result.
 *
 * ledger: { [rel]: { size, mtime } }
 */
export function skipUnchangedTests(tests, { records = [], ledger = null, graph = null } = {}) {
  const list = Array.isArray(tests) ? tests : []
  if (!ledger || typeof ledger !== "object") return { run: [...list], skip: [] }
  const byRel = new Map((records || []).map((r) => [posixRel(r.rel || r.path), r]))
  if (graph?.files) {
    for (const f of graph.files) if (!byRel.has(f.path)) byRel.set(f.path, f)
  }
  const run = [], skip = []
  for (const t of list) {
    const rec = byRel.get(posixRel(t))
    const prev = ledger[posixRel(t)] || ledger[t]
    if (!rec || !prev) { run.push(t); continue }
    const size = Number(rec.size ?? rec.fingerprint?.size)
    const mtime = Number(rec.mtime ?? rec.fingerprint?.mtime)
    if (!(size === Number(prev.size) && mtime === Number(prev.mtime))) { run.push(t); continue }
    let depChanged = false
    const imports = rec.imports || []
    for (const spec of imports) {
      const target = graph ? resolveImport(posixRel(t), spec, new Set(byRel.keys())) : null
      if (!target) continue
      const d = byRel.get(target)
      const lp = ledger[target]
      if (!d || !lp) { depChanged = true; break }
      if (Number(d.size) !== Number(lp.size) || Number(d.mtime) !== Number(lp.mtime)) {
        depChanged = true
        break
      }
    }
    if (depChanged) run.push(t)
    else skip.push(t)
  }
  return { run, skip }
}

/**
 * One-line chains: source → contract → consumer → test → deploy.
 */
export function formatCrossGraph(graph, { maxChars = 1200, maxLines = 16, query = "" } = {}) {
  if (!graph?.files?.length) return ""
  const lines = ["CROSS GRAPH (source → contract → consumer → test → deploy):"]
  let used = lines[0].length
  let shown = 0
  const impl = (graph.edges || []).filter((e) => e.kind === XEDGE.IMPLEMENTS || e.kind === XEDGE.CONSUMES)
  const q = String(query || "").toLowerCase()
  const ranked = [...impl].sort((a, b) => {
    if (!q) return 0
    const as = (a.from + a.to + (a.via || "")).toLowerCase()
    const bs = (b.from + b.to + (b.via || "")).toLowerCase()
    return (bs.includes(q) ? 1 : 0) - (as.includes(q) ? 1 : 0)
  })
  const seen = new Set()
  for (const e of ranked) {
    if (shown >= maxLines) break
    const key = [e.from, e.to, e.kind, e.via].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    const fromNode = graph.files.find((f) => f.path === e.from)
    const toNode = graph.files.find((f) => f.path === e.to)
    const tests = [
      ...(graph.edges || []).filter((x) => x.kind === XEDGE.TEST && (x.to === e.from || x.to === e.to)).map((x) => x.from),
      ...(graph.files || []).filter((f) => f.isTest && (f.path === e.from || f.path === e.to)).map((f) => f.path),
    ]
    const deploys = (graph.edges || []).filter((x) => x.kind === XEDGE.DEPLOY).slice(0, 1)
    const via = e.via ? ` [${e.kind === XEDGE.CONSUMES ? "consumes" : "implements"} ${e.via}]` : ""
    const t = tests[0] ? ` → ${tests[0]} (test)` : ""
    const d = deploys[0] ? ` → ${deploys[0].from} (deploy)` : ""
    const line = `- ${e.from}${fromNode?.lang ? " (" + fromNode.lang + ")" : ""}${via} → ${e.to}${toNode?.lang ? " (" + toNode.lang + ")" : ""}${t}${d}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (shown === 0) {
    const sample = graph.files.filter((f) => f.contracts.length).slice(0, 8)
    for (const f of sample) {
      const cs = f.contracts.slice(0, 3).map((c) => c.kind + " " + c.name).join(", ")
      const line = `- ${f.path}: ${cs}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
      shown++
    }
  }
  if (!shown) return ""
  return lines.join("\n")
}

export function emptyCrossGraph() {
  return { files: [], edges: [], stats: { files: 0, edges: 0, contracts: 0, implements: 0, consumes: 0, tests: 0, deploys: 0 } }
}
