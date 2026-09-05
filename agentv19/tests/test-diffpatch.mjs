/** Smoke tests for diffpatch.js — run: node tests/test-diffpatch.mjs */
import { parsePatch, applyUnifiedDiff } from "../forge/diffpatch.js"

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log("  ok ", name) } else { fail++; console.log("  FAIL", name) } }

// 1. create + modify (multi-file, a/ b/ prefixes)
const p1 = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two
--- a/base.txt
+++ b/base.txt
@@ -1,3 +1,3 @@
 first
-old line
+NEW LINE
 third
`
const m1 = new Map([["base.txt", "first\nold line\nthird\n"]])
const r1 = applyUnifiedDiff(m1, p1)
ok("create content", r1.results.get("new.txt") === "line one\nline two\n")
ok("modify hunk", r1.results.get("base.txt") === "first\nNEW LINE\nthird\n")
ok("created tracked", r1.created.join() === "new.txt")

// 2. plain unprefixed headers (diff -u style with timestamps)
const p2 = `--- base.txt\t2026-01-01
+++ base.txt\t2026-01-02
@@ -1,2 +1,2 @@
 aa
-bb
+BB
`
const m2 = new Map([["base.txt", "aa\nbb\n"]])
ok("unprefixed+timestamp", applyUnifiedDiff(m2, p2).results.get("base.txt") === "aa\nBB\n")

// 3. fuzzy anchor: declared line 50, actual at 1
const p3 = `--- a/f.txt
+++ b/f.txt
@@ -50,2 +50,2 @@
 hello
-world
+EARTH
`
const m3 = new Map([["f.txt", "hello\nworld\nmore\n"]])
ok("fuzzy anchor", applyUnifiedDiff(m3, p3).results.get("f.txt") === "hello\nEARTH\nmore\n")

// 4. atomic failure: second file hunk bad → nothing applied
const p4 = `--- a/good.txt
+++ b/good.txt
@@ -1,1 +1,1 @@
-x
+X
--- a/bad.txt
+++ b/bad.txt
@@ -1,2 +1,2 @@
 nope
-nada
+nada2
`
const m4 = new Map([["good.txt", "x\n"], ["bad.txt", "other\n"]])
let threw4 = ""
try { applyUnifiedDiff(m4, p4) } catch (e) { threw4 = e.message }
ok("atomic throw", threw4.includes("does not apply"))
ok("good.txt untouched (no write happens in engine)", m4.get("good.txt") === "x\n")

// 5. context-count edge: 1 ctx + 1 del + 1 add then NEXT file header must not be swallowed
const p5 = `--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
 ctx
-del
+add
--- a/two.txt
+++ b/two.txt
@@ -1,1 +1,1 @@
-alpha
+ALPHA
`
const m5 = new Map([["one.txt", "ctx\ndel\n"], ["two.txt", "alpha\n"]])
const r5 = applyUnifiedDiff(m5, p5)
ok("ctx counting multi-file", r5.results.get("one.txt") === "ctx\nadd\n" && r5.results.get("two.txt") === "ALPHA\n")

// 6. deletion (+++ /dev/null)
const p6 = `--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
`
const m6 = new Map([["gone.txt", "bye\nnow\n"]])
const r6 = applyUnifiedDiff(m6, p6)
ok("delete tracked", r6.deleted.join() === "gone.txt")

// 7. no trailing newline marker
const p7 = `--- a/n.txt
+++ b/n.txt
@@ -1,1 +1,1 @@
-a
+b
\\ No newline at end of file
`
const m7 = new Map([["n.txt", "a"]])
ok("no-newline marker", applyUnifiedDiff(m7, p7).results.get("n.txt") === "b")

// 8. malformed count declaration → clear error
let threw8 = ""
try {
  parsePatch("--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,1 @@\n-a\n+b\n")
} catch (e) { threw8 = e.message }
ok("count mismatch throws", threw8.includes("1/3"))

// 9. append at end of file
const p9 = `--- a/app.txt
+++ b/app.txt
@@ -2,1 +2,2 @@
 two
+three
`
const m9 = new Map([["app.txt", "one\ntwo\n"]])
ok("append via hunk", applyUnifiedDiff(m9, p9).results.get("app.txt") === "one\ntwo\nthree\n")

// 10. already-applied idempotence failure is a clear error
let threw10 = ""
try { applyUnifiedDiff(new Map([["f.txt", "hello\nEARTH\nmore\n"]]), p3) } catch (e) { threw10 = e.message }
ok("re-apply throws clearly", threw10.includes("does not apply"))

console.log(`\n== diffpatch: ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
