#!/usr/bin/env node
/**
 * forge — v105 "routewise": 107 skills + 100 MCP servers exist. Dumping them
 * is not intelligence. This suite proves the router withholds, quality-gates,
 * and recommends instead of auto-installing.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + extra : ""}`) }
}

const { VERSION } = await import("../version.js")
const {
  applyRoutePolicy, budgetFor, recommendForGaps, formatRecommendations,
  isMutatingName, ROUTE_VERSION,
} = await import("../caproute.js")
const { selectForTurn } = await import("../capindex.js")
const { evaluateSkills } = await import("../evaluate.js")
const { maskToolDefs, enforceToolCall, authorityFor, ACTION, isMutatingExternal } = await import("../governor.js")
const { MCP_CATALOG } = await import("../mcpcatalog.js")

console.log("== version identity ==")
{
  ok("package version is 113.x", /^113\./.test(VERSION), VERSION)
  ok("route protocol set", ROUTE_VERSION === "1.0.0")
  ok("MCP catalog is the curated 100", MCP_CATALOG.length === 100)
}

console.log("== klass budget: a typo does not load the catalog ==")
{
  ok("MICRO mcp=0 skills=0", budgetFor("MICRO").mcp === 0 && budgetFor("MICRO").skills === 0)
  ok("ARCHITECTURAL allows a small top-k", budgetFor("ARCHITECTURAL").skills === 3 && budgetFor("ARCHITECTURAL").mcp === 8)
  const ext = (server, tool, ro = false) => ({
    name: `mcp__${server}__${tool}`, source: `mcp:${server}`, readOnly: ro,
    def: { type: "function", function: { name: `mcp__${server}__${tool}` } },
  })
  const micro = applyRoutePolicy({
    task: "fix a typo", klass: "MICRO", action: "EXECUTE",
    skills: [{ name: "coding-agent", desc: "code" }],
    mcpKept: [ext("github", "list_issues", true)],
  })
  ok("MICRO withholds un-named skill", micro.skills.length === 0)
  ok("MICRO withholds un-named MCP", micro.mcpKept.length === 0)
  const named = applyRoutePolicy({
    task: "use coding-agent on this typo", klass: "MICRO", action: "EXECUTE",
    skills: [{ name: "coding-agent", desc: "code" }],
    mcpKept: [],
  })
  ok("MICRO keeps a skill NAMED in the task", named.skills.some((s) => s.name === "coding-agent"))
}

console.log("== quality gate: CANDIDATE/stale are not auto-injected ==")
{
  const r = applyRoutePolicy({
    task: "review the auth architecture", klass: "LARGE", action: "EXECUTE",
    skills: [
      { name: "code-reviewer", lifecycle: "VERIFIED", desc: "review" },
      { name: "sketchy", lifecycle: "CANDIDATE", desc: "review" },
      { name: "old-review", lifecycle: "VERIFIED", stale: true, desc: "review" },
    ],
    mcpKept: [],
  })
  ok("VERIFIED skill can survive", r.skills.some((s) => s.name === "code-reviewer"))
  ok("CANDIDATE is withheld", !r.skills.some((s) => s.name === "sketchy"))
  ok("stale is withheld unless named", !r.skills.some((s) => s.name === "old-review"))
  const evald = evaluateSkills("review the pull request", [
    { name: "code-reviewer", desc: "review a pr", lifecycle: "ACTIVE" },
    { name: "wip-review", desc: "review a pr", lifecycle: "CANDIDATE" },
  ], { klass: "LARGE" })
  ok("evaluateSkills drops CANDIDATE", !evald.some((s) => s.name === "wip-review"))
}

console.log("== INSPECT withholds mutating MCP, keeps read-only ==")
{
  const ext = (tool, ro) => ({
    name: `mcp__github__${tool}`, source: "mcp:github", readOnly: ro,
    def: { type: "function", function: { name: `mcp__github__${tool}` } },
  })
  const r = applyRoutePolicy({
    task: "inspect github issues", klass: "LARGE", action: "INSPECT",
    skills: [],
    mcpKept: [ext("list_issues", true), ext("create_issue", false)],
  })
  ok("read-only MCP may stay on INSPECT", r.mcpKept.some((p) => p.name.endsWith("list_issues")))
  ok("create_issue is withheld on INSPECT", !r.mcpKept.some((p) => p.name.endsWith("create_issue")))
  ok("isMutatingName(create_issue)", isMutatingName("mcp__github__create_issue") === true)
  ok("isMutatingName(list_issues) is false", isMutatingName("mcp__github__list_issues") === false)
}

console.log("== governor masks mutating MCP the same way ==")
{
  const defs = [
    { function: { name: "read_file" } },
    { function: { name: "write_file" } },
    { function: { name: "mcp__github__list_issues" } },
    { function: { name: "mcp__github__create_issue" } },
  ]
  const auth = authorityFor(ACTION.INSPECT, { klass: "LARGE" })
  const masked = maskToolDefs(defs, { ...auth, allow: ["mcp__github__list_issues"] })
  const names = masked.map((d) => d.function.name)
  ok("INSPECT keeps read_file", names.includes("read_file"))
  ok("INSPECT drops write_file", !names.includes("write_file"))
  ok("INSPECT can keep read-only MCP via allow", names.includes("mcp__github__list_issues"))
  ok("INSPECT drops mutating MCP", !names.includes("mcp__github__create_issue"))
  ok("enforce blocks create_issue", enforceToolCall("mcp__github__create_issue", { ...auth, allow: ["mcp__github__list_issues"] }).ok === false)
  ok("isMutatingExternal(create_issue)", isMutatingExternal("mcp__github__create_issue") === true)
}

console.log("== gaps recommend install, they do not auto-connect ==")
{
  const recs = recommendForGaps({ task: "github pull requests", gaps: ["github"], limit: 3 })
  ok("recommendations come back", recs.length >= 1, JSON.stringify(recs.slice(0, 2)))
  ok("an MCP rec is an explicit add", recs.some((r) => r.kind === "mcp" && /forge mcp add/.test(r.how)))
  ok("format names the constraint", /not installed/.test(formatRecommendations(recs)))
}

console.log("== selectForTurn uses the router ==")
{
  const ext = (server, tool, desc = "") => ({
    name: `mcp__${server}__${tool}`, source: `mcp:${server}`,
    def: { type: "function", function: { name: `mcp__${server}__${tool}`, description: desc } },
  })
  const r = selectForTurn({
    task: "fix a typo",
    klass: "MICRO",
    mcpPlugins: [ext("github", "list_issues", "list issues")],
    pickSkillsFn: () => [{ name: "coding-agent", desc: "code" }],
    nativeNames: ["read_file"],
  })
  ok("MICRO turn keeps no auto MCP", r.mcp.kept.length === 0)
  ok("MICRO turn keeps no auto skill", r.skills.length === 0)
}

console.log("== live agent path is wired ==")
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent.js"), "utf8")
  ok("agent imports caproute", /from "\.\/caproute\.js"/.test(src))
  ok("agent passes klass into selectForTurn", /klass: turnKlass/.test(src))
  ok("agent allows read-only MCP under governor mask", /allow: \(plugins/.test(src))
  ok("agent recommends on gaps", /recommendForGaps/.test(src))
}

console.log(`\n== route suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
