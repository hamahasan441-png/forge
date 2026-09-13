import path from "node:path"
/**
 * forge — gated auto-promote (v84, zero dependencies)
 *
 * VERIFIED + authored behavioral evidence + fresh fingerprint → ACTIVE.
 * DOWNLOAD, structural-only, generated-only, CANDIDATE stay put.
 * Explicit `forge skill promote` is unchanged (human override).
 * Never auto-ACTIVE because a download succeeded. Kernel frozen.
 */
import fs from "node:fs"
import { SKILL_LIFE, promoteSkill, loadSkillLife, readLearnedSkill } from "./evolve.js"
import {
  loadDownloadManifest, readSkillEvidence, evidenceIsFresh, skillMdPath,
  activateVerifiedDownload,
} from "./skilldl.js"
import { extractCapabilities } from "./caps.js"
import { recordKnowledge, KTYPE } from "./knowtype.js"
import { EXEC_STATUS } from "./execresult.js"

function testsAllPass(results = []) {
  if (!results.length) return false
  return results.every((r) => r.ok === true || r.status === EXEC_STATUS.PASS)
}

export function evaluatePromoteGates(name, { cwd = process.cwd(), env = process.env } = {}) {
  const id = String(name || "").trim()
  const blocked = []
  if (!id) return { ok: false, name: id, blocked: ["invalid name"] }
  const learned = loadSkillLife(cwd).skills?.[id] || null
  const dl = loadDownloadManifest(env, "skill").items?.[id] || null
  if (!learned && !dl) return { ok: false, name: id, blocked: ["not found"] }

  const life = dl?.lifecycle || learned?.lifecycle || null
  if (life === SKILL_LIFE.ACTIVE) {
    return { ok: true, already: true, name: id, lifecycle: SKILL_LIFE.ACTIVE, blocked: [], track: dl ? "download" : "learned" }
  }
  if (life !== SKILL_LIFE.VERIFIED) {
    blocked.push(`lifecycle ${life || "none"} (need VERIFIED; never CANDIDATE)`)
  }

  const track = dl ? "download" : "learned"
  let caps = null
  if (dl) {
    const ev = readSkillEvidence(id, env)
    if (!ev) blocked.push("no evidence")
    else {
      if (ev.kind === "structural") blocked.push("structural-only is not auto-ACTIVE")
      else if (ev.kind === "generated") blocked.push("generated-only is not auto-ACTIVE")
      else if (ev.kind !== "behavioral") blocked.push(`evidence kind ${ev.kind}`)
      if (ev.ok !== true) blocked.push("evidence not ok")
      if (!testsAllPass(ev.results || [])) blocked.push("declared tests did not all PASS")
      if (!evidenceIsFresh(id, env)) blocked.push("stale fingerprint")
    }
    try {
      const md = fs.readFileSync(skillMdPath(id, env), "utf8")
      caps = extractCapabilities(md, { name: id })
      if (!caps.ok) blocked.push(caps.error || "no reusable capability")
    } catch {
      blocked.push("SKILL.md unreadable")
    }
  } else {
    // v93 gap fix §21: the LEARNED track gets gates equivalent to the
    // download track. Before this, a learned skill only needed
    // lifecycle VERIFIED + a parseable SKILL.md — no behavioral evidence,
    // no freshness — weaker than downloads by construction.
    const md = readLearnedSkill(cwd, id)
    caps = extractCapabilities(md || "", { name: id })
    if (!caps.ok) blocked.push(caps.error || "no reusable capability")
    const rec = learned
    if (!rec.verification || rec.verification.passed !== true) {
      blocked.push("no recorded behavioral verification (a fully-passed representative re-run is required before auto-ACTIVE)")
    } else {
      // §22 freshness: the fingerprint of the related files at verification
      // time must still match — changed files mean stale knowledge
      const fp = rec.verification.fingerprint
      if (rec.stale) blocked.push(`stale: ${rec.staleReason || "related files changed after verification"} (re-verify before promoting)`)
      if (Array.isArray(fp) && fp.length) {
        const fsMod = fs
        const pathMod = path
        for (const e of fp.slice(0, 12)) {
          try {
            const st = fsMod.statSync(pathMod.isAbsolute(e.file) ? e.file : pathMod.join(cwd, e.file))
            if (e.mtime != null && Math.round(st.mtimeMs || 0) !== e.mtime) { blocked.push(`stale fingerprint: ${e.file} changed since verification`); break }
          } catch { blocked.push(`stale fingerprint: ${e.file} no longer exists`); break }
        }
      }
      const bm = rec.verification.benchmark
      if (bm && bm.total && bm.passed !== bm.total) blocked.push(`behavioral benchmark incomplete (${bm.passed}/${bm.total} checks passed)`)
    }
  }

  if (String(dl?.lifecycle || "") === "CONTRADICTED" || learned?.lifecycle === SKILL_LIFE.SUPERSEDED) {
    blocked.push("contradicted/superseded")
  }

  return {
    ok: blocked.length === 0,
    already: false,
    name: id,
    lifecycle: life,
    track,
    blocked,
    caps: caps?.ok ? caps : null,
  }
}

export function autoPromote(name, { cwd = process.cwd(), env = process.env } = {}) {
  const g = evaluatePromoteGates(name, { cwd, env })
  if (g.already) return { ok: true, already: true, name: g.name, lifecycle: SKILL_LIFE.ACTIVE, gated: true }
  if (!g.ok) {
    return {
      ok: false, name: g.name, lifecycle: g.lifecycle,
      blocked: g.blocked, error: (g.blocked || []).join("; ") || "gates failed",
      gated: true,
    }
  }
  const result = g.track === "learned"
    ? promoteSkill(cwd, g.name)
    : activateVerifiedDownload(g.name, { env })
  if (!result?.ok) return { ...result, gated: true, blocked: g.blocked }
  try {
    recordKnowledge({
      cwd,
      type: KTYPE.FACT,
      text: `skill ${g.name} auto-promoted to ACTIVE`,
      evidence: `gates:${String(g.caps?.fingerprint || "behavioral").slice(0, 16)}`,
      source: "autopromote",
    })
  } catch { /* knowtype is best-effort */ }
  return {
    ok: true, already: false, name: g.name, lifecycle: SKILL_LIFE.ACTIVE,
    gated: true, track: g.track, predecessor: result.predecessor || null,
    caps: g.caps,
  }
}
