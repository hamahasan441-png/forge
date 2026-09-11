/**
 * forge — capability extract (v84, zero dependencies)
 *
 * Verified SKILL.md → reusable caps. Not a second skill store.
 * Indexing a name is not a capability. Kernel frozen.
 */
import crypto from "node:crypto"
import { extractKnowledge } from "./skilldl.js"
import { skillDescription, validSkillName } from "./skills.js"

export function extractCapabilities(md, { name = "" } = {}) {
  const src = String(md || "")
  if (!src.trim()) return { ok: false, error: "empty" }
  const know = extractKnowledge(src)
  const capabilities = (know.procedures || []).map((p) => p.title).filter(Boolean)
  const limitations = []
  for (const p of know.procedures || []) {
    if (/limit|never|do not|don't|danger/i.test(p.title) || /limit|never|do not/i.test(p.body || "")) {
      limitations.push((p.body || p.title).slice(0, 160))
    }
  }
  const substance = capabilities.length + (know.repair ? 1 : 0) + (know.patterns || []).length
  if (substance < 1) return { ok: false, error: "nothing to extract (indexing is not a capability)" }
  const id = validSkillName(name) || (src.match(/^name:\s*([A-Za-z0-9._-]+)/m) || [])[1] || ""
  return {
    ok: true,
    identity: id || null,
    description: skillDescription(src) || "",
    capabilities: capabilities.slice(0, 8),
    workflow: know.repair || (know.procedures[0]?.body || ""),
    examples: (know.patterns || []).slice(0, 6),
    files: know.files || [],
    verification: know.command || "",
    limitations: limitations.slice(0, 4),
    fingerprint: crypto.createHash("sha256").update(src).digest("hex"),
    repair: know.repair || "",
  }
}
