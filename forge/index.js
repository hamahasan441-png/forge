/**
 * forge — incremental code index (v32, zero dependencies)
 *
 * UNIFIED §23: persist file fingerprints (size + mtime) + extracted symbols
 * under ~/.forge/projects/<hash>/index.json. Unchanged files are not re-read.
 * Missing/corrupt cache → full parse, never a throw. FORGE_INDEX=0 disables
 * persist+reuse (always parse), the sandbox.js lesson: never fake a hit.
 *
 * The walk and skip-dirs stay in repomap.js. This module is load/save/hit.
 *
 * v98 shipwise — the extraction PROVENANCE tier: every record now carries
 * `extraction: { layer, source }` so no consumer can mistake regex output
 * for parser output. JSON files get a genuine LAYER-1 native parse
 * (JSON.parse, top-level keys as symbols — a real parser, not a pattern);
 * everything else starts at the honest lexical layer 8 and is upgraded to
 * layer 3 (LSP documentSymbol) by langstruct.js enrichment. INDEX_VERSION
 * bumps 1 → 2 ONCE so every project re-extracts one time and cached
 * lexical-era records never masquerade as structured ones.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { extractRecord } from "./lang.js"
import { extractContracts } from "./xlang.js"

export const INDEX_VERSION = 2

export function indexEnabled() {
  const v = process.env.FORGE_INDEX
  if (v === "0" || v === "false" || v === "off") return false
  return true
}

export function indexPath(root) {
  return path.join(projectDir(root), "index.json")
}

export function emptyIndex() {
  return { version: INDEX_VERSION, files: {} }
}

export function loadIndex(root) {
  if (!indexEnabled()) return emptyIndex()
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(root), "utf8"))
    if (!j || j.version !== INDEX_VERSION || !j.files || typeof j.files !== "object" || Array.isArray(j.files)) {
      return emptyIndex()
    }
    return j
  } catch {
    return emptyIndex()
  }
}

export function saveIndex(root, idx) {
  if (!indexEnabled()) return false
  try {
    const payload = {
      version: INDEX_VERSION,
      root: path.resolve(root || process.cwd()),
      updatedAt: Date.now(),
      files: idx?.files && typeof idx.files === "object" ? idx.files : {},
    }
    writeStateFile(indexPath(root), JSON.stringify(payload) + "\n")
    return true
  } catch {
    return false
  }
}

export function fingerprint(st) {
  return { size: Number(st.size) || 0, mtime: Math.round(Number(st.mtimeMs) || 0) }
}

export function cacheHit(cached, st) {
  if (!cached || !st) return false
  const fp = fingerprint(st)
  return cached.size === fp.size && cached.mtime === fp.mtime && Array.isArray(cached.symbols)
}

/** v98 layer-1 native JSON parse: top-level keys as symbols. A real parser
 *  (JSON.parse) — on failure the record is honestly empty with the failure
 *  recorded, never a faked partial extraction. `.jsonc` comments are NOT
 *  stripped — a parse failure is reported as what it is. */
function jsonNativeRecord(file, src) {
  try {
    const j = JSON.parse(String(src ?? ""))
    const keys = (j && typeof j === "object" && !Array.isArray(j)) ? Object.keys(j) : (Array.isArray(j) ? [] : [])
    return {
      ok: true,
      rec: { lang: "json", symbols: keys.slice(0, 200), imports: [], exports: keys.slice(0, 40), calls: [], types: [] },
      extraction: { layer: 1, source: "native JSON.parse (top-level keys)" },
    }
  } catch (e) {
    return {
      ok: false,
      rec: { lang: "json", symbols: [], imports: [], exports: [], calls: [], types: [] },
      extraction: { layer: 1, source: "native JSON.parse", failed: true, error: String(e?.message ?? e).slice(0, 120) },
    }
  }
}

export function recordFromSource(file, src, fullPath, st) {
  const fp = fingerprint(st)
  const name = String(file ?? "")
  if (/\.jsonc?$/i.test(name)) {
    // layer 1 — native parse owns JSON; contracts still come from the shared
    // extractor so cross-language edges stay one implementation
    const nat = jsonNativeRecord(name, src)
    return { ...fp, ...nat.rec, test: false, config: true, contracts: extractContracts(name, src), extraction: nat.extraction }
  }
  const rec = extractRecord(file, src, fullPath)
  return { ...fp, ...rec, contracts: extractContracts(file, src), extraction: { layer: 8, source: "lexical (lang.js)" } }
}

export function invalidate(root, rels = []) {
  const idx = loadIndex(root)
  let n = 0
  for (const rel of rels) {
    const k = String(rel || "").replace(/\\/g, "/")
    if (k && idx.files[k]) { delete idx.files[k]; n++ }
  }
  if (n) saveIndex(root, idx)
  return n
}
