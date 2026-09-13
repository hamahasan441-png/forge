/**
 * forge — language-specific reasoning (v35, zero dependencies)
 *
 * UNIFIED §8: adapt planning / repair / verify to the language actually in
 * play. Never apply JavaScript patterns to Rust (or vice versa).
 *
 * Layer on lang.js adapters + discoverToolchain. No Tree-sitter. MICRO/SMALL
 * skip unless the task names a language ("rust", "cargo", "pytest", …).
 * A verify command is only returned when that ecosystem's manifest exists —
 * never invented.
 */
import fs from "node:fs"
import path from "node:path"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { detectLanguage, discoverToolchain } from "./lang.js"

const ALIASES = Object.freeze({
  rust: "rust", rs: "rust", cargo: "rust",
  python: "python", py: "python", pytest: "python", pyproject: "python",
  javascript: "javascript", js: "javascript", node: "javascript", npm: "javascript",
  typescript: "typescript", ts: "typescript",
  go: "go", golang: "go", goroutine: "go",
  c: "c",
  cpp: "cpp", cxx: "cpp",
  java: "java", jvm: "java",
  kotlin: "kotlin",
  swift: "swift",
  csharp: "csharp", dotnet: "csharp",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql",
  shell: "shell", bash: "shell", zsh: "shell",
  terraform: "terraform", hcl: "terraform",
  kubernetes: "kubernetes", k8s: "kubernetes", helm: "kubernetes",
})

export const SEMANTICS = Object.freeze({
  rust: {
    id: "rust", name: "Rust",
    constraints: [
      "Honor ownership, borrowing, and lifetimes. Do not clone to silence the borrow checker.",
      "Prefer owned types over fighting lifetime annotations.",
      "unsafe requires a documented invariant next to the block.",
      "Traits over inheritance. Spawned async tasks must be Send + 'static.",
    ],
    never: ["optional chaining", "try/except", "monkeypatch", "undefined behavior as a feature"],
    verify: "cargo test",
    manifests: ["Cargo.toml"],
  },
  python: {
    id: "python", name: "Python",
    constraints: [
      "Respect packaging (venv / pyproject / extras). Do not mutate global site-packages.",
      "Imports are runtime; circular imports and sys.path hacks are bugs, not fixes.",
      "Async is not threads. The GIL still serializes CPU-bound work.",
      "Prefer pytest. Do not invent a unittest layout the project does not use.",
    ],
    never: ["borrow checker", "optional chaining as a type system", "goroutines"],
    verify: "pytest -q",
    manifests: ["pyproject.toml", "pytest.ini", "conftest.py", "setup.py", "requirements.txt"],
  },
  javascript: {
    id: "javascript", name: "JavaScript",
    constraints: [
      "Honor the event loop. await I/O; do not block with sync fs in request paths.",
      "Promises and closures capture by reference. Race conditions hide in un-awaited calls.",
      "ESM vs CJS is a real boundary. Do not mix import and require in one file.",
    ],
    never: ["GIL", "clone-to-silence as a default fix", "RAII"],
    verify: "npm test",
    manifests: ["package.json"],
  },
  typescript: {
    id: "typescript", name: "TypeScript",
    constraints: [
      "Honor the type system. Do not `as any` / @ts-ignore to silence errors.",
      "Event loop + promises same as JavaScript. Types erase at runtime — validate at edges.",
      "ESM vs CJS is a real boundary.",
    ],
    never: ["GIL", "clone-to-silence as a default fix"],
    verify: "npm test",
    manifests: ["package.json", "tsconfig.json"],
  },
  go: {
    id: "go", name: "Go",
    constraints: [
      "Goroutines need a stop signal. Do not leak them. Channels are for coordination, not a bus.",
      "Interfaces are implicit. Do not invent inheritance.",
      "Modules: go.mod is the source of truth. Do not vendor by copying.",
    ],
    never: ["try/except", "optional chaining", "class inheritance"],
    verify: "go test ./...",
    manifests: ["go.mod"],
  },
  c: {
    id: "c", name: "C",
    constraints: [
      "Memory and ABI are explicit. Every alloc needs an owner. No use-after-free.",
      "Undefined behavior is a bug, not a compiler quirk. Do not 'fix' it with another UB.",
    ],
    never: ["garbage collection as a given", "optional chaining"],
    verify: "",
    manifests: ["Makefile", "CMakeLists.txt"],
  },
  cpp: {
    id: "cpp", name: "C++",
    constraints: [
      "RAII owns resources. Prefer unique_ptr/lock_guard over raw new/unlock.",
      "Templates are compile-time. Undefined behavior is a bug.",
      "ABI and linkage matter at FFI boundaries.",
    ],
    never: ["garbage collection as a given", "optional chaining"],
    verify: "",
    manifests: ["CMakeLists.txt", "Makefile"],
  },
  java: {
    id: "java", name: "Java",
    constraints: [
      "Nullability is real. Honor Optional / @Nullable; do not NPE-catch as control flow.",
      "Generics are erased. Reflection is a last resort.",
    ],
    never: ["GIL", "ownership clones"],
    verify: "mvn test",
    manifests: ["pom.xml", "build.gradle", "build.gradle.kts"],
  },
  kotlin: {
    id: "kotlin", name: "Kotlin",
    constraints: [
      "Nullability is in the type system. Coroutines are not threads; do not block the dispatcher.",
      "JVM interop: Java nulls still exist at the boundary.",
    ],
    never: ["GIL", "ownership clones"],
    verify: "gradle test",
    manifests: ["build.gradle.kts", "build.gradle"],
  },
  swift: {
    id: "swift", name: "Swift",
    constraints: [
      "ARC is not GC. Avoid retain cycles (closures vs self). Actors isolate mutable state.",
      "Optionals are types. Do not force-unwrap to silence the compiler.",
    ],
    never: ["GIL", "manual free as the default"],
    verify: "",
    manifests: ["Package.swift"],
  },
  csharp: {
    id: "csharp", name: "C#",
    constraints: [
      "async/await is not parallel by default. LINQ is deferred — enumerate once.",
      "Nullable reference types are real when enabled. Do not null-forgive to ship.",
    ],
    never: ["GIL", "ownership clones"],
    verify: "dotnet test",
    manifests: ["*.csproj"],
  },
  sql: {
    id: "sql", name: "SQL",
    constraints: [
      "Transactions and isolation are the correctness model. Indexes are not free.",
      "Constraints belong in the schema, not only in application code.",
    ],
    never: ["event-loop as the isolation model"],
    verify: "",
    manifests: [],
  },
  shell: {
    id: "shell", name: "Shell",
    constraints: [
      "Quote expansions. set -euo pipefail is not optional on new scripts.",
      "Pipes hide exit codes unless pipefail. Signals and word-splitting are real.",
    ],
    never: ["JSON.parse as the quoting model"],
    verify: "",
    manifests: [],
  },
  terraform: {
    id: "terraform", name: "Terraform",
    constraints: [
      "Declarative dependencies and remote state. Do not 'order' resources with sleep.",
      "State is the source of truth. A local apply against the wrong backend is a production incident.",
    ],
    never: ["imperative loops as the dependency graph"],
    verify: "",
    manifests: [],
  },
  kubernetes: {
    id: "kubernetes", name: "Kubernetes",
    constraints: [
      "Desired state + reconciliation. Patch the spec; do not docker exec a fix.",
      "Resources and cluster state drift. Honor probes, requests/limits, and RBAC.",
    ],
    never: ["ssh to a node as the change mechanism"],
    verify: "",
    manifests: [],
  },
})

const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length)

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function canonicalLang(id) {
  const raw = String(id ?? "").trim().toLowerCase()
  if (!raw) return null
  if (SEMANTICS[raw]) return raw
  if (ALIASES[raw]) return ALIASES[raw]
  if (raw === "c++") return "cpp"
  if (raw === "c#") return "csharp"
  return null
}

export function semanticsFor(id) {
  const c = canonicalLang(id)
  return c ? SEMANTICS[c] : null
}

export function namedLangIn(task) {
  const t = String(task ?? "")
  if (!t.trim()) return []
  const hit = new Set()
  for (const key of ALIAS_KEYS) {
    const re = new RegExp(`(?:^|[^A-Za-z0-9+])${escapeRe(key)}(?:[^A-Za-z0-9+]|$)`, "i")
    if (re.test(t)) {
      const c = ALIASES[key]
      if (c) hit.add(c)
    }
  }
  if (/\bc\+\+/i.test(t)) hit.add("cpp")
  if (/\bc#/i.test(t)) hit.add("csharp")
  return [...hit]
}

function klassOf(task, klass) {
  if (klass) return klass
  try { return classifyTask(task).class } catch { return null }
}

function isSmall(klass) {
  return klass === TASK_CLASS.MICRO || klass === TASK_CLASS.SMALL
}

function hasFile(cwd, name) {
  if (!cwd || !name) return false
  if (name.includes("*")) {
    try {
      const dir = cwd
      const re = new RegExp("^" + escapeRe(name).replace("\\*", ".*") + "$", "i")
      return fs.readdirSync(dir).some((f) => re.test(f))
    } catch { return false }
  }
  try { return fs.existsSync(path.join(cwd, name)) } catch { return false }
}

function langsFromFiles(files) {
  const out = []
  for (const f of files || []) {
    try {
      const id = canonicalLang(detectLanguage(String(f)).id)
      if (id && !out.includes(id)) out.push(id)
    } catch { /* ignore */ }
  }
  return out
}

function langsFromCwd(cwd) {
  if (!cwd) return []
  const out = []
  try {
    const t = discoverToolchain(cwd)
    for (const l of t.languages || []) {
      const id = canonicalLang(l)
      if (id && !out.includes(id)) out.push(id)
    }
  } catch { /* ignore */ }
  return out
}

/**
 * Languages that should constrain this turn.
 * MICRO/SMALL → [] unless the task names a language.
 */
export function languagesIn(task, { files, langs, cwd, klass } = {}) {
  const named = namedLangIn(task)
  const k = klassOf(task, klass)
  if (isSmall(k) && named.length === 0) return []
  const out = []
  const add = (id) => {
    const c = canonicalLang(id)
    if (c && !out.includes(c)) out.push(c)
  }
  for (const n of named) add(n)
  if (!isSmall(k) || named.length) {
    for (const x of langs || []) add(x)
    for (const x of langsFromFiles(files)) add(x)
    if (!isSmall(k)) for (const x of langsFromCwd(cwd)) add(x)
  }
  return out.slice(0, 4)
}

export function formatLangReason(langs, { maxChars = 900 } = {}) {
  const ids = (langs || []).map(canonicalLang).filter((id) => id && SEMANTICS[id])
  if (!ids.length) return ""
  const lines = ["LANGUAGE CONSTRAINTS (do not mix patterns across languages):"]
  const never = []
  for (const id of ids) {
    const s = SEMANTICS[id]
    lines.push(`${s.name}:`)
    for (const c of s.constraints) lines.push(`- ${c}`)
    never.push(...(s.never || []))
  }
  if (ids.length >= 2) {
    lines.push("Do not apply one language's patterns to another.")
  }
  if (never.length) {
    const uniq = [...new Set(never)].slice(0, 8)
    lines.push(`Do NOT: ${uniq.join("; ")}.`)
  }
  let text = lines.join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  return text
}

/** Native test command only when that ecosystem is actually present. */
export function verifyFor(langs, { cwd, toolchain } = {}) {
  const ids = (langs || []).map(canonicalLang).filter(Boolean)
  for (const id of ids) {
    const s = SEMANTICS[id]
    if (!s?.verify) continue
    if (!cwd) continue
    const manifests = s.manifests || []
    if (manifests.length && !manifests.some((m) => hasFile(cwd, m))) continue
    return s.verify
  }
  const t = toolchain || (cwd ? (() => { try { return discoverToolchain(cwd) } catch { return null } })() : null)
  return t?.test || t?.build || ""
}

export function mixedWarning(langs) {
  const ids = (langs || []).map(canonicalLang).filter(Boolean)
  return ids.length >= 2
}
