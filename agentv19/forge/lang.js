/**
 * forge — language intelligence (v32, zero dependencies)
 *
 * UNIFIED §32: grow language coverage without rewriting the core and without
 * Tree-sitter as a runtime dep. Adapters are data + regex. Unknown language
 * is discovered (ext / shebang / basename), not refused.
 *
 * JS / Python / Go / Rust extractors are the v23 regexes moved here so the
 * repo-map contract stays byte-stable. Extra adapters (Java, Kotlin, Ruby,
 * PHP, C/C++, C#, Swift, Dart, Zig, Elixir, Shell, SQL, Terraform, …) add
 * symbols the map previously skipped.
 */
import fs from "node:fs"
import path from "node:path"

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"])
const PY_EXT = new Set([".py", ".pyw"])
const GO_EXT = new Set([".go"])
const RS_EXT = new Set([".rs"])

function uniq(arr, cap = 40) {
  return [...new Set((arr || []).filter(Boolean))].slice(0, cap)
}

function matchAll(src, re, pick = 1) {
  const out = []
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  let m
  while ((m = r.exec(src))) out.push(m[pick] || m[1] || m[2] || m[0])
  return out
}

// ---------------------------------------------------------------------------
// v23 extractors (frozen for JS/PY/GO/RS — test-repomap pins them)
// ---------------------------------------------------------------------------

export function jsSymbols(src) {
  const out = []
  const re = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  const reNamed = /^\s*export\s*\{([^}]+)\}/gm
  while ((m = reNamed.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name)
    }
  }
  return out
}
export function pySymbols(src) {
  const out = []
  const re = /^(?:def|class)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}
export function goSymbols(src) {
  const out = []
  const re = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return out
}
export function rsSymbols(src) {
  const out = []
  const re = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

function jsImports(src) {
  const out = []
  const re = /^\s*import\s+(?:.*?\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return uniq(out, 20)
}
function pyImports(src) {
  const out = []
  const re = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return uniq(out, 20)
}
function goImports(src) {
  const out = []
  const re = /^\s*import\s+(?:\(\s*)?["']([^"']+)["']/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, 20)
}

function jsExports(src) {
  const out = []
  const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, 20)
}
function jsCalls(src) {
  const out = []
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g
  let m
  let count = 0
  while ((m = re.exec(src)) && count < 30) {
    const name = m[1]
    if (!["if", "for", "while", "switch", "catch", "function", "return", "import", "export"].includes(name)) {
      out.push(name)
      count++
    }
  }
  return uniq(out, 20)
}
function jsTypes(src, file) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return []
  const out = []
  const re = /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, 20)
}

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

export const ADAPTERS = Object.freeze([
  { id: "javascript", name: "JavaScript", ext: [".js", ".mjs", ".cjs", ".jsx"], shebang: /\b(node|nodejs)\b/i, family: "js" },
  { id: "typescript", name: "TypeScript", ext: [".ts", ".tsx", ".mts", ".cts"], family: "js" },
  { id: "python", name: "Python", ext: [".py", ".pyw"], shebang: /\bpython[0-9.]*\b/i, files: ["Pipfile"] },
  { id: "go", name: "Go", ext: [".go"], files: ["go.mod"] },
  { id: "rust", name: "Rust", ext: [".rs"], files: ["Cargo.toml"] },
  { id: "java", name: "Java", ext: [".java"], files: ["pom.xml"] },
  { id: "kotlin", name: "Kotlin", ext: [".kt", ".kts"] },
  { id: "ruby", name: "Ruby", ext: [".rb"], shebang: /\bruby\b/i, files: ["Gemfile"] },
  { id: "php", name: "PHP", ext: [".php"], shebang: /\bphp\b/i, files: ["composer.json"] },
  { id: "c", name: "C", ext: [".c", ".h"] },
  { id: "cpp", name: "C++", ext: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
  { id: "csharp", name: "C#", ext: [".cs"] },
  { id: "swift", name: "Swift", ext: [".swift"] },
  { id: "dart", name: "Dart", ext: [".dart"] },
  { id: "zig", name: "Zig", ext: [".zig"] },
  { id: "elixir", name: "Elixir", ext: [".ex", ".exs"] },
  { id: "shell", name: "Shell", ext: [".sh", ".bash", ".zsh"], shebang: /\b(bash|sh|zsh|dash)\b/i },
  { id: "sql", name: "SQL", ext: [".sql"] },
  { id: "terraform", name: "Terraform", ext: [".tf", ".tfvars"] },
  { id: "docker", name: "Docker", files: ["Dockerfile", "Dockerfile.dev"] },
  { id: "make", name: "Make", files: ["Makefile", "makefile", "GNUmakefile"] },
])

export const UNKNOWN = Object.freeze({ id: "unknown", name: "Unknown", ext: [] })

const EXT_TO = new Map()
const FILE_TO = new Map()
for (const a of ADAPTERS) {
  for (const e of a.ext || []) EXT_TO.set(e, a)
  for (const f of a.files || []) FILE_TO.set(f, a)
}

export function detectLanguage(file, src = "") {
  const base = path.basename(String(file || ""))
  if (FILE_TO.has(base)) return FILE_TO.get(base)
  const ext = path.extname(base).toLowerCase()
  if (EXT_TO.has(ext)) return EXT_TO.get(ext)
  const head = String(src || "").slice(0, 160)
  const bang = head.match(/^#!\s*(\S+[^\n]*)/m)
  if (bang) {
    const line = bang[0]
    for (const a of ADAPTERS) {
      if (a.shebang && a.shebang.test(line)) return a
    }
  }
  return UNKNOWN
}

export function isSourceFile(file, src = "") {
  const lang = detectLanguage(file, src)
  return lang.id !== "unknown" && lang.id !== "docker" && lang.id !== "make"
}

export function isConfigFile(file) {
  const base = path.basename(String(file || "")).toLowerCase()
  if (["package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "makefile", ".gitignore",
    "gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "dockerfile",
    "requirements.txt", "pipfile", "go.sum"].includes(base)) return true
  const ext = path.extname(base).toLowerCase()
  return [".toml", ".yaml", ".yml", ".ini", ".cfg", ".json", ".tf", ".tfvars"].includes(ext)
}

export function isTestFile(file) {
  return /\.test\.|\.spec\.|__tests__|test_|_test\.go|_test\.py|\.test\.ts|\.test\.js|_spec\.rb|Tests\.java/i.test(String(file || ""))
}

export function extractSymbols(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsSymbols(src)
  if (lang.id === "python") return pySymbols(src)
  if (lang.id === "go") return goSymbols(src)
  if (lang.id === "rust") return rsSymbols(src)
  switch (lang.id) {
    case "java":
    case "kotlin":
      return uniq([
        ...matchAll(src, /^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record|object|fun)\s+(\w+)/gm),
      ])
    case "ruby":
      return uniq(matchAll(src, /^(?:def|class|module)\s+(\w+)/gm))
    case "php":
      return uniq(matchAll(src, /^\s*(?:class|function|interface|trait)\s+(\w+)/gm))
    case "c":
    case "cpp":
      return uniq(matchAll(src, /^(?:[A-Za-z_][\w\s\*]*)\b([A-Za-z_]\w+)\s*\([^;]*\)\s*\{/gm))
    case "csharp":
      return uniq(matchAll(src, /^\s*(?:public|internal|protected|private)?\s*(?:static\s+)?(?:class|interface|struct|enum|record)\s+(\w+)/gm))
    case "swift":
      return uniq(matchAll(src, /^\s*(?:public\s+|private\s+|internal\s+)?(?:func|class|struct|enum|protocol)\s+(\w+)/gm))
    case "dart":
      return uniq(matchAll(src, /^(?:class|mixin|enum|void|Future)\s+(\w+)/gm))
    case "zig":
      return uniq(matchAll(src, /^\s*pub\s+(?:fn|const|var)\s+(\w+)/gm))
    case "elixir":
      return uniq(matchAll(src, /^\s*(?:def|defp|defmodule)\s+(\w+)/gm))
    case "sql":
      return uniq(matchAll(src, /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/gim))
    case "terraform":
      return uniq(matchAll(src, /^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm, 2))
    case "shell":
      return uniq(matchAll(src, /^(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\)|\{)/gm))
    default:
      return []
  }
}

export function extractImports(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsImports(src)
  if (lang.id === "python") return pyImports(src)
  if (lang.id === "go") return goImports(src)
  switch (lang.id) {
    case "rust":
      return uniq(matchAll(src, /^\s*use\s+([A-Za-z0-9_:]+)/gm), 20)
    case "java":
    case "kotlin":
      return uniq(matchAll(src, /^\s*import\s+([\w.*]+)/gm), 20)
    case "ruby":
      return uniq(matchAll(src, /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm), 20)
    case "php":
      return uniq(matchAll(src, /^\s*(?:use|require|include)(?:_once)?\s+\\?([\w\\]+)/gm), 20)
    case "c":
    case "cpp":
      return uniq(matchAll(src, /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm), 20)
    case "csharp":
      return uniq(matchAll(src, /^\s*using\s+([\w.]+)\s*;/gm), 20)
    case "swift":
      return uniq(matchAll(src, /^\s*import\s+(\w+)/gm), 20)
    case "dart":
      return uniq(matchAll(src, /^\s*import\s+["']([^"']+)["']/gm), 20)
    case "elixir":
      return uniq(matchAll(src, /^\s*alias\s+([\w.]+)/gm), 20)
    default:
      return []
  }
}

export function extractExports(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsExports(src)
  return []
}

export function extractCalls(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsCalls(src)
  return []
}

export function extractTypes(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsTypes(src, file)
  return []
}

export function extractRecord(file, src, fullPath = file) {
  const lang = detectLanguage(file, src)
  const symbols = [...new Set(extractSymbols(file, src))]
  return {
    lang: lang.id,
    symbols,
    imports: extractImports(file, src),
    exports: extractExports(file, src),
    calls: extractCalls(file, src),
    types: extractTypes(file, src),
    test: isTestFile(fullPath),
    config: isConfigFile(file),
  }
}

/**
 * Project-native toolchain from manifests that actually exist.
 * Never invents a command for a missing ecosystem.
 */
export function discoverToolchain(cwd = process.cwd()) {
  const has = (f) => {
    try { return fs.existsSync(path.join(cwd, f)) } catch { return false }
  }
  const out = { test: "", build: "", lint: "", format: "", languages: [] }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
      if (pkg.scripts?.test) out.test = "npm test"
      else if (pkg.scripts?.build) out.build = "npm run build"
      if (pkg.scripts?.lint) out.lint = "npm run lint"
      if (pkg.scripts?.build && !out.build) out.build = "npm run build"
      out.languages.push("javascript")
    } catch {}
  }
  if (!out.test && (has("pytest.ini") || has("pyproject.toml") || has("conftest.py"))) {
    out.test = "pytest -q"
    out.languages.push("python")
  }
  if (!out.test && has("go.mod")) { out.test = "go test ./..."; out.languages.push("go") }
  if (!out.test && has("Cargo.toml")) { out.test = "cargo test"; out.languages.push("rust") }
  if (!out.test && has("Gemfile")) { out.test = has("spec") || has("spec/") ? "bundle exec rspec" : "bundle exec rake test"; out.languages.push("ruby") }
  if (!out.test && has("composer.json")) { out.test = "vendor/bin/phpunit"; out.languages.push("php") }
  if (!out.test && has("pom.xml")) { out.test = "mvn test"; out.languages.push("java") }
  if (!out.test && (has("build.gradle") || has("build.gradle.kts"))) { out.test = "gradle test"; out.languages.push("java") }
  if (!out.test && has("Makefile")) out.test = "make test"
  return out
}

export function adapterCount() {
  return ADAPTERS.length
}
