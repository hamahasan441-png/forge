/**
 * forge — workspace identity (v103, zero dependencies)
 *
 * THE DISTINCTION THIS MODULE EXISTS FOR:
 *
 *   FORGE_RUNTIME     the directory forge's own source lives in
 *   TARGET_WORKSPACE  the project the user's task is actually about
 *
 * Before this module nothing in the repository knew the difference — there was
 * no forgeRoot, no isForgeRuntime, nothing. Reproduced: launched from its own
 * source tree and asked "Build a REST API for my project", forge wrote
 * server.js into its own repository, reported COMPLETED, and nothing anywhere
 * said the working directory was forge itself.
 *
 * That only happens when forge runs FROM its own checkout, which is exactly
 * what someone developing forge does all day. A globally installed forge has
 * its runtime under node_modules and can never collide.
 *
 * The detection is EXACT, not a heuristic: this file's own location is the
 * forge runtime by definition (import.meta.url), so "is the cwd inside the
 * forge runtime" is a path containment test with no guessing in it.
 *
 * What this module does NOT do: decide for the user. Working on forge itself
 * is a legitimate task, so a collision is REPORTED with its evidence and the
 * task's own wording is what says whether forge is the intended target. The
 * resolver never overrides an explicitly selected workspace — sourceresolve.js
 * already owns explicit selection (--source), and this module reads its record
 * rather than re-deriving or competing with it.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { inspectProjectDir, gitRemoteUrl, readSourceRecord } from "./sourceresolve.js"

/** How the target workspace was decided, most authoritative first. */
export const RESOLUTION = Object.freeze({
  EXPLICIT: "explicit",          // a path the caller/user named outright
  SOURCE_RECORD: "source-record", // sourceresolve.js persisted an earlier explicit selection
  TASK_CONTEXT: "task-context",   // an active task already fixed its workspace
  CWD: "cwd",                     // the working directory, with nothing better available
})

/** Confidence in `targetWorkspace`. Only ever lowered by evidence, never raised. */
export const CONFIDENCE = Object.freeze({
  CERTAIN: "certain",      // the user said so, directly or in a persisted record
  LIKELY: "likely",        // cwd is an ordinary project and nothing contradicts it
  AMBIGUOUS: "ambiguous",  // cwd is forge's own tree and the task does not say forge
})

/**
 * The forge runtime root: the directory this module is in. Definitional — the
 * code that is running is the runtime, so there is nothing here to guess.
 */
export function forgeRuntimeRoot() {
  try { return path.dirname(fileURLToPath(import.meta.url)) } catch { return null }
}

/** Is `dir` the forge runtime tree, or inside it? Path containment, realpath'd
 *  on both sides so a symlinked checkout is not mistaken for a different tree. */
export function isForgeRuntime(dir, root = forgeRuntimeRoot()) {
  if (!dir || !root) return false
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const d = real(dir)
  const r = real(root)
  return d === r || d.startsWith(r + path.sep)
}

/**
 * Does the task text name forge as its subject?
 *
 * Deliberately narrow. "forge" appears in ordinary sentences ("forge a plan"),
 * so a bare mention is not consent to write into forge's own source. The task
 * must name forge as the THING being worked on — forge itself, this repo, the
 * agent's own code — or name one of forge's own files.
 */
export function taskTargetsForge(task = "") {
  const t = String(task ?? "")
  if (!t.trim()) return false
  return (
    /\bforge\b[^.\n]{0,24}\b(itself|repo|repository|source|codebase|runtime|cli|agent)\b/i.test(t) ||
    /\b(improve|upgrade|fix|refactor|audit|extend|debug|test)\b[^.\n]{0,24}\bforge\b/i.test(t) ||
    /\b(this|the)\s+(agent|cli|tool)'?s?\s+own\b/i.test(t) ||
    /\bforge\/[a-z0-9_-]+\.js\b/i.test(t)
  )
}

/** Stable identity for a repository: its origin URL when it has one, else its
 *  real path. Used to tell "the same project" from "a project that looks alike". */
export function repositoryIdentityOf(dir) {
  if (!dir) return null
  const remote = gitRemoteUrl(dir)
  if (remote) return String(remote).replace(/\.git$/, "")
  try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
}

/** Walk up for the enclosing git repository root; null when there is none. */
export function repositoryRootOf(dir) {
  let cur = path.resolve(dir ?? ".")
  for (let i = 0; i < 64; i++) {
    try { if (fs.existsSync(path.join(cur, ".git"))) return cur } catch { /* unreadable → keep walking */ }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

/** A coarse project type from the manifests already detected by sourceresolve. */
export function projectTypeOf(inspection) {
  const m = new Set(inspection?.manifests ?? [])
  if (m.has("package.json")) return "node"
  if (m.has("pyproject.toml") || m.has("requirements.txt") || m.has("setup.py")) return "python"
  if (m.has("Cargo.toml")) return "rust"
  if (m.has("go.mod")) return "go"
  if (m.has("pubspec.yaml")) return "dart"
  if (m.has("build.gradle") || m.has("build.gradle.kts") || m.has("pom.xml")) return "jvm"
  if (m.has("Gemfile")) return "ruby"
  if (m.has("composer.json")) return "php"
  const langs = Object.entries(inspection?.languages ?? {})
  if (langs.length) return langs.sort((a, b) => b[1] - a[1])[0][0]
  return null
}

/**
 * Resolve who the target project is.
 *
 * @param cwd        the working directory
 * @param explicit   a path the caller/user named outright (wins over everything)
 * @param task       the task text — only used to tell whether forge is the subject
 * @param taskWorkspace  the workspace an active task already fixed, if any
 * @param inspect    injectable for tests; defaults to sourceresolve.inspectProjectDir
 *
 * @returns {{
 *   forgeRoot, targetWorkspace, repositoryRoot, repositoryIdentity, projectType,
 *   workspaceConfidence, resolutionSource,
 *   runningInsideForge, targetIsForge, selfTargeted, conflict
 * }}
 */
export function resolveWorkspace({ cwd = process.cwd(), explicit = null, task = "", taskWorkspace = null, inspect = inspectProjectDir } = {}) {
  const forgeRoot = forgeRuntimeRoot()

  let targetWorkspace = null
  let resolutionSource = RESOLUTION.CWD
  if (explicit) { targetWorkspace = path.resolve(String(explicit)); resolutionSource = RESOLUTION.EXPLICIT }
  if (!targetWorkspace && taskWorkspace) { targetWorkspace = path.resolve(String(taskWorkspace)); resolutionSource = RESOLUTION.TASK_CONTEXT }
  if (!targetWorkspace) {
    // an explicit --source selection persisted earlier still outranks a bare cwd
    try {
      const rec = readSourceRecord(cwd)
      if (rec?.localPath && rec.sourceType && rec.sourceType !== "workspace" && rec.sourceType !== "git-repo") {
        targetWorkspace = path.resolve(rec.localPath)
        resolutionSource = RESOLUTION.SOURCE_RECORD
      }
    } catch { /* no record is not an error — fall through to cwd */ }
  }
  if (!targetWorkspace) { targetWorkspace = path.resolve(cwd); resolutionSource = RESOLUTION.CWD }

  const runningInsideForge = isForgeRuntime(cwd, forgeRoot)
  const targetIsForge = isForgeRuntime(targetWorkspace, forgeRoot)
  const selfTargeted = taskTargetsForge(task)

  let inspection = null
  try { inspection = inspect(targetWorkspace) } catch { inspection = null }

  // The one case worth a word: the target IS forge's own tree, the user did not
  // choose it outright, and the task never said forge. Writing here would edit
  // the agent's own source while the user was thinking about their project.
  const ambiguous = targetIsForge && !selfTargeted && resolutionSource === RESOLUTION.CWD
  const workspaceConfidence = ambiguous
    ? CONFIDENCE.AMBIGUOUS
    : (resolutionSource === RESOLUTION.CWD ? CONFIDENCE.LIKELY : CONFIDENCE.CERTAIN)

  return {
    forgeRoot,
    targetWorkspace,
    repositoryRoot: repositoryRootOf(targetWorkspace),
    repositoryIdentity: repositoryIdentityOf(targetWorkspace),
    projectType: projectTypeOf(inspection),
    workspaceConfidence,
    resolutionSource,
    runningInsideForge,
    targetIsForge,
    selfTargeted,
    conflict: ambiguous
      ? {
          kind: "target-is-forge-runtime",
          detail: `the working directory is forge's own source tree (${forgeRoot}) and the task does not name forge as its subject`,
        }
      : null,
  }
}

/**
 * The line the model is told. Empty when there is nothing worth saying — an
 * ordinary project in an ordinary directory needs no commentary.
 */
export function formatWorkspace(ws) {
  if (!ws) return ""
  if (ws.conflict) {
    return [
      `[workspace] WARNING: this working directory IS forge's own source tree (${ws.forgeRoot}).`,
      `The task does not say it is about forge, so this is probably NOT where the user's project lives.`,
      `Do not create project files here. Ask which directory the project is in, or work only where the user pointed you.`,
    ].join(" ")
  }
  if (ws.targetIsForge && ws.selfTargeted) {
    return `[workspace] working ON forge itself — ${ws.targetWorkspace} is forge's own source tree, and the task names it. Treat edits here as changes to the agent's own code.`
  }
  if (ws.resolutionSource !== RESOLUTION.CWD) {
    return `[workspace] target project: ${ws.targetWorkspace}${ws.projectType ? ` (${ws.projectType})` : ""} — selected by ${ws.resolutionSource}, not by the working directory.`
  }
  return ""
}
