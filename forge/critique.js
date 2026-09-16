/**
 * forge — pre-mutation self-critique (v94 deepwise, zero dependencies)
 *
 * A deterministic checklist run BEFORE a mutating tool call executes.
 * Not another model call (call-count tests stay stable), no network, no
 * blocking — advisory only. The checklist reads four cheap, real signals:
 *
 *   1. secret-bearing target path  (the same class of path the completion
 *      review blocks on — seen BEFORE the write, not after)
 *   2. edit-family target that does not exist on disk (the edit is going to
 *      fail — saying so saves a wasted mutation and a repair cycle)
 *   3. edit thrash — the same file already mutated N times in this run
 *      (the classic "edit → test fails → edit again" loop, caught early)
 *   4. hub file — the target has many importers in the project's knowledge
 *      graph (.ua/knowledge-graph.json, the knowwise floor graph). Deepwise
 *      reuses knowwise's output instead of rebuilding a graph: best together,
 *      nearly free. Absent/stale graph → check silently skipped (honest).
 *
 * The caller (tool-intel) turns concerns into one advisory line and one
 * event. Nothing here throws, blocks, or mutates anything.
 */
import fs from "node:fs"
import path from "node:path"

export const CRITIQUE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"])
const EDIT_FAMILY = new Set(["edit_file", "multi_edit", "apply_patch"])
const SECRET_HINT = /(?:^|[\\/])(\.env(?:\..+)?|credentials|\.pem|\.p12|id_rsa|id_ed25519|\.netrc|\.npmrc)$/i
const HUB_IMPORTERS = 5 // in-degree from the floor graph that earns the "hub" concern
const THRASH_LIMIT = 3 // same-file mutation count that earns the thrash concern
const MAX_CONCERNS = 4

export function critiqueEnabled() {
  const v = String(process.env.FORGE_CRITIQUE ?? "").toLowerCase()
  return !(v === "0" || v === "false" || v === "off")
}

/** Target paths a mutating tool call would touch (best-effort, never throws). */
export function targetFilesOf(tool, args = {}) {
  const out = []
  try {
    if (tool === "edit_file") { if (args?.path) out.push(String(args.path)) }
    else if (tool === "write_file") { if (args?.path) out.push(String(args.path)) }
    else if (tool === "multi_edit") {
      const p = String(args?.path ?? "")
      const edits = Array.isArray(args?.edits) ? args.edits : []
      for (const e of edits) { const f = String(e?.file ?? e?.path ?? ""); if (f) out.push(f) }
      if (!edits.length && p) out.push(p)
    } else if (tool === "apply_patch") {
      // patches name targets inside the patch text — pull path-ish tokens
      const txt = String(args?.patch ?? args?.diff ?? "")
      const re = /^\s*(?:\*\*\*|---|\+\+\+)?\s*(?:Update|Add|Delete) File:\s*(.+)$/gm
      let m
      while ((m = re.exec(txt))) { const f = m[1].trim(); if (f) out.push(f) }
      if (!out.length) {
        const lines = txt.split("\n").map((l) => l.trim()).filter((l) => /^(?:\*\*\* )?(?:Update|Add|Delete) File:/.test(l))
        for (const l of lines) out.push(l.replace(/^\*\*\*\s*/, "").split(":").slice(1).join(":").trim())
      }
    }
  } catch { /* targets are best-effort */ }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].slice(0, 8)
}

/** In-degree lookup over the .ua floor graph (knowwise output). Cached per file identity. */
const kgCache = new Map() // key -> { importersOf(rel), at }  (bounded below)
let kgCacheSeq = 0
function kgImporters(cwd) {
  const file = path.join(cwd, ".ua", "knowledge-graph.json")
  let key = ""
  try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}` } catch { key = "absent" }
  const hit = kgCache.get(cwd)
  if (hit && hit.key === key) return hit.importersOf
  let importersOf = () => 0
  if (key !== "absent") {
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"))
      const deg = new Map()
      for (const e of (Array.isArray(doc?.edges) ? doc.edges : [])) {
        if (e?.type !== "imports" || typeof e.target !== "string") continue
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
      }
      importersOf = (rel) => deg.get(`file:${rel}`) ?? 0
    } catch { importersOf = () => 0 } // unreadable graph → check skipped, never fake
  }
  if (kgCacheSeq > 64) { kgCache.clear(); kgCacheSeq = 0 }
  kgCache.set(cwd, { key, importersOf }); kgCacheSeq++
  return importersOf
}

/**
 * The checklist. Pure input → concerns output. `mutationCounts` is an
 * optional Map<relPath, count> of mutations already performed in this run
 * (the caller owns the counting; this module stays stateless).
 */
export function preMutationCritique({ tool, args, cwd, mutationCounts = null } = {}) {
  const concerns = []
  try {
    const targets = targetFilesOf(tool, args)
    for (const t of targets) {
      const base = path.posix.basename(t.replace(/\\/g, "/"))
      if (SECRET_HINT.test(t) || SECRET_HINT.test(base)) {
        concerns.push(`${t} is a secret-bearing path — confirm this write is intended`)
        break
      }
    }
    if (EDIT_FAMILY.has(tool)) {
      for (const t of targets) {
        try { if (!fs.existsSync(path.resolve(cwd, t))) { concerns.push(`${t} does not exist — this edit will fail (create it first or use write_file)`); break } } catch { }
      }
    }
    if (mutationCounts) {
      for (const t of targets) {
        const rel = (() => { try { return path.relative(cwd, path.resolve(cwd, t)) } catch { return t } })()
        const n = Number(mutationCounts.get(rel) ?? mutationCounts.get(t) ?? 0)
        if (n >= THRASH_LIMIT) { concerns.push(`${t} was already mutated ${n} times in this run — review the approach before editing again`); break }
      }
    }
    const importersOf = kgImporters(cwd)
    for (const t of targets) {
      const rel = (() => { try { return path.relative(cwd, path.resolve(cwd, t)).split(path.sep).join("/") } catch { return t } })()
      const deg = importersOf(rel)
      if (deg >= HUB_IMPORTERS) { concerns.push(`${t} is a hub file (${deg} importers in the project graph) — check the blast radius after this edit`); break }
    }
  } catch { /* critique never breaks a mutation */ }
  const line = concerns.length ? `[forge] critique: ${concerns.slice(0, MAX_CONCERNS).join("; ").slice(0, 480)}` : ""
  return { concerns: concerns.slice(0, MAX_CONCERNS), line }
}

/**
 * v112: the checklist is no longer advisory-only on the default path.
 * MICRO stays one-shot (advisory). Named/explicit writes still execute if
 * the caller passes `force: true` (not used by the default loop).
 *
 * v122 "yolowise" — `enforce: false` (what YOLO resolves to) keeps the
 * checklist and drops the veto. The three enforced findings were the last
 * refusals left in the default path after v88: a write to a path that merely
 * LOOKS secret-ish paused the whole run for a human (WAITING_FOR_USER), a
 * third edit to one file returned REPLAN instead of the edit, and a missing
 * target blocked an edit the model could have fixed by creating the file.
 * Each of those is worth SAYING, and none of them is worth stopping an
 * autonomous run the owner told not to stop. The note rides on regardless.
 */
export function critiqueVerdict(critique = {}, { klass = "SMALL", enforce = true } = {}) {
  const concerns = Array.isArray(critique.concerns) ? critique.concerns : []
  const why = concerns.join("; ").slice(0, 400)
  if (!concerns.length) return { ok: true, action: "allow", why: "" }
  const k = String(klass || "SMALL")
  if (enforce === false) {
    return { ok: true, action: "advisory", why: why || "critique is advisory (enforce off)", advisory: true }
  }
  if (k === "MICRO" || k === "trivial") {
    return { ok: true, action: "advisory", why: why || "MICRO does not enforce critique" }
  }
  const text = why
  if (/secret-bearing/.test(text)) return { ok: false, action: "ASK", block: true, ask: true, why: text }
  if (/already mutated/.test(text)) return { ok: false, action: "REPLAN", block: true, replan: true, why: text }
  if (/does not exist/.test(text)) return { ok: false, action: "BLOCK", block: true, why: text }
  if (/hub file/.test(text)) return { ok: true, action: "VERIFY", verify: true, why: text }
  return { ok: true, action: "advisory", why: text }
}
