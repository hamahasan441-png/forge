/**
 * forge — unified-diff engine (v16): parse + atomically apply patches.
 *
 * Supports standard unified diffs:
 *   --- a/old.txt            (or --- /dev/null for creation)
 *   +++ b/new.txt            (or +++ /dev/null for deletion)
 *   @@ -1,3 +1,3 @@
 *    context / -removed / +added / \ No newline at end of file
 *
 * Guarantees:
 *   - validate-then-write: the WHOLE patch is applied in memory first; any hunk
 *     that does not fit aborts everything (atomic across files).
 *   - fuzzy anchoring: a hunk is placed at its declared line; if the context does
 *     not match there, nearby lines (±FUZZ) are searched for the context block.
 *   - no filesystem access here (pure string ops) → trivially testable, and the
 *     tool layer checkpoints BEFORE writing.
 */

const FUZZ = 40

/** Parse unified diff text → [{ oldPath, newPath, hunks: [{ oldStart, oldCount, newStart, newCount, lines }] }]
 *  lines: [{ t: " "|"-"|"+", s: text }]  (t=" " context, "-" old, "+" new) */
export function parsePatch(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").split("\n")
  const files = []
  let i = 0
  const isHeader = (s) => /^--- /.test(s)
  const isNew = (s) => /^\+\+\+ /.test(s)
  const cleanPath = (s) => {
    let p = s.replace(/^(---|\+\+\+)\s+/, "").replace(/\t[\s\S]*$/, "").replace(/^"|"$/g, "").trim()
    if (p === "/dev/null") return p
    p = p.replace(/^[ab]\//, "")
    if (p.startsWith("/")) p = p.slice(1)
    return p
  }
  while (i < raw.length) {
    if (!isHeader(raw[i])) { i++; continue }
    let oldPath, newPath
    oldPath = cleanPath(raw[i])
    i++
    if (i < raw.length && isNew(raw[i])) { newPath = cleanPath(raw[i]); i++ }
    else throw new Error(`patch: missing +++ line after --- ${oldPath}`)
    if (oldPath === "/dev/null" && newPath === "/dev/null") throw new Error("patch: both sides are /dev/null")
    const hunks = []
    while (i < raw.length && raw[i].startsWith("@@")) {
      const m = raw[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!m) throw new Error(`patch: malformed hunk header: ${raw[i].slice(0, 40)}`)
      const hunk = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
      }
      i++
      // consume EXACTLY the declared counts — context counts toward BOTH sides,
      // so a plain sum-based loop would over-run and swallow the next header.
      let oldGot = 0, newGot = 0
      while (i < raw.length && (oldGot < hunk.oldCount || newGot < hunk.newCount)) {
        const line = raw[i]
        if (line.startsWith("\\ No newline")) { hunk.lines.push({ t: "\\", s: "" }); i++; continue }
        if (oldGot < hunk.oldCount && newGot < hunk.newCount && (line.startsWith(" ") || line === "")) {
          hunk.lines.push({ t: " ", s: line.slice(1) }); oldGot++; newGot++; i++
        } else if (oldGot < hunk.oldCount && line.startsWith("-") && !line.startsWith("--- ")) {
          hunk.lines.push({ t: "-", s: line.slice(1) }); oldGot++; i++
        } else if (newGot < hunk.newCount && line.startsWith("+") && !line.startsWith("+++ ")) {
          hunk.lines.push({ t: "+", s: line.slice(1) }); newGot++; i++
        } else break
      }
      // the "no newline" marker trails the last hunk line — consume it here
      if (i < raw.length && raw[i].startsWith("\\ No newline")) { hunk.lines.push({ t: "\\", s: "" }); i++ }
      if (oldGot !== hunk.oldCount || newGot !== hunk.newCount) {
        throw new Error(`patch: hunk at @@ -${hunk.oldStart} +${hunk.newStart} @@ has ${oldGot}/${hunk.oldCount} old and ${newGot}/${hunk.newCount} new lines`)
      }
      hunks.push(hunk)
    }
    if (!hunks.length) throw new Error(`patch: no hunks found for ${newPath}`)
    files.push({ oldPath, newPath, hunks })
  }
  if (!files.length) throw new Error("patch: no file sections found (need --- / +++ / @@ lines)")
  return files
}

function splitKeep(content) {
  const endsNL = content === "" || content.endsWith("\n")
  const lines = content.split("\n")
  if (endsNL && lines[lines.length - 1] === "") lines.pop()
  return { lines, endsNL }
}

/**
 * Apply a parsed patch to a { path → content } map (in memory).
 * Returns { results: Map<path, content>, created: [paths], deleted: [paths] }.
 * Throws with a precise message if ANY hunk fails (nothing is written by caller).
 */
export function applyParsedPatch(filesMap, parsed) {
  const results = new Map()
  const created = []
  const deleted = []
  for (const f of parsed) {
    const isCreate = f.oldPath === "/dev/null"
    const isDelete = f.newPath === "/dev/null"
    const target = isCreate ? f.newPath : isDelete ? f.oldPath : (f.newPath || f.oldPath)
    if (!target || target === "/dev/null") throw new Error("patch: file section without a target path")
    if (created.includes(target) || deleted.includes(target) || results.has(target)) {
      throw new Error(`patch: file ${target} targeted more than once`)
    }
    if (isCreate) {
      if (filesMap.has(target)) throw new Error(`patch: cannot create ${target} — file already exists`)
      const adds = f.hunks.flatMap((h) => h.lines.filter((l) => l.t === "+").map((l) => l.s))
      const noNL = f.hunks.some((h) => h.lines.some((l) => l.t === "\\"))
      results.set(target, adds.join("\n") + (noNL ? "" : "\n"))
      created.push(target)
      continue
    }
    if (!filesMap.has(target)) throw new Error(`patch: file not found: ${target}`)
    if (isDelete) {
      // require the old content to match every hunk, then drop the file
      verifyHunks(filesMap.get(target), f.hunks, target)
      deleted.push(target)
      continue
    }
    const { lines } = splitKeep(filesMap.get(target))
    const noNL = f.hunks.some((h) => h.lines.some((l) => l.t === "\\"))
    let out = []
    let pos = 0 // index into `lines` not yet copied to out
    let drift = 0
    for (const h of f.hunks) {
      const want = h.lines.filter((l) => l.t === " " || l.t === "-").map((l) => l.s)
      let at = h.oldStart - 1 + drift
      if (!matchAt(lines, want, at)) {
        at = findAnchor(lines, want, h.oldStart - 1 + drift)
        if (at === -1) {
          throw new Error(`patch: hunk @@ -${h.oldStart} +${h.newStart} @@ does not apply to ${target} (context not found)`)
        }
      }
      // copy unchanged prefix
      while (pos < at) out.push(lines[pos++])
      // skip removed lines, emit context+added
      for (const l of h.lines) {
        if (l.t === " ") { out.push(lines[pos] ?? l.s); pos++ }
        else if (l.t === "-") pos++
        else if (l.t === "+") out.push(l.s)
      }
      // drift = how far `pos` moved past the DECLARED next hunk start
      drift = pos - (h.oldStart - 1 + want.length)
    }
    while (pos < lines.length) out.push(lines[pos++])
    results.set(target, out.join("\n") + (noNL ? "" : "\n"))
  }
  return { results, created, deleted }
}

function matchAt(lines, want, at) {
  if (at < 0 || at + want.length > lines.length) return false
  for (let i = 0; i < want.length; i++) if (lines[at + i] !== want[i]) return false
  return true
}

function findAnchor(lines, want, preferred) {
  if (!want.length) return Math.min(Math.max(preferred, 0), lines.length)
  // fast path: near the declared position
  for (let d = 0; d <= FUZZ; d++) {
    for (const at of [preferred + d, preferred - d]) {
      if (matchAt(lines, want, at)) return at
    }
  }
  // GNU-patch behavior: drift can be arbitrarily large — scan the whole file,
  // nearest match to the declared position wins.
  let best = -1
  let bestDist = Infinity
  for (let at = 0; at + want.length <= lines.length; at++) {
    if (!matchAt(lines, want, at)) continue
    const dist = Math.abs(at - preferred)
    if (dist < bestDist) { best = at; bestDist = dist }
  }
  return best
}

function verifyHunks(content, hunks, target) {
  const { lines } = splitKeep(content)
  for (const h of hunks) {
    const want = h.lines.filter((l) => l.t === " " || l.t === "-").map((l) => l.s)
    if (findAnchor(lines, want, h.oldStart - 1) === -1) {
      throw new Error(`patch: delete verification failed for ${target} (content changed?)`)
    }
  }
}

/** Convenience: parse + apply against a readFileSync-style loader map. */
export function applyUnifiedDiff(filesMap, patchText) {
  return applyParsedPatch(filesMap, parsePatch(patchText))
}
