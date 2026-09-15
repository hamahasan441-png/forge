/**
 * forge — one stable project identity (v108 "rootwise", zero dependencies)
 *
 * THE BUG THIS MODULE EXISTS FOR, reproduced before it was written:
 *
 *   projectHash(/repo)      = 9712944af584
 *   projectHash(/repo/src)  = 56c435bb3b12
 *
 *   recall FROM /repo      : "PROJECT MEMORY: the parser must stream…"
 *   recall FROM /repo/src  : ""
 *   latestSessionForCwd(/repo/src) : null
 *   listTasks({cwd:/repo/src})     : []
 *
 * `memory.js:44` keyed every per-project store on sha1 of the ABSOLUTE cwd, and
 * `sessions.js`, `taskstate.js` and `runlog.js` each compared absolute paths for
 * equality. So `cd src` made forge a stranger in its own repository: a new,
 * empty project with no memory, no sessions, no open tasks. Move or rename the
 * directory and the entire history is orphaned — 34 production call sites go
 * through `projectDir(cwd)`, so that one key addresses nearly every store forge
 * owns.
 *
 * The fix is to ask a different question. Not "what is the working directory"
 * but "which project is the working directory IN".
 *
 * WHY THIS IS A LEAF MODULE. `workspace.js` already owns `repositoryRootOf`,
 * and reusing it would be the obvious move — but `memory.js` cannot import it:
 * `workspace.js → sourceresolve.js:41 → memory.js` is a cycle. So the walk
 * lives here, with nothing but `node:` imports, and `workspace.js` takes its
 * root from here too. One walk in the repository, not two.
 *
 * MIGRATION IS A NON-EVENT for the common case: someone who always launched
 * from the repository root gets a byte-identical key, because the root of a
 * root IS the root. Only a subdirectory launch moves — and that store was the
 * bug.
 */
import fs from "node:fs"
import path from "node:path"

/** How far up to walk. Same bound as workspace.js — a path deeper than this is
 *  pathological, and an unbounded loop on a broken filesystem is worse. */
const MAX_DEPTH = 64

/**
 * Files that mark the top of a project. `.git` first and alone in its tier: it
 * is the strongest statement anyone makes about where a project begins, and in
 * a monorepo it is what keeps one repository from fragmenting into one store
 * per package.
 *
 * `.git` is tested with existsSync rather than isDirectory because a git
 * worktree and a submodule both make it a FILE.
 */
const VCS_MARKERS = [".git", ".hg", ".svn"]

/** Manifests, used only when there is no VCS marker anywhere above. */
const MANIFESTS = [
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "Cargo.toml",
  "go.mod", "pubspec.yaml", "build.gradle", "build.gradle.kts", "pom.xml",
  "Gemfile", "composer.json", "mix.exs", "deno.json", "CMakeLists.txt",
]

const has = (dir, name) => { try { return fs.existsSync(path.join(dir, name)) } catch { return false } }

/**
 * The root of the project `cwd` belongs to.
 *
 * VCS marker wins; otherwise the HIGHEST enclosing manifest (so `repo/src` and
 * `repo` agree even in a plain, un-versioned source tree); otherwise the
 * resolved directory itself, which is exactly the old behaviour — a directory
 * that is part of no project is its own project, as before.
 *
 * Symlinks are deliberately NOT resolved. `fs.realpathSync` here would move the
 * key for every symlinked checkout that exists today, silently orphaning real
 * users' history to fix a rarer problem than the one this module is for.
 */
export function projectRoot(cwd = process.cwd()) {
  let cur
  try { cur = path.resolve(cwd ?? ".") } catch { return String(cwd ?? "") }
  let highestManifest = null
  let dir = cur
  for (let i = 0; i < MAX_DEPTH; i++) {
    for (const m of VCS_MARKERS) if (has(dir, m)) return dir
    for (const m of MANIFESTS) { if (has(dir, m)) { highestManifest = dir; break } }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return highestManifest ?? cur
}

/**
 * Do two directories belong to the same project? The replacement for the four
 * separate `path.resolve(a) === path.resolve(b)` comparisons that each made
 * `cd` erase a different store.
 */
export function sameProject(a, b) {
  if (!a || !b) return false
  try { return projectRoot(a) === projectRoot(b) } catch { return false }
}

/** The old key's input, kept so a caller can find a store written before this
 *  module existed. Never used to WRITE — only to adopt. */
export function legacyKeyInput(cwd = process.cwd()) {
  try { return path.resolve(cwd ?? ".") } catch { return String(cwd ?? "") }
}
