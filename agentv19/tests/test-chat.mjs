#!/usr/bin/env node
/**
 * forge — chat helper unit checks (v20.2). Gives chat.js its first direct unit
 * coverage: the never-lose-work interrupt handler and the shell/sentence
 * classifier. Zero network.
 */
import { interruptedTurnResult, isShellLine, SHELL_COMMANDS, chatSystemPrompt } from "../forge/chat.js"

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== interruptedTurnResult (never-lose-work) ==")
{
  const snap = [{ role: "user", content: "hi" }]
  const mid = [...snap, { role: "assistant", content: "" }, { role: "tool", tool_call_id: "t1", content: "out" }]
  // partial text present → keep it, marked, appended to current messages
  const r1 = interruptedTurnResult(mid, snap, "here is a partial ans")
  ok("partial kept", r1.kept === true)
  ok("partial appended as assistant message", r1.messages[r1.messages.length - 1].role === "assistant")
  ok("partial text preserved", /here is a partial ans/.test(r1.messages[r1.messages.length - 1].content))
  ok("interrupt marker added", /interrupted/.test(r1.messages[r1.messages.length - 1].content))
  ok("existing tool messages retained", r1.messages.length === mid.length + 1)

  // no output → roll back to the pre-turn snapshot (no orphaned user/tool msgs)
  const r2 = interruptedTurnResult(mid, snap, "   ")
  ok("empty partial rolls back", r2.kept === false)
  ok("rollback restores the snapshot exactly", r2.messages === snap)

  const r3 = interruptedTurnResult(mid, snap, null)
  ok("null partial rolls back", r3.kept === false && r3.messages === snap)
}

console.log("== isShellLine (sentences vs commands) ==")
ok("bare command executes", isShellLine("ls") === true)
ok("command with flags executes", isShellLine("git status -s") === true)
ok("pipe executes", isShellLine("cat x | grep y") === true)
ok("! forces execution", isShellLine("!echo hi") === true)
ok("question is not a command", isShellLine("what is find?") === false)
ok("sentence starting with a command word is not a command", isShellLine("make it work please") === false)
ok("english sentence not executed", isShellLine("find the bug in main.js") === false)

console.log("== SHELL_COMMANDS and chatSystemPrompt ==")
ok("SHELL_COMMANDS contains core utilities", SHELL_COMMANDS.has("ls") && SHELL_COMMANDS.has("git") && SHELL_COMMANDS.has("grep"))
{
  const sp1 = chatSystemPrompt({ chat: { system: "Custom user rule" } }, { toolsEnabled: true, deep: true, query: "test" })
  ok("chatSystemPrompt contains assistant identity", sp1.includes("You are forge"))
  ok("chatSystemPrompt mentions tools when enabled", sp1.includes("TOOLS:"))
  ok("chatSystemPrompt mentions deep thinking when deep=true", sp1.includes("DEEP THINKING MODE"))
  ok("chatSystemPrompt includes custom user instructions", sp1.includes("USER INSTRUCTIONS: Custom user rule"))
}

console.log(`\n== chat suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
