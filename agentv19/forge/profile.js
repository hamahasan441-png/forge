/**
 * forge — project intelligence + resource awareness (v20).
 *
 * Project profile: detects languages, package manager, build/test/lint
 * commands, entry points, git branch — ONCE — and caches it at
 * ~/.forge/projects/<hash>/profile.json. Refreshed only when the repo's
 * signature changes (key files' mtimes/count). A compact summary goes into
 * agent/chat system prompts so the model does not re-discover the basics
 * on every task.
 *
 * Resource profile: cores + free memory → "low" | "normal" | "high" tier,
 * used to scale sub-agent concurrency and caches (ARM64/Termux friendly:
 * a 1-2GB phone gets 1 delegate and tighter budgets, not a crash).
 *
 * Zero dependencies; every call is best-effort and never throws.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { projectDir } from "./memory.js"

// --- resource awareness -------------------------------------------------------

export function resourceProfile() {
  const cores = os.cpus()?.length ?? 1
  const freeMB = Math.round(os.freemem() / (1024 * 1024))
  const totalMB = Math.round(os.totalmem() / (1024 * 1024))
  const low = freeMB < 700 || totalMB < 2048 || cores <= 2
  const high = !low && cores >= 6 && freeMB > 4000
  return { cores, freeMB, totalMB, tier: low ? "low" : high ? "high" : "normal" }
}

// --- project profile ----------------------------------------------------------

const LANG_EXT = {
  js: 0, mjs: 0, cjs: 0, jsx: 0, ts: 0, tsx: 0, py: 0, rs: 0, go: 0, java: 0,
  rb: 0, php: 0, c: 0, h: 0, cpp: 0, cc: 0, hpp: 0, cs: 0, swift: 0, kt: 0,
  sh: 0, bash: 0, lua: 0, dart: 0, ex: 0, exs: 0,
}
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", ".turbo", ".cache", "venv", ".venv", "target", "vendor", ".forge"])

function detectLangs(cwd) {
  const counts = { ...LANG_EXT }
  let files = 0
  const walk = (dir, depth) => {
    if (depth > 3 || files > 4000) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files > 4000) return
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else {
        files++
        const ext = e.name.split(".").pop()?.toLowerCase()
        if (ext in counts) counts[ext]++
      }
    }
  }
  walk(cwd, 0)
  const langs = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([ext, n]) => ({ ext, n }))
  return { langs, files }
}

function detectPackageManager(cwd, langs) {
  const has = (f) => fs.existsSync(path.join(cwd, f))
  if (has("package.json")) {
    if (has("pnpm-lock.yaml")) return { manager: "pnpm", install: "pnpm install", run: "pnpm" }
    if (has("yarn.lock")) return { manager: "yarn", install: "yarn", run: "yarn" }
    if (has("bun.lockb") || has("bun.lock")) return { manager: "bun", install: "bun install", run: "bun" }
    return { manager: "npm", install: "npm install", run: "npm" }
  }
  if (has("requirements.txt") || has("pyproject.toml") || langs.some((l) => l.ext === "py")) {
    if (has("poetry.lock")) return { manager: "poetry", install: "poetry install", run: "poetry" }
    return { manager: "pip", install: "pip install -r requirements.txt", run: "python" }
  }
  if (has("Cargo.toml")) return { manager: "cargo", install: "cargo fetch", run: "cargo" }
  if (has("go.mod")) return { manager: "go", install: "go mod download", run: "go" }
  if (has("Gemfile")) return { manager: "bundler", install: "bundle install", run: "bundle" }
  if (has("composer.json")) return { manager: "composer", install: "composer install", run: "composer" }
  return null
}

function detectScripts(cwd, pm) {
  const out = {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
    const s = pkg.scripts ?? {}
    out.test = s.test ? `${pm?.run ?? "npm"} run test` : null
    out.build = s.build ? `${pm?.run ?? "npm"} run build` : null
    out.lint = s.lint ? `${pm?.run ?? "npm"} run lint` : null
    out.start = s.start ? `${pm?.run ?? "npm"} run start` : null
    out.name = pkg.name ?? null
    if (/vitest|jest|mocha|node --test/.test(String(s.test))) out.testFramework = "bundled"
  } catch {}
  if (!out.test && pm?.manager === "pip" && fs.existsSync(path.join(cwd, "pytest.ini"))) out.test = "pytest"
  if (!out.test && fs.existsSync(path.join(cwd, "Cargo.toml"))) out.test = "cargo test"
  if (!out.test && fs.existsSync(path.join(cwd, "go.mod"))) out.test = "go test ./..."
  return out
}

function detectEntryPoints(cwd) {
  const cands = ["index.js", "index.mjs", "index.ts", "main.py", "src/index.js", "src/index.ts", "src/main.py", "main.go", "src/main.rs", "cmd/main.go", "app.py", "manage.py", "forge.js"]
  return cands.filter((c) => fs.existsSync(path.join(cwd, c))).slice(0, 4)
}

function detectGit(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).length
    return { branch, dirty }
  } catch {
    return null
  }
}

function detectFramework(cwd) {
  try {
    const deps = { ...JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).dependencies, ...JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).devDependencies }
    const hits = []
    if (deps.next) hits.push("Next.js")
    if (deps.react && !deps.next) hits.push("React")
    if (deps.vue) hits.push("Vue")
    if (deps.express) hits.push("Express")
    if (deps.fastify) hits.push("Fastify")
    if (deps.prisma) hits.push("Prisma")
    if (deps.electron) hits.push("Electron")
    if (deps.typescript) hits.push("TypeScript")
    return hits.slice(0, 3)
  } catch {
    return []
  }
}

function signature(cwd) {
  try {
    const files = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Makefile", "README.md", "index.js", "src"]
    let sig = ""
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(cwd, f))
        sig += `${f}:${st.mtimeMs.toFixed(0)};`
      } catch {}
    }
    let count = 0
    try { count = fs.readdirSync(cwd).length } catch {}
    return `${sig}|${count}`
  } catch {
    return ""
  }
}

function detectProfile(cwd) {
  const { langs, files } = detectLangs(cwd)
  const pm = detectPackageManager(cwd, langs)
  const scripts = detectScripts(cwd, pm)
  return {
    ts: Date.now(),
    signature: signature(cwd),
    root: path.resolve(cwd),
    name: scripts.name ?? path.basename(path.resolve(cwd)),
    langs,
    files,
    packageManager: pm,
    scripts,
    frameworks: detectFramework(cwd),
    entryPoints: detectEntryPoints(cwd),
    git: detectGit(cwd),
  }
}

/** Load (and refresh when stale) the cached profile for cwd. */
export function loadProfile(cwd = process.cwd(), { maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const dir = projectDir(cwd)
  const file = path.join(dir, "profile.json")
  const sig = signature(cwd)
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    const fresh = j.signature === sig && Date.now() - (j.ts ?? 0) < maxAgeMs
    if (fresh) return { ...j, cached: true }
  } catch {}
  const p = detectProfile(cwd)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(p, null, 1))
  } catch {}
  return { ...p, cached: false }
}

/** Compact prompt-ready summary. "" when the directory is not a code project. */
export function profileSummary(cwd = process.cwd()) {
  try {
    const p = loadProfile(cwd)
    if (!p.langs?.length && !p.packageManager && !p.git) return ""
    const parts = []
    parts.push(`${p.name}: ${p.langs.slice(0, 3).map((l) => l.ext).join("/") || "unknown"} (${p.files ?? "?"} files)`)
    if (p.git?.branch) parts.push(`git ${p.git.branch}${p.git.dirty ? ` (${p.git.dirty} dirty)` : " clean"}`)
    if (p.packageManager) parts.push(`pm ${p.packageManager.manager}`)
    if (p.scripts?.test) parts.push(`test: ${p.scripts.test}`)
    if (p.scripts?.build) parts.push(`build: ${p.scripts.build}`)
    if (p.scripts?.lint) parts.push(`lint: ${p.scripts.lint}`)
    if (p.frameworks?.length) parts.push(`stack: ${p.frameworks.join(", ")}`)
    return `PROJECT: ${parts.join(" • ")}`
  } catch {
    return ""
  }
}
