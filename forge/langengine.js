/**
 * forge — language-aware engine (v37 + v38, zero dependencies)
 *
 * UNIFIED §6: determine language, version, framework, package manager,
 * compiler, formatter, linter, typechecker, generated-code boundaries
 * from files that actually exist. LSP and compiler binaries are optional:
 * present or UNAVAILABLE — never invented, never spawned for --version.
 *
 * No Tree-sitter. discoverToolchain() stays frozen (v32). MICRO/SMALL get
 * no engine dump unless the task names a language.
 */
import fs from "node:fs"
import path from "node:path"
import { classifyTask, TASK_CLASS } from "./classify.js"
import { namedLangIn } from "./langreason.js"
import { discoverToolchain, detectLanguage } from "./lang.js"
import { serverForFile } from "./lsp.js"

export const GENERATED_DIRS = Object.freeze([
  "dist", "build", "target", "out", ".next", "__pycache__", "node_modules",
  "vendor", "generated", "gen", ".tox", ".venv", "coverage",
])

function has(cwd, name) {
  try { return fs.existsSync(path.join(cwd, name)) } catch { return false }
}

function readText(cwd, name, cap = 16_000) {
  try { return fs.readFileSync(path.join(cwd, name), "utf8").slice(0, cap) } catch { return "" }
}

function readJSON(cwd, name) {
  const t = readText(cwd, name)
  if (!t) return null
  try { return JSON.parse(t) } catch { return null }
}

/** Exists on PATH (or as an explicit path). Does not execute. */
export function binaryOnPath(bin) {
  const raw = String(bin || "").trim()
  if (!raw) return false
  const name = raw.split(/\s+/)[0]
  if (!name) return false
  if (name.includes("/") || name.includes("\\")) {
    try { return fs.existsSync(name) } catch { return false }
  }
  const env = process.env.PATH || ""
  for (const dir of env.split(path.delimiter)) {
    if (!dir) continue
    try {
      if (fs.existsSync(path.join(dir, name))) return true
    } catch {}
  }
  return false
}

export function lspAvailability(config = {}) {
  const servers = config?.lsp?.servers
  if (!servers || typeof servers !== "object") return []
  const out = []
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || spec.disabled === true) continue
    const command = spec.command || ""
    out.push({
      name,
      command,
      available: command ? binaryOnPath(command) : false,
    })
  }
  return out.slice(0, 12)
}

function generatedDirs(cwd) {
  return GENERATED_DIRS.filter((d) => has(cwd, d))
}

/** First generated-dir component in a project-relative path, or "". */
export function generatedBoundary(abs, cwd) {
  let rel
  try { rel = path.relative(path.resolve(cwd || process.cwd()), path.resolve(abs)) } catch { return "" }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return ""
  const parts = rel.split(/[\\/]/)
  for (const p of parts.slice(0, -1)) {
    if (GENERATED_DIRS.includes(p)) return p
  }
  return ""
}

/**
 * The toolchain stack that covers these files, from manifests that exist.
 * Null when nothing matches. Never invents a stack.
 *
 * v92: extracted from recommendedVerify so the verification pipeline can ask for
 * the whole stack (test AND lint AND typecheck AND build) instead of only the
 * first command that happens to exist — the matching rule stays in one place.
 * @returns {{id,language,test,build,lint,format,typecheck}|null}
 */
export function stackFor(cwd = process.cwd(), files = []) {
  let info
  try { info = inspectProject(cwd) } catch { return null }
  const stacks = info.stacks || []
  if (!stacks.length) return null
  const langs = new Set()
  for (const f of files || []) {
    try {
      const id = detectLanguage(f).id
      if (id && id !== "unknown") langs.add(id)
    } catch {}
  }
  const hit = langs.size
    ? stacks.find((s) => langs.has(s.id) || langs.has(s.language)
      || (s.id === "javascript" && langs.has("typescript"))
      || (s.id === "typescript" && langs.has("javascript")))
    : null
  return hit || (langs.size === 0 ? stacks[0] : null) || null
}

/**
 * Native test/typecheck for the files' language, from manifests that exist.
 * Empty when no stack matches. Never invents a command.
 */
export function recommendedVerify(cwd = process.cwd(), files = []) {
  const s = stackFor(cwd, files)
  if (!s) return ""
  return s.test || s.typecheck || s.build || ""
}

function npmPm(cwd) {
  if (has(cwd, "pnpm-lock.yaml")) return "pnpm"
  if (has(cwd, "yarn.lock")) return "yarn"
  if (has(cwd, "bun.lockb") || has(cwd, "bun.lock")) return "bun"
  if (has(cwd, "package-lock.json")) return "npm"
  return "npm"
}

function jsFramework(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
  const names = Object.keys(deps).map((k) => k.toLowerCase())
  const hasDep = (n) => names.includes(n)
  if (hasDep("next")) return "next"
  if (hasDep("nuxt")) return "nuxt"
  if (hasDep("remix") || hasDep("@remix-run/node")) return "remix"
  if (hasDep("@nestjs/core")) return "nestjs"
  if (hasDep("express")) return "express"
  if (hasDep("fastify")) return "fastify"
  if (hasDep("svelte") || hasDep("@sveltejs/kit")) return "svelte"
  if (hasDep("vue")) return "vue"
  if (hasDep("react")) return "react"
  return ""
}

function rustFramework(toml) {
  const t = String(toml || "")
  if (/\baxum\s*=/.test(t)) return "axum"
  if (/\bactix-web\s*=/.test(t)) return "actix-web"
  if (/\brocket\s*=/.test(t)) return "rocket"
  if (/\btokio\s*=/.test(t)) return "tokio"
  return ""
}

function pythonPm(cwd, toml) {
  if (has(cwd, "uv.lock") || /\[tool\.uv\]/.test(toml)) return "uv"
  if (has(cwd, "poetry.lock") || /\[tool\.poetry\]/.test(toml)) return "poetry"
  if (has(cwd, "Pipfile")) return "pipenv"
  if (has(cwd, "pyproject.toml") || has(cwd, "requirements.txt") || has(cwd, "setup.py")) return "pip"
  return ""
}

function pythonFramework(text) {
  const t = String(text || "").toLowerCase()
  if (/\bdjango\b/.test(t)) return "django"
  if (/\bflask\b/.test(t)) return "flask"
  if (/\bfastapi\b/.test(t)) return "fastapi"
  return ""
}

function stack({ id, language, version = "", pm = "", framework = "", test = "", build = "", lint = "", format = "", typecheck = "", runtime = "", compiler = "", source = "manifest" }) {
  return { id, language, version, pm, framework, test, build, lint, format, typecheck, runtime, compiler, source }
}

/**
 * All stacks whose manifests exist. Unlike discoverToolchain, mixed
 * npm+cargo reports both. Never invents a command for a missing ecosystem.
 */
export function inspectProject(cwd = process.cwd(), { config } = {}) {
  const stacks = []
  const toolchain = (() => { try { return discoverToolchain(cwd) } catch { return { test: "", build: "", lint: "", format: "", languages: [] } } })()

  if (has(cwd, "package.json")) {
    const pkg = readJSON(cwd, "package.json") || {}
    const ts = has(cwd, "tsconfig.json")
    const eslint = has(cwd, "eslint.config.js") || has(cwd, "eslint.config.mjs") || has(cwd, ".eslintrc.js") || has(cwd, ".eslintrc.json") || has(cwd, ".eslintrc.cjs")
    const prettier = has(cwd, ".prettierrc") || has(cwd, ".prettierrc.json") || has(cwd, "prettier.config.js") || !!(pkg.devDependencies?.prettier || pkg.dependencies?.prettier)
    stacks.push(stack({
      id: ts ? "typescript" : "javascript",
      language: ts ? "typescript" : "javascript",
      version: pkg.engines?.node ? String(pkg.engines.node) : "",
      pm: npmPm(cwd),
      framework: jsFramework(pkg),
      test: pkg.scripts?.test ? "npm test" : (toolchain.test || ""),
      build: pkg.scripts?.build ? "npm run build" : "",
      lint: pkg.scripts?.lint ? "npm run lint" : (eslint ? "eslint" : ""),
      format: prettier ? "prettier" : "",
      typecheck: ts ? "tsc" : "",
      runtime: "node",
      compiler: ts ? "tsc" : "node",
    }))
  }

  if (has(cwd, "Cargo.toml")) {
    const toml = readText(cwd, "Cargo.toml")
    const edition = /edition\s*=\s*"(\d+)"/.exec(toml)?.[1] || ""
    const clippy = has(cwd, "clippy.toml") || /\[lints\]/.test(toml) || /\[lints\.clippy\]/.test(toml)
    stacks.push(stack({
      id: "rust",
      language: "rust",
      version: edition ? `edition ${edition}` : "",
      pm: "cargo",
      framework: rustFramework(toml),
      test: "cargo test",
      build: "cargo build",
      lint: clippy ? "cargo clippy" : "",
      format: has(cwd, "rustfmt.toml") || has(cwd, ".rustfmt.toml") ? "cargo fmt" : "",
      typecheck: "cargo check",
      runtime: "",
      compiler: "rustc",
    }))
  }

  if (has(cwd, "go.mod")) {
    const mod = readText(cwd, "go.mod")
    const ver = /^go\s+(\d+\.\d+)/m.exec(mod)?.[1] || ""
    stacks.push(stack({
      id: "go", language: "go", version: ver, pm: "go",
      test: "go test ./...", build: "go build ./...",
      format: "gofmt", typecheck: "go vet ./...", compiler: "go", runtime: "",
    }))
  }

  if (has(cwd, "pyproject.toml") || has(cwd, "pytest.ini") || has(cwd, "conftest.py") || has(cwd, "requirements.txt") || has(cwd, "setup.py")) {
    const toml = readText(cwd, "pyproject.toml")
    const req = readText(cwd, "requirements.txt") + "\n" + toml
    const pyVer = /requires-python\s*=\s*"([^"]+)"/.exec(toml)?.[1]
      || /python\s*=\s*"([^"]+)"/.exec(toml)?.[1]
      || ""
    const ruff = has(cwd, "ruff.toml") || /\[tool\.ruff\]/.test(toml)
    const mypy = has(cwd, "mypy.ini") || /\[tool\.mypy\]/.test(toml)
    stacks.push(stack({
      id: "python", language: "python", version: pyVer, pm: pythonPm(cwd, toml),
      framework: pythonFramework(req),
      test: (has(cwd, "pytest.ini") || has(cwd, "conftest.py") || /\[tool\.pytest/.test(toml)) ? "pytest -q" : "",
      lint: ruff ? "ruff" : "",
      format: ruff ? "ruff format" : "",
      typecheck: mypy ? "mypy" : (has(cwd, "pyrightconfig.json") ? "pyright" : ""),
      runtime: "python",
      compiler: "",
    }))
  }

  if (has(cwd, "Gemfile")) {
    stacks.push(stack({
      id: "ruby", language: "ruby", pm: "bundler",
      framework: /rails/i.test(readText(cwd, "Gemfile")) ? "rails" : "",
      test: has(cwd, "spec") || has(cwd, "spec/") ? "bundle exec rspec" : "bundle exec rake test",
    }))
  }

  if (has(cwd, "composer.json")) {
    stacks.push(stack({
      id: "php", language: "php", pm: "composer",
      test: "vendor/bin/phpunit",
    }))
  }

  if (has(cwd, "pom.xml") || has(cwd, "build.gradle") || has(cwd, "build.gradle.kts")) {
    const maven = has(cwd, "pom.xml")
    stacks.push(stack({
      id: "java", language: "java", pm: maven ? "maven" : "gradle",
      framework: /springframework/i.test(readText(cwd, maven ? "pom.xml" : (has(cwd, "build.gradle.kts") ? "build.gradle.kts" : "build.gradle"))) ? "spring" : "",
      test: maven ? "mvn test" : "gradle test",
      build: maven ? "mvn package" : "gradle build",
    }))
  }

  return {
    stacks,
    generated: generatedDirs(cwd),
    lsp: lspAvailability(config),
    toolchain,
  }
}

function shouldSkip(task, klass) {
  const k = klass || (() => { try { return classifyTask(task || "").class } catch { return null } })()
  if (namedLangIn(task).length) return false
  return k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL
}

function filterStacks(info, task) {
  const named = namedLangIn(task)
  if (!named.length) return info.stacks || []
  const want = new Set(named)
  if (want.has("javascript")) want.add("typescript")
  if (want.has("typescript")) want.add("javascript")
  return (info.stacks || []).filter((s) => want.has(s.id) || want.has(s.language))
}

function status(bin) {
  if (!bin) return ""
  return binaryOnPath(bin) ? `${bin} present` : `${bin} UNAVAILABLE`
}

/**
 * Compact prompt slice. Empty when MICRO/SMALL and the language is not named.
 * Missing binaries are UNAVAILABLE, never faked.
 */
export function formatLangEngine(info, { task = "", klass = null, maxChars = 900 } = {}) {
  if (!info || shouldSkip(task, klass)) return ""
  const stacks = filterStacks(info, task)
  if (!stacks.length && !(info.generated || []).length && !(info.lsp || []).length) return ""
  const lines = ["LANGUAGE ENGINE (from project files, not guessed):"]
  for (const s of stacks.slice(0, 6)) {
    const bits = [s.language]
    if (s.version) bits.push(s.version)
    if (s.pm) bits.push(`pm=${s.pm}`)
    if (s.framework) bits.push(`framework=${s.framework}`)
    if (s.test) bits.push(`test=${s.test}`)
    if (s.build) bits.push(`build=${s.build}`)
    if (s.lint) bits.push(`lint=${s.lint}`)
    if (s.format) bits.push(`format=${s.format}`)
    if (s.typecheck) bits.push(`typecheck=${s.typecheck}`)
    const row = `- ${bits.join(" ")}`
    const tools = []
    if (s.compiler) tools.push(status(s.compiler))
    if (tools.length) lines.push(row, `  ${tools.join("  ")}`)
    else lines.push(row)
  }
  if ((info.generated || []).length) {
    lines.push(`generated (do not edit): ${info.generated.slice(0, 8).join(", ")}`)
  }
  if ((info.lsp || []).length) {
    const lsp = info.lsp.slice(0, 6).map((l) => `${l.name}${l.available ? "" : " UNAVAILABLE"}`).join(", ")
    lines.push(`lsp: ${lsp}`)
  }
  lines.push("Do not invent a toolchain that is not listed. Missing binaries are UNAVAILABLE.")
  let text = lines.join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  return text
}

export function engineFor(task, { cwd = process.cwd(), config = null, klass = null } = {}) {
  const info = inspectProject(cwd, { config })
  return formatLangEngine(info, { task, klass })
}

/** True when an LSP server is configured for this file (does not spawn it). */
export function lspConfiguredFor(file, config) {
  return Boolean(serverForFile(config, file))
}
