#!/usr/bin/env node
/**
 * forge — session hygiene checks (v20.2 P1-6): rotation cap on new-session
 * creation and content search. Isolated FORGE_HOME, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-"))
const { saveSession, listSessions, searchSessions, pruneSessions, MAX_SESSIONS } = await import("../forge/sessions.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log("== search ==")
saveSession({ provider: "mock", model: "m", messages: [{ role: "user", content: "help me fix the OAuth token refresh bug" }] })
saveSession({ provider: "mock", model: "m", messages: [{ role: "user", content: "write a haiku about mountains" }] })
saveSession({ provider: "mock", model: "m", messages: [{ role: "user", content: "set up a Postgres migration" }] })
const hits = searchSessions("oauth token")
ok("finds the matching session", hits.length === 1 && /oauth/i.test(hits[0].title))
ok("returns a snippet", typeof hits[0].snippet === "string" && hits[0].snippet.length > 0)
ok("non-matching query → empty", searchSessions("nonexistent-xyzzy").length === 0)
ok("empty query → empty", searchSessions("   ").length === 0)
ok("case-insensitive", searchSessions("POSTGRES").length === 1)

console.log("== rotation cap ==")
ok("MAX_SESSIONS is a positive number", typeof MAX_SESSIONS === "number" && MAX_SESSIONS > 0)
// create more than a small cap and prune to it
for (let i = 0; i < 8; i++) { saveSession({ provider: "mock", model: "m", messages: [{ role: "user", content: "session " + i }] }); await sleep(2) }
const before = listSessions(999).length
ok("many sessions saved", before >= 10)
const removed = pruneSessions(5)
ok("prune removes the excess", removed === before - 5)
ok("prune keeps exactly the cap", listSessions(999).length === 5)
ok("prune keeps the NEWEST ones", listSessions(999).some((s) => /session 7/.test(s.title)))
ok("prune dropped the oldest", !listSessions(999).some((s) => /fix the OAuth/.test(s.title)))
ok("prune under cap is a no-op", pruneSessions(999) === 0)

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== sessions suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
