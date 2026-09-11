/**
 * forge — line diff (Myers O(ND)) + unified-diff output. Zero dependencies.
 *
 * Powers `/diff` and the `+42 -17` counters in the CHANGES panel. The output is
 * a real unified diff: `applyUnifiedDiff()` from diffpatch.js applies it back
 * (the test suite proves the round trip), so what the UI shows is what git
 * would show.
 *
 * Bounded: inputs above MAX_LINES fall back to a multiset count (still exact
 * for +/- totals in the common case, never O(N·D) on a 100k-line file).
 */

export const MAX_LINES = 20000

function splitLines(s) {
  const str = String(s ?? "")
  if (!str) return []
  const lines = str.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Myers shortest-edit-script. Returns ops: [{ t: "=", a, b } | { t: "-", a } | { t: "+", b }]
 * where a/b are line indexes into the old/new arrays.
 */
export function diffLines(oldLines, newLines) {
  const N = oldLines.length, M = newLines.length
  // trim common prefix/suffix — the usual case for a surgical edit
  let start = 0
  while (start < N && start < M && oldLines[start] === newLines[start]) start++
  let endA = N, endB = M
  while (endA > start && endB > start && oldLines[endA - 1] === newLines[endB - 1]) { endA--; endB-- }
  const a = oldLines.slice(start, endA), b = newLines.slice(start, endB)
  const ops = []
  for (let i = 0; i < start; i++) ops.push({ t: "=", a: i, b: i })
  const mid = myers(a, b)
  for (const op of mid) {
    if (op.t === "=") ops.push({ t: "=", a: op.a + start, b: op.b + start })
    else if (op.t === "-") ops.push({ t: "-", a: op.a + start })
    else ops.push({ t: "+", b: op.b + start })
  }
  for (let i = 0; i < N - endA; i++) ops.push({ t: "=", a: endA + i, b: endB + i })
  return ops
}

function myers(a, b) {
  const N = a.length, M = b.length
  if (!N && !M) return []
  if (!N) return b.map((_, j) => ({ t: "+", b: j }))
  if (!M) return a.map((_, i) => ({ t: "-", a: i }))
  const max = N + M
  const size = 2 * max + 1
  const v = new Int32Array(size)
  const off = max
  const trace = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]
      else x = v[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= N && y >= M) { found = true; break }
    }
  }
  // backtrack
  const ops = []
  let x = N, y = M
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]
    const k = x - y
    let prevK
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = vv[off + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y--; ops.push({ t: "=", a: x, b: y }) }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ t: "+", b: y }) }
      else { x--; ops.push({ t: "-", a: x }) }
    }
  }
  ops.reverse()
  return ops
}

/** Cheap +/- totals for huge inputs (multiset difference; exact when lines are not reordered). */
function countMultiset(oldLines, newLines) {
  const m = new Map()
  for (const l of oldLines) m.set(l, (m.get(l) || 0) + 1)
  let added = 0
  for (const l of newLines) {
    const c = m.get(l) || 0
    if (c > 0) m.set(l, c - 1)
    else added++
  }
  let removed = 0
  for (const c of m.values()) removed += c
  return { added, removed }
}

/** { added, removed } line counts between two texts. */
export function diffStats(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText)
  if (a.length > MAX_LINES || b.length > MAX_LINES) return countMultiset(a, b)
  let added = 0, removed = 0
  for (const op of diffLines(a, b)) {
    if (op.t === "+") added++
    else if (op.t === "-") removed++
  }
  return { added, removed }
}

/**
 * Unified diff text with `context` lines of context per hunk. Returns "" when
 * the texts are identical.
 */
export function unifiedDiff(oldText, newText, { path = "file", context = 3, oldLabel, newLabel } = {}) {
  const a = splitLines(oldText), b = splitLines(newText)
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const st = countMultiset(a, b)
    return `--- a/${path}\n+++ b/${path}\n(diff too large to render: +${st.added} -${st.removed} lines)\n`
  }
  const ops = diffLines(a, b)
  if (!ops.some((o) => o.t !== "=")) return ""
  const out = [`--- ${oldLabel ?? "a/" + path}`, `+++ ${newLabel ?? "b/" + path}`]
  // group ops into hunks
  let i = 0
  while (i < ops.length) {
    // find next change
    while (i < ops.length && ops[i].t === "=") i++
    if (i >= ops.length) break
    let hs = Math.max(0, i - context)
    let he = i
    // extend hunk end while changes are within 2*context of each other
    let j = i
    while (j < ops.length) {
      if (ops[j].t !== "=") { he = j + 1; j++; continue }
      // run of equals
      let k = j
      while (k < ops.length && ops[k].t === "=") k++
      if (k >= ops.length || k - j > 2 * context) { he = Math.min(ops.length, he + Math.min(context, k - j)); break }
      j = k
    }
    const hunk = ops.slice(hs, he)
    const aStart = (hunk.find((o) => o.a !== undefined)?.a ?? (hunk[0].b ?? 0)) + 1
    const bStart = (hunk.find((o) => o.b !== undefined)?.b ?? (hunk[0].a ?? 0)) + 1
    const aLen = hunk.filter((o) => o.t !== "+").length
    const bLen = hunk.filter((o) => o.t !== "-").length
    out.push(`@@ -${aLen ? aStart : Math.max(0, aStart - 1)},${aLen} +${bLen ? bStart : Math.max(0, bStart - 1)},${bLen} @@`)
    for (const o of hunk) {
      if (o.t === "=") out.push(" " + a[o.a])
      else if (o.t === "-") out.push("-" + a[o.a])
      else out.push("+" + b[o.b])
    }
    i = he
  }
  return out.join("\n") + "\n"
}
