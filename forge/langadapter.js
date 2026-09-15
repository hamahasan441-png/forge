/**
 * forge — language adapter system (v91 ∞ CORE §6-§8, zero dependencies)
 *
 * Forge must be genuinely polyglot — not a static list of languages wired
 * into Core. This module defines the ADAPTER INTERFACE (§7) and the LAYERED
 * PARSING STRATEGY (§8), and extends the catalog: every adapter from lang.js
 * (deep: symbols/imports/exports/calls/types) plus a broad extension catalog
 * (shallow: detection + conservative operation) covering the spec's language
 * list — Scala, Groovy, Objective-C, Perl, Lua, R, Julia, Haskell, OCaml,
 * Elixir/Erlang, Lisp family, Fortran, COBOL, Pascal, Ada, Assembly, MATLAB,
 * PowerShell, Batch, PL/SQL, T-SQL, HTML/CSS/SCSS, XML/JSON/YAML/TOML,
 * Markdown, LaTeX, CMake, Meson, Bazel, Gradle, Maven, Nix, HCL, Kubernetes,
 * Helm, GitHub Actions, OpenAPI/Swagger — and project-specific DSLs.
 *
 * §8 layered parsing (first available layer wins, honest UNAVAILABLE below):
 *   1. native AST/parser       — never faked; zero-dep build reports it honestly
 *   2. tree-sitter/equivalent  — optional external binary, else UNAVAILABLE
 *   3. LSP                     — real client (lsp.js) when the user configured it
 *   4. compiler/type checker   — real binary probes via langengine.binaryOnPath
 *   5. build metadata          — manifests (package.json, Cargo.toml, go.mod, …)
 *   6. package metadata        — lockfiles, registry files
 *   7. structured tooling      — formatter/linter/test-runner discovery
 *   8. lexical fallback        — lang.js regex adapters (always available)
 *
 * Unknown language flow (§7): the adaptive plan
 *   DISCOVER → IDENTIFY → INSPECT TOOLCHAIN → PARSE → INDEX →
 *   LEARN CONVENTIONS → OPERATE CONSERVATIVELY → VERIFY
 * Unknown never fails; it degrades to conservative mode.
 */
import fs from "node:fs"
import path from "node:path"
import {
  ADAPTERS, detectLanguage, extractSymbols, extractImports, extractExports,
  extractCalls, extractTypes, discoverToolchain,
} from "./lang.js"
import { binaryOnPath } from "./langengine.js"
import { semanticsFor } from "./langreason.js"
import { serverForFile, connectServer, pathToUri, languageIdForFile } from "./lsp.js"
import { extractViaTreeSitter } from "./treesitter.js"

/** §7 — capabilities an adapter MAY provide. Absent capability = honest null. */
export const ADAPTER_CAPABILITIES = [
  "detection", "versionDetection", "parser", "ast", "symbols", "dependencies",
  "semanticAnalysis", "lsp", "compiler", "runtime", "formatter", "linter",
  "typeChecker", "testDiscovery", "buildDiscovery", "executionStrategy",
  "diagnostics", "repairStrategies",
]

/**
 * Extension catalog: languages lang.js does not deeply parse yet. Each entry
 * carries the tools a toolchain probe should look for, so adaptive mode can
 * still discover compilers/runtimes/test runners on the machine.
 */
export const EXTENSION_LANGUAGES = [
  { id: "scala", name: "Scala", ext: [".scala"], files: ["build.sbt"], bins: ["scala", "sbt"] },
  { id: "groovy", name: "Groovy", ext: [".groovy", ".gradle"], bins: ["groovy", "gradle"] },
  { id: "objectivec", name: "Objective-C", ext: [".m", ".mm"], bins: ["clang"] },
  { id: "perl", name: "Perl", ext: [".pl", ".pm"], shebang: /\bperl\b/i, bins: ["perl"] },
  { id: "lua", name: "Lua", ext: [".lua"], bins: ["lua"] },
  { id: "r", name: "R", ext: [".r", ".R"], files: ["DESCRIPTION"], bins: ["Rscript"] },
  { id: "julia", name: "Julia", ext: [".jl"], bins: ["julia"] },
  { id: "erlang", name: "Erlang", ext: [".erl", ".hrl"], files: ["rebar.config"], bins: ["erl"] },
  { id: "haskell", name: "Haskell", ext: [".hs", ".lhs"], files: ["stack.yaml", "cabal.project"], bins: ["ghc", "stack", "cabal"] },
  { id: "ocaml", name: "OCaml", ext: [".ml", ".mli"], files: ["dune", "opam"], bins: ["ocaml", "dune", "opam"] },
  { id: "fsharp", name: "F#", ext: [".fs", ".fsx"], bins: ["dotnet"] },
  { id: "lisp", name: "Common Lisp", ext: [".lisp", ".cl", ".asd"], bins: ["sbcl", "clisp"] },
  { id: "clojure", name: "Clojure", ext: [".clj", ".cljs", ".edn"], files: ["project.clj", "deps.edn", "shadow-cljs.edn"], bins: ["clojure", "clj"] },
  { id: "scheme", name: "Scheme", ext: [".scm", ".ss"], bins: ["guile", "racket"] },
  { id: "fortran", name: "Fortran", ext: [".f", ".f90", ".f95", ".f03"], bins: ["gfortran", "ifort"] },
  { id: "cobol", name: "COBOL", ext: [".cob", ".cbl", ".cobol"], bins: ["cobc"] },
  { id: "pascal", name: "Pascal", ext: [".pas", ".pp", ".dpr"], bins: ["fpc"] },
  { id: "ada", name: "Ada", ext: [".adb", ".ads"], files: ["*.gpr"], bins: ["gnat"] },
  { id: "assembly", name: "Assembly", ext: [".s", ".S", ".asm"], bins: ["nasm", "as"] },
  { id: "matlab", name: "MATLAB", ext: [".mlx"], bins: ["matlab", "octave"] }, // .m is ambiguous with Objective-C — content rules decide
  { id: "powershell", name: "PowerShell", ext: [".ps1", ".psm1"], shebang: /\bpwsh\b/i, bins: ["pwsh"] },
  { id: "batch", name: "Batch", ext: [".bat", ".cmd"] },
  { id: "plsql", name: "PL/SQL", ext: [".pls", ".pck", ".pkb", ".pks"] },
  { id: "tsql", name: "T-SQL", ext: [".tsql"] },
  { id: "html", name: "HTML", ext: [".html", ".htm", ".vue", ".svelte"] },
  { id: "css", name: "CSS", ext: [".css"] },
  { id: "scss", name: "SCSS", ext: [".scss", ".sass"] },
  { id: "xml", name: "XML", ext: [".xml", ".xsl", ".xslt", ".plist"] },
  { id: "json", name: "JSON", ext: [".json", ".jsonc"] },
  { id: "yaml", name: "YAML", ext: [".yaml", ".yml"] },
  { id: "toml", name: "TOML", ext: [".toml"] },
  { id: "markdown", name: "Markdown", ext: [".md", ".markdown", ".mdx"] },
  { id: "latex", name: "LaTeX", ext: [".tex", ".sty", ".cls"], bins: ["pdflatex", "tectonic"] },
  { id: "cmake", name: "CMake", files: ["CMakeLists.txt", "*.cmake"], bins: ["cmake"] },
  { id: "meson", name: "Meson", files: ["meson.build"], bins: ["meson"] },
  { id: "bazel", name: "Bazel", files: ["WORKSPACE", "MODULE.bazel", "BUILD", "BUILD.bazel"], bins: ["bazel"] },
  { id: "gradle", name: "Gradle", files: ["build.gradle", "build.gradle.kts", "settings.gradle"], bins: ["gradle"] },
  { id: "maven", name: "Maven", files: ["pom.xml"], bins: ["mvn"] },
  { id: "nix", name: "Nix", ext: [".nix"], files: ["flake.nix", "default.nix"], bins: ["nix"] },
  { id: "hcl", name: "Terraform/HCL", ext: [".hcl"], files: ["*.tf.json"] },
  { id: "kubernetes", name: "Kubernetes", files: ["k8s", "kubernetes"], match: /kind:\s*(Deployment|Service|Pod|ConfigMap|Ingress|StatefulSet|DaemonSet|Job|CronJob)/, bins: ["kubectl"] },
  { id: "helm", name: "Helm", files: ["Chart.yaml"], bins: ["helm"] },
  { id: "github-actions", name: "GitHub Actions", files: [".github/workflows"], match: /^\s*(runs-on|uses|on):/m },
  { id: "openapi", name: "OpenAPI", files: ["openapi.yaml", "openapi.json", "swagger.yaml", "swagger.json"], match: /"openapi"\s*:|"swagger"\s*:|openapi:\s*3/i },
]

const EXT_BY_EXT = new Map()
const EXT_BY_FILE = new Map()
for (const l of EXTENSION_LANGUAGES) {
  for (const e of l.ext ?? []) EXT_BY_EXT.set(e.toLowerCase(), l)
  for (const f of l.files ?? []) if (!f.includes("/")) EXT_BY_FILE.set(f.toLowerCase(), l)
}

/**
 * Build the full adapter for a file (deep when lang.js owns the language,
 * shallow-conservative when only the extension catalog knows it).
 * All capabilities are HONEST: absent = null, never invented (§100).
 */
export function adapterFor(file, src = "") {
  // detectLanguage returns the ADAPTER OBJECT (lang.js contract) — normalize.
  const detected = detectLanguage(file, src)
  const deepId = typeof detected === "string" ? detected : detected?.id ?? "unknown"
  const ext = extOf(file)
  const base = ADAPTERS.find((a) => a.ext?.includes(ext) || a.files?.some((f) => file.endsWith(f) || file.includes(f)))
  const shallow = EXTENSION_LANGUAGES.find((l) => l.ext?.map((e) => e.toLowerCase()).includes(ext))
  const id = deepId !== "unknown" ? deepId : (shallow?.id ?? (ext.replace(".", "") || "unknown"))

  const caps = {
    detection: true,
    versionDetection: null,
    parser: null,          // §8 layer 1/2: honest — no native AST in a zero-dep build
    ast: null,
    symbols: null,
    dependencies: null,
    semanticAnalysis: null,
    lsp: null,
    compiler: null,
    runtime: null,
    formatter: null,
    linter: null,
    typeChecker: null,
    testDiscovery: null,
    buildDiscovery: null,
    executionStrategy: null,
    diagnostics: null,
    repairStrategies: null,
  }

  if (base) {
    // deep adapter — lexical extraction is always available
    caps.symbols = { extract: (f, s) => extractSymbols(f, s), layer: 8 }
    caps.dependencies = { extract: (f, s) => ({ imports: extractImports(f, s), exports: extractExports(f, s) }), layer: 8 }
    caps.semanticAnalysis = {
      extract: (f, s) => ({ calls: extractCalls(f, s), types: extractTypes(f, s) }),
      layer: 8,
      semantics: semanticsFor(id),
    }
  }

  const probe = shallow ?? base
  const bins = probe?.bins ?? []
  const found = bins.filter((b) => binaryOnPath(b))
  if (found.length) {
    caps.compiler = { binaries: found, layer: 4 }
    caps.executionStrategy = { runner: found[0], layer: 4 }
  }
  if (base?.id === "shell") caps.executionStrategy = { runner: "bash", layer: 4 }

  return {
    id,
    name: base?.name ?? shallow?.name ?? id,
    deep: Boolean(base),
    family: base?.family ?? null,
    file,
    capabilities: caps,
    adaptive: !base,
    parse: (s = src) => parseLayered(file, s),
  }
}

/** §8 — run the layered parse ladder, return every layer's honest outcome. */
export function parseLayered(file, src = "", { config = null } = {}) {
  const layers = []
  // 1. native AST — unavailable in a zero-dependency build, never faked
  layers.push({ layer: 1, name: "native-ast", available: false, why: "no native parser bundled (zero-dependency build)" })
  // 2. tree-sitter or equivalent — optional external binary only
  const ts = binaryOnPath("tree-sitter")
  layers.push({ layer: 2, name: "tree-sitter", available: ts, why: ts ? "external tree-sitter binary found" : "tree-sitter binary not on PATH" })
  // 3. LSP — real client when the user configured a server for this file
  // v93 gap fix: lspAvailability returns an ARRAY of configured servers —
  // the old `lsp?.configured?.length` read a shape that never existed, so
  // layer 3 could never report available even with servers configured.
  // v94 todowise: the first-party auto-start table counts too, so layer 3 is
  // the default structured path on machines with a real language server.
  // v99 fix: availability is a PER-FILE fact — resolve the server that serves
  // THIS file (serverForFile: user config first, then the autostart table for
  // this extension). The old `lspAvailability(config).some(available)` read a
  // GLOBAL roster, so a .js file falsely reported LSP-available merely because
  // an unrelated server (e.g. rust-analyzer, pyright) was installed on PATH —
  // a false capability claim for a language nothing on the box actually serves.
  const lspServing = (() => { try { return serverForFile(config ?? {}, file) } catch { return null } })()
  const lspReady = Boolean(lspServing)
  layers.push({ layer: 3, name: "lsp", available: lspReady, why: lspReady ? `server: ${lspServing.name}` : "no LSP server configured and no auto-start server binary on PATH for this file type" })
  // 4. compiler / type checker
  const adapter = adapterFor(file, src)
  layers.push({ layer: 4, name: "compiler", available: Boolean(adapter.capabilities.compiler), detail: adapter.capabilities.compiler ?? null })
  // 5-6. build / package metadata
  const tc = discoverToolchain(process.cwd())
  layers.push({ layer: 5, name: "build-metadata", available: Boolean(tc?.build), detail: tc?.build ?? null })
  const pkgMeta = hasPkgMetadata(process.cwd())
  layers.push({ layer: 6, name: "package-metadata", available: pkgMeta, detail: pkgMeta ? "lockfile/manifest present" : null })
  // 7. structured tooling
  layers.push({ layer: 7, name: "structured-tooling", available: Boolean(tc?.test || tc?.lint || tc?.format), detail: { test: tc?.test ?? null, lint: tc?.lint ?? null, format: tc?.format ?? null } })
  // 8. lexical fallback — ALWAYS available
  layers.push({ layer: 8, name: "lexical", available: true, detail: adapter.deep ? "lang.js regex adapter" : "conservative extension matching" })

  const firstAvailable = layers.find((l) => l.available)
  let extraction = null
  if (firstAvailable?.name === "lexical" || adapter.deep) {
    try {
      extraction = {
        symbols: adapter.capabilities.symbols ? extractSymbols(file, src) : [],
        imports: extractImports(file, src),
        exports: extractExports(file, src),
        calls: extractCalls(file, src),
        types: extractTypes(file, src),
      }
    } catch { extraction = null }
  }
  // §15 (v93 gap fix): this SYNC extraction is honestly labeled with the
  // layer that produced it — lexical, the fallback. When an LSP server is
  // configured for this file, structured (layer-3) extraction is available
  // through extractStructured(); parseLayered never CLAIMS structured
  // semantics it did not use.
  const lspLayer = layers.find((l) => l.name === "lsp")
  const extractionProvenance = {
    layer: 8,
    source: "lexical (lang.js)",
    note: lspLayer?.available
      ? "sync bulk path uses the lexical fallback; LSP documentSymbol extraction is available via extractStructured() for this file type"
      : "no structured parser available for this file; lexical is the only layer",
  }
  return { file, language: adapter.id, layers, chosen: firstAvailable?.name ?? "none", extraction, extractionProvenance, conservative: adapter.adaptive }
}

/** §7 unknown-language flow — the deterministic adaptive plan. */
export function adaptivePlan(file, src = "", { config = null } = {}) {
  const adapter = adapterFor(file, src)
  const parsed = parseLayered(file, src, { config })
  return {
    file,
    language: adapter.id,
    adaptive: adapter.adaptive,
    steps: [
      { step: "DISCOVER", done: true, detail: `found ${file}` },
      { step: "IDENTIFY", done: adapter.id !== "unknown", detail: adapter.id },
      { step: "INSPECT_TOOLCHAIN", done: Boolean(adapter.capabilities.compiler), detail: adapter.capabilities.compiler?.binaries ?? ["none found"] },
      { step: "PARSE", done: Boolean(parsed.extraction), detail: parsed.chosen },
      { step: "INDEX", done: true, detail: "incremental index (index.js)" },
      { step: "LEARN_CONVENTIONS", done: Boolean(parsed.extraction?.symbols?.length), detail: `${parsed.extraction?.symbols?.length ?? 0} symbols observed` },
      { step: "OPERATE_CONSERVATIVELY", done: true, detail: adapter.adaptive ? "shallow adapter: minimal, reversible edits only" : "full adapter available" },
      { step: "VERIFY", done: false, detail: "verification runs after every mutation (verifyledger)" },
    ],
    conservativeRules: adapter.adaptive
      ? ["no bulk rewrites", "prefer additive changes", "run any discovered verifier after each change", "report uncertainty explicitly"]
      : [],
  }
}

/** Catalog size for /doctor + tests. */
export function catalogSize() {
  return { deep: ADAPTERS.length, shallow: EXTENSION_LANGUAGES.length, total: ADAPTERS.length + EXTENSION_LANGUAGES.length }
}

/**
 * §15 (v93 gap fix) — STRUCTURED symbol extraction, LSP-first.
 *
 * The ladder finally does what it reports: when an LSP server is configured
 * for this file's extension, the file is opened in the server and its symbols
 * come from textDocument/documentSymbol (layer 3 — the server's real parser,
 * not regex). On ANY failure — server missing, crash, timeout — extraction
 * degrades to the lexical adapter and SAYS so. The result always carries
 * `provenance` = { layer, source } so no consumer can mistake regex output
 * for parser output.
 */
export async function extractStructured(file, src = "", { config = null, cwd = process.cwd() } = {}) {
  const rel = String(file ?? "")
  const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
  const found = (() => { try { return serverForFile(config, abs) } catch { return null } })()
  if (found) {
    let client = null
    try {
      client = await connectServer(found.name, found.spec, { rootUri: pathToUri(cwd) })
      let text = src
      if (text == null) { try { text = fs.readFileSync(abs, "utf8") } catch { text = "" } }
      const symbols = await client.documentSymbols(pathToUri(abs), languageIdForFile(abs, found.spec), text)
      if (Array.isArray(symbols) && symbols.length) {
        return {
          symbols: symbols.map((s) => s.name),
          structured: symbols,
          provenance: { layer: 3, source: `lsp:${found.name}` },
          fallback: null,
        }
      }
      // a server that returns zero symbols is not structured extraction —
      // fall through honestly rather than fabricating an empty success
      return treeSitterOr(rel, src, cwd, {
        symbols: extractSymbols(rel, src ?? ""),
        structured: null,
        provenance: { layer: 8, source: "lexical (lang.js)" },
        fallback: "lsp-returned-no-symbols",
      })
    } catch (e) {
      return treeSitterOr(rel, src, cwd, {
        symbols: extractSymbols(rel, src ?? ""),
        structured: null,
        provenance: { layer: 8, source: "lexical (lang.js)" },
        fallback: `lsp-failed: ${String(e?.message ?? e).slice(0, 160)}`,
      })
    } finally {
      try { client?.close() } catch { }
    }
  }
  // no server configured — try layer 2 before conceding to the regex fallback
  return treeSitterOr(rel, src, cwd, {
    symbols: extractSymbols(rel, src ?? ""),
    structured: null,
    provenance: { layer: 8, source: "lexical (lang.js)" },
    fallback: "lsp-not-configured",
  })
}

/**
 * v101 P1: layer 2, finally consumed. Before this, langadapter PROBED for the
 * tree-sitter binary, advertised it in the ladder, and never called it — a file
 * with no language server fell straight from layer 3 to the layer-8 regex.
 *
 * Tried only AFTER the LSP path has produced nothing, so a working language
 * server is never displaced: this strictly ADDS structured extraction to files
 * that would otherwise get lexical-only. When tree-sitter is absent, fails, or
 * finds no declarations, the caller's prepared lexical result is returned
 * unchanged — including its honest `fallback` reason.
 */
function treeSitterOr(rel, src, cwd, lexicalResult) {
  try {
    const ts = extractViaTreeSitter(rel, src ?? "", { cwd })
    if (ts) return ts
  } catch { /* layer 2 is additive; it must never break extraction */ }
  return lexicalResult
}

/**
 * v92 "wirewise" — per-language coverage lookup for runtime prompts.
 * Maps a language id (or name) to its honest adapter status:
 *   deep         lang.js owns symbol/import/export/call extraction
 *   shallow      extension catalog knows it — conservative mode
 *   unknown      not in either catalog
 * Runtime consumers (agent.js / meta.js) use this to tell the model the
 * truth about how well Forge can parse what it is about to touch.
 */
export function languageCoverage(langIds = []) {
  const deepIds = new Set(ADAPTERS.map((a) => String(a.id ?? "").toLowerCase()))
  const shallowById = new Map(EXTENSION_LANGUAGES.map((l) => [String(l.id).toLowerCase(), l]))
  const byName = new Map(EXTENSION_LANGUAGES.map((l) => [String(l.name).toLowerCase(), l]))
  const out = []
  const seen = new Set()
  for (const raw of langIds) {
    const id = String(raw ?? "").trim().toLowerCase()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const shallow = shallowById.get(id) ?? byName.get(id) ?? null
    if (deepIds.has(id)) out.push({ id, deep: true, conservative: false, note: "deep adapter (symbols/imports/exports)" })
    else if (shallow) out.push({ id, deep: false, conservative: true, note: `shallow adapter — conservative mode${shallow.bins?.length ? `, toolchain bins: ${shallow.bins.slice(0, 3).join("/")}` : ""}` })
    else if (id === "unknown") continue
    else out.push({ id, deep: false, conservative: true, note: "not in the adapter catalog — conservative mode" })
  }
  return out
}

/**
 * v92 "wirewise" — bounded adapter brief for concrete files about to be
 * touched (DAG node targets / planning). One honest line per file:
 * language, deep vs conservative, best available parse layer, compiler
 * presence. Never invents capabilities (§100 honest-UNAVAILABLE).
 */
export function adapterBrief(files = [], { maxFiles = 8, maxChars = 600 } = {}) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean).slice(0, maxFiles)
  if (!list.length) return ""
  const lines = []
  for (const f of list) {
    try {
      const a = adapterFor(String(f))
      const compiled = a.capabilities?.compiler ? `compiler ${a.capabilities.compiler.binaries[0]}` : "no compiler found"
      const mode = a.deep ? "deep" : "conservative"
      lines.push(`${path$basename(String(f))}: ${a.id} [${mode}] — ${compiled}, lexical extraction${a.adaptive ? ", minimal reversible edits only" : ""}`)
    } catch { /* one bad file must never break the brief */ }
  }
  if (!lines.length) return ""
  const header = `--- language adapter status (honest capability report) ---`
  const text = `${header}\n${lines.join("\n")}`
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text
}

function path$basename(f) {
  const i = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"))
  return i === -1 ? f : f.slice(i + 1)
}

function extOf(file) {
  const m = String(file ?? "").toLowerCase().match(/\.[a-z0-9]+$/)
  return m ? m[0] : ""
}

function hasPkgMetadata(cwd) {
  for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "composer.lock", "Gemfile.lock", "pubspec.lock"]) {
    try { if (fs.existsSync(`${cwd}/${f}`)) return true } catch { }
  }
  return false
}
