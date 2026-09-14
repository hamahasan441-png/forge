#!/usr/bin/env node
/**
 * forge — worknode.mjs (v95 "worktreewise")
 *
 * The child-process worker entry for an ISOLATED DAG node. Its process.cwd()
 * IS the node's git worktree, so everything agent.js binds to process.cwd()
 * (the tool session root, path safety, repo map, memory scope) is correctly
 * the worktree — the writes can only land there.
 *
 * Protocol (deliberately boring and crash-honest):
 *   argv[2]  path to the spec JSON (mode 600, written OUTSIDE the worktree)
 *   spec     { dir, resultPath, config, provider, task, context, role,
 *              maxSteps, taskId, runId, segmentId, nodeId }
 *   stdout   nothing is parsed from it (logs only)
 *   on exit  the runAgent result is written to spec.resultPath as JSON, then
 *            exit 0. ANY other exit code means no result — the parent maps
 *            that to an honest worker failure, never a fabricated completion.
 *
 * The spec file and the result file live in .forge/worktrees/ NEXT to the
 * worktree directory — never inside it — so captureChanges() can never see
 * them and merge them into a patch.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const FORGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const specPath = process.argv[2]

function die(msg) {
  process.stderr.write(`worknode: ${msg}\n`)
  process.exit(3)
}

if (!specPath) die("no spec path given")
let spec
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"))
} catch (e) {
  die("spec unreadable: " + String(e?.message ?? e))
}
if (!spec?.dir || !spec?.resultPath) die("spec missing dir/resultPath")

// be explicit: the process MUST be running inside the worktree
try {
  if (path.resolve(process.cwd()) !== path.resolve(spec.dir)) process.chdir(spec.dir)
} catch (e) {
  die("cannot chdir into worktree: " + String(e?.message ?? e))
}

// crash guard: an unhandled rejection must still write an honest failure
// result instead of vanishing with only a stack trace.
const writeResult = (res) => {
  try {
    fs.mkdirSync(path.dirname(spec.resultPath), { recursive: true })
    fs.writeFileSync(spec.resultPath, JSON.stringify(res ?? { status: "failed", text: "", steps: 0 }), { mode: 0o600 })
  } catch { /* the parent maps a missing result to an honest failure */ }
}

try {
  const { runAgent } = await import(pathToFileURL(path.join(FORGE_DIR, "agent.js")).href)
  const res = await runAgent({
    config: spec.config ?? {},
    provider: spec.provider ?? null,
    task: String(spec.task ?? ""),
    extraContext: spec.context ? String(spec.context) : "",
    readOnly: false,
    maxStepsOverride: spec.maxSteps ?? 12,
    role: spec.role ?? "coder",
    sub: `worktree:${spec.nodeId ?? "node"}`,
    taskId: spec.taskId ?? null,
    runId: null, // journaling off — the parent owns the task's run record
    segmentId: spec.segmentId ?? null,
    nodeId: spec.nodeId ?? null,
    journal: false,
    suppressRunEvents: true,
  })
  writeResult(res)
  process.exit(0)
} catch (e) {
  writeResult({
    status: "failed",
    error: "worknode agent failed: " + String(e?.message ?? e),
    text: "", steps: 0, toolLog: [], toolRecords: [], toolStats: {},
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, toolCalls: 0 },
    budgetHit: false, wrote: false, aborted: false,
  })
  process.exit(4)
}
