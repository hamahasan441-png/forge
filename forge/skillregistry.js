/**
 * skillregistry.js — v99 "loopwise" skill discovery + curated GitHub repos.
 *
 * v98 had 103 bundled skills and a verify-gated HTTPS downloader
 * (skilldl.js) — but discovery was prompt-name-only and the user had to
 * already KNOW the exact URL of anything else. This module adds the missing
 * surfaces, data-only and honest:
 *
 *   - searchSkills(): local index search (token scoring over names +
 *     descriptions) — `forge skill search <query>`
 *   - SKILL_REPOS: a curated list of the best-known skill repositories on
 *     GitHub, with example skills and raw SKILL.md URLs ready for
 *     `forge skill download <url>` — `forge skill recommend [query]`
 *
 * Nothing here downloads anything by itself: recommendation returns URLs;
 * downloading still goes through the ONE trusted path (skilldl.js:
 * SSRF-guarded pinned fetch, ≤8MB, verify → activate lifecycle). No
 * telemetry, no remote queries, no invented repos.
 */

/**
 * Curated skill repositories. Every entry lists example skills with a RAW
 * SKILL.md URL (raw.githubusercontent.com) that `forge skill download`
 * accepts directly. URLs are hints, not promises — a moved branch fails the
 * download honestly.
 */
export const SKILL_REPOS = Object.freeze([
  {
    repo: "obra/superpowers",
    desc: "the original process-skill pack: TDD, systematic debugging, planning, code review, git worktrees",
    license: "MIT",
    bundled: "13 of its skills ship bundled with forge already",
    examples: [
      { name: "writing-skills", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-skills/SKILL.md" },
      { name: "systematic-debugging", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md" },
      { name: "test-driven-development", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md" },
    ],
  },
  {
    repo: "anthropics/skills",
    desc: "Anthropic's official skills: document processing (docx/pdf/pptx/xlsx), brand voice, artifacts",
    license: "varies — check the repo",
    bundled: "forge bundles its own document skills; this is the upstream source",
    examples: [
      { name: "docx", url: "https://raw.githubusercontent.com/anthropics/skills/main/document-skills/docx/SKILL.md" },
      { name: "pdf", url: "https://raw.githubusercontent.com/anthropics/skills/main/document-skills/pdf/SKILL.md" },
      { name: "pptx", url: "https://raw.githubusercontent.com/anthropics/skills/main/document-skills/pptx/SKILL.md" },
    ],
  },
  {
    repo: "Egonex-AI/Understand-Anything",
    desc: "understanding agents: chat/dashboard/diff/domain/figma/knowledge analysis packs",
    license: "check the repo",
    bundled: "10 of its understand-* skills ship bundled with forge already",
    examples: [
      { name: "understand-domain", url: "https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/skills/understand-domain/SKILL.md" },
      { name: "understand-figma", url: "https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/skills/understand-figma/SKILL.md" },
    ],
  },
  {
    repo: "zai-org/GLM-Skills",
    desc: "GLM agent skills: media generation/understanding, web search/reader, full-stack dev",
    license: "check the repo",
    bundled: "the z-ai media skills bundled with forge originate here",
    examples: [
      { name: "web-search", url: "https://raw.githubusercontent.com/zai-org/GLM-Skills/main/skills/web-search/SKILL.md" },
      { name: "image-generation", url: "https://raw.githubusercontent.com/zai-org/GLM-Skills/main/skills/image-generation/SKILL.md" },
    ],
  },
])

/** GitHub repository-search URL for a topic — a hint for humans, never fetched by forge. */
export function githubSearchUrl(query) {
  const q = encodeURIComponent(`${query ?? ""} SKILL.md`.trim())
  return `https://github.com/search?q=${q}&type=repositories`
}

/**
 * Local skill search over an index ({name, desc, path} entries — the exact
 * shape skills.js indexSkills produces). Deterministic token scoring:
 * name-prefix > name-contains > description-contains > token overlap.
 */
export function searchSkills(query, index = [], { limit = 8 } = {}) {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return []
  const tokens = q.split(/\s+/).filter(Boolean)
  const scored = []
  for (const s of index || []) {
    if (!s || !s.name) continue
    const name = String(s.name).toLowerCase()
    const desc = String(s.desc ?? "").toLowerCase()
    let score = 0
    if (name === q) score += 100
    else if (name.startsWith(q)) score += 60
    else if (name.includes(q)) score += 40
    if (desc.includes(q)) score += 20
    let hits = 0
    for (const t of tokens) {
      if (name.includes(t)) hits++
      else if (desc.includes(t)) hits += 0.5
    }
    score += hits * 8
    if (score > 0) scored.push({ name: s.name, desc: s.desc ?? "", path: s.path ?? null, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

/**
 * Recommend curated repos for a query (stemmed token overlap on
 * repo/desc/examples); no query → all repos. Pure data, ranked
 * deterministically. The stemmer is deliberately crude (plural/gerund
 * endings) — it widens recall ("testing" ↔ "test-driven") without any
 * external dependency.
 */
const stem = (w) => String(w).toLowerCase().replace(/(ings?|ed|es|s)$/, "")
export function recommendRepos(query = "") {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return SKILL_REPOS.map((r) => ({ repo: r.repo, desc: r.desc, examples: r.examples.slice(0, 3), score: 0 }))
  const tokens = q.split(/\s+/).filter(Boolean).map(stem).filter((t) => t.length > 2)
  const scored = []
  for (const r of SKILL_REPOS) {
    const words = `${r.repo} ${r.desc} ${r.examples.map((e) => e.name).join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).map(stem)
    const wordSet = new Set(words)
    const score = tokens.reduce((acc, t) => acc + (wordSet.has(t) ? 1 : words.some((w) => w.startsWith(t) && t.length >= 4) ? 1 : 0), 0)
    if (score > 0) scored.push({ repo: r.repo, desc: r.desc, examples: r.examples.slice(0, 3), score })
  }
  return scored.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo))
}
