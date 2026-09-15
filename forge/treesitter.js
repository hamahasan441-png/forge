/**
 * forge — tree-sitter consumption (v101 P1, zero dependencies)
 *
 * Layer 2 of the parsing ladder has always been a PROBE and nothing else:
 * langadapter reported "tree-sitter binary found" and then never used it, so a
 * file with no language server fell straight from layer 3 to the lexical regex
 * fallback at layer 8. The binary was detected, advertised, and ignored.
 *
 * This module actually consumes it. `tree-sitter parse <file>` emits an
 * S-expression with byte-free row/column ranges:
 *
 *   (program [0, 0] - [4, 0]
 *     (function_declaration [0, 0] - [2, 1]
 *       name: (identifier [0, 9] - [0, 12])
 *       body: (statement_block [0, 16] - [2, 1])))
 *
 * The tree carries NO identifier text — only positions — so a name is resolved
 * by slicing the source at the `name:` child's range. That is why extraction
 * takes the source alongside the file.
 *
 * Where this sits: tree-sitter is tried only when LSP produced nothing, BEFORE
 * the lexical fallback. It strictly ADDS structured extraction to files that
 * currently get regex-only; it never displaces a working language server, so no
 * existing behavior changes.
 *
 * Honesty: a parse that yields no declarations returns null rather than an
 * empty success, exactly as the LSP path does — the caller then falls through
 * to lexical and says so.
 */
import { execFileSync } from "node:child_process"
import fsMod from "node:fs"
import path from "node:path"

const DEFAULT_TIMEOUT_MS = 4000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_SYMBOLS = 400

/**
 * Node types that DECLARE something worth indexing, across the languages
 * tree-sitter grammars commonly name. Mapped to the same `kind` vocabulary the
 * LSP path produces, so a consumer cannot tell which layer produced a symbol
 * except by its provenance — which is the point.
 */
const DECLARATION_KINDS = new Map(Object.entries({
  function_declaration: "function",
  function_definition: "function",
  function_item: "function",           // rust
  method_definition: "method",
  method_declaration: "method",
  constructor_declaration: "constructor",
  class_declaration: "class",
  class_definition: "class",
  class_specifier: "class",            // c++
  struct_item: "struct",               // rust
  struct_specifier: "struct",          // c
  enum_item: "enum",
  enum_declaration: "enum",
  enum_specifier: "enum",
  interface_declaration: "interface",
  trait_item: "trait",                 // rust
  impl_item: "impl",                   // rust
  type_alias_declaration: "type",
  type_item: "type",
  type_definition: "type",
  module: "module",
  mod_item: "module",                  // rust
  namespace_definition: "namespace",
  package_declaration: "package",
  const_item: "constant",              // rust
}))

export function treeSitterAvailable(env = process.env) {
  const name = "tree-sitter"
  for (const dir of String(env?.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    try { if (fsMod.existsSync(path.join(dir, name))) return true } catch { /* unreadable dir */ }
  }
  return false
}

/**
 * Parse tree-sitter's S-expression into a node tree.
 * Each node: { type, field, start: [row, col], end: [row, col], children }.
 * Never throws — malformed output yields null, and the caller falls through.
 */
export function parseSExpression(text) {
  const s = String(text ?? "")
  if (!s.trim().startsWith("(")) return null
  let i = 0
  const stack = []
  let root = null
  let guard = 0
  // per-call, never module-level: a field label read for one parse must not
  // leak into the next one
  let pendingField = null
  const RANGE = /^\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*-\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/

  while (i < s.length) {
    if (++guard > 2_000_000) return null // bounded against pathological input
    const ch = s[i]
    if (ch === "(") {
      i++
      // an optional "field:" label precedes the paren in tree-sitter output,
      // so it was already consumed below; read the node type here
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
      if (!m) { i++; continue }
      const type = m[0]
      i += type.length
      const r = RANGE.exec(s.slice(i))
      let start = [0, 0], end = [0, 0]
      if (r) {
        start = [Number(r[1]), Number(r[2])]
        end = [Number(r[3]), Number(r[4])]
        i += r[0].length
      }
      const node = { type, field: pendingField, start, end, children: [] }
      pendingField = null
      if (stack.length) stack[stack.length - 1].children.push(node)
      else if (!root) root = node
      stack.push(node)
      continue
    }
    if (ch === ")") { stack.pop(); i++; continue }
    // a field label: `name:` just before the next "("
    const f = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(s.slice(i))
    if (f) { pendingField = f[1]; i += f[0].length; continue }
    i++
  }
  return root
}

/** Text at a [row, col] - [row, col] range, from the source lines. */
export function sliceRange(lines, start, end) {
  if (!Array.isArray(lines) || !start || !end) return ""
  const [r0, c0] = start, [r1, c1] = end
  if (r0 === r1) return String(lines[r0] ?? "").slice(c0, c1)
  const out = [String(lines[r0] ?? "").slice(c0)]
  for (let r = r0 + 1; r < r1; r++) out.push(String(lines[r] ?? ""))
  out.push(String(lines[r1] ?? "").slice(0, c1))
  return out.join("\n")
}

/** Walk the tree collecting declarations with their resolved names. */
export function symbolsFromTree(root, src) {
  if (!root) return []
  const lines = String(src ?? "").split("\n")
  const out = []
  const visit = (node) => {
    if (!node || out.length >= MAX_SYMBOLS) return
    const kind = DECLARATION_KINDS.get(node.type)
    if (kind) {
      // the identifier lives in the child labeled `name:`; without it the
      // declaration is anonymous (a default export, a closure) and is skipped
      // rather than given a made-up name
      const nameNode = node.children.find((c) => c.field === "name")
      const name = nameNode ? sliceRange(lines, nameNode.start, nameNode.end).trim() : ""
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        out.push({ name, kind, line: node.start[0] + 1, column: node.start[1] + 1 })
      }
    }
    for (const c of node.children) visit(c)
  }
  visit(root)
  return out
}

/** Run the binary. Returns its stdout, or null on any failure. */
export function runTreeSitter(absFile, { timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFileSync } = {}) {
  try {
    return String(exec("tree-sitter", ["parse", absFile], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }))
  } catch { return null } // no grammar, bad file, timeout — all mean "not available here"
}

/**
 * Structured extraction via tree-sitter, in the SAME shape the LSP path
 * returns. null when tree-sitter is unavailable, fails, or finds no
 * declarations — an empty success would be a fabricated one.
 */
export function extractViaTreeSitter(file, src = "", { cwd = process.cwd(), exec, timeoutMs } = {}) {
  const rel = String(file ?? "")
  const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
  const raw = runTreeSitter(abs, { exec, timeoutMs })
  if (!raw) return null
  const tree = parseSExpression(raw)
  if (!tree) return null
  const symbols = symbolsFromTree(tree, src)
  if (!symbols.length) return null
  return {
    symbols: symbols.map((s) => s.name),
    structured: symbols,
    provenance: { layer: 2, source: "tree-sitter" },
    fallback: null,
  }
}
