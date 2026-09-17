/**
 * forge — the YOLO switch, resolved in ONE place (v122 "yolowise")
 *
 * Before this module, "full control" was a pile of booleans read in six
 * different files: `tools.unrestricted` in agent.js, `tools.autoApprove` in
 * chat.js + toolintel.js, `tools.assumeYes` in shellguard,
 * `tools.allowOutsideProject` in tools.js, and `tools.yolo` nowhere at all.
 * `--yolo` set the environment, `/yolo` set the config, and BOTH still got
 * refused by layers neither of them knew about — the governor freezing tools
 * mid-run ("BLOCKED: governor INSPECT forbids write_file"), the pre-edit
 * critique (secret-path write → WAITING_FOR_USER), the read-only worker's
 * hand-written bash allowlist, the capability router withholding MCP on
 * INSPECT steps, and a system prompt that told the model commands were
 * blocked even after v88 stopped blocking them.
 *
 * This module is the single answer to one question: MAY THIS RUN DO ANYTHING,
 * WITHOUT ASKING? Every layer asks it instead of inventing its own rule.
 *
 * What YOLO governs is FRICTION BETWEEN THE OWNER AND THEIR OWN MACHINE:
 * confirmation pauses, refusals, tool-freezing, scope boundaries, ceilings.
 * What it deliberately does NOT touch is DEFENCE AGAINST OTHER PEOPLE'S CODE,
 * because turning those off does not make the agent freer, it makes the
 * machine hijackable:
 *   - project `forge.config.json` stays stripped of every privileged key
 *     (config.js: PRIVILEGED_TOOL_KEYS) — a cloned repo must never arm an
 *     agent against its own operator;
 *   - tool results stay attribution-fenced (contentfence.js) and the
 *     data-not-instructions rule stays in both system prompts;
 *   - tool results stay secret-redacted (secrets.js) so keys do not ride into
 *     provider logs — redaction is a copy filter, it never withholds a command;
 *   - securefs write mechanics (atomic temp→fsync→rename, ESYMLINK on a
 *     trailing symlink) stay — they are correctness under concurrent writes,
 *     not a permission gate;
 *   - `pinnedFetch` socket pinning stays — it is DNS-rebinding integrity, and
 *     private/loopback METADATA targets are already allowed (`fetchPrivateUrls`).
 * Those are the rails that keep a full-control agent from being steered by a
 * repository it was told to fix. `forge yolo` prints them so nothing about
 * this list is a secret.
 *
 * Zero dependencies. Pure functions.
 */

const TRUTHY = new Set(["1", "true", "on", "yes"])
const FALSY = new Set(["0", "false", "off", "no"])

function envSwitch(env, name) {
  const v = env?.[name]
  if (v === undefined || v === null || v === "") return null
  const s = String(v).trim().toLowerCase()
  if (TRUTHY.has(s)) return true
  if (FALSY.has(s)) return false
  return null
}

/** Tri-state pin: "always" | "never" | "auto" (auto = YOLO decides). */
function pinOf(value, envValue) {
  const raw = envValue ?? value
  if (raw === true || raw === "always" || raw === "on") return "always"
  if (raw === false || raw === "never" || raw === "off") return "never"
  return "auto"
}

/**
 * Resolve the full control state. `config` is the MERGED config (the object
 * every layer already has); `env` defaults to process.env.
 *
 * Precedence: FORGE_YOLO / --yolo (a flag for THIS process) > tools.yolo
 * (the persisted switch) > the historical pair (unrestricted && autoApprove,
 * both of which ship true, so YOLO is ON out of the box).
 */
export function yoloState(config = {}, env = process.env) {
  const t = config?.tools ?? {}
  const unrestricted = t.unrestricted === true || envSwitch(env, "FORGE_UNRESTRICTED") === true
  const autoApprove = t.autoApprove === true || envSwitch(env, "FORGE_AUTO_APPROVE") === true

  const explicit = envSwitch(env, "FORGE_YOLO")
  const persisted = t.yolo === true ? true : t.yolo === false ? false : null
  const yolo = explicit !== null ? explicit : persisted !== null ? persisted : (unrestricted && autoApprove)

  // where the verdict came from — printed by `forge yolo` / `/status` so the
  // operator never has to guess which of four switches won
  const source = explicit !== null ? (explicit ? "env FORGE_YOLO" : "env FORGE_YOLO=0")
    : persisted !== null ? (persisted ? "tools.yolo" : "tools.yolo=false")
      : yolo ? "defaults (tools.unrestricted && tools.autoApprove)" : "tools.unrestricted/autoApprove off"

  // Every privileged grant YOLO implies. Each stays independently settable
  // when YOLO is off; when it is on, none of them can veto the owner.
  const grant = (key) => yolo || t[key] === true
  const governorPin = pinOf(config?.governor?.enforce, envSwitch(env, "FORGE_GOVERNOR"))
  const critiquePin = pinOf(config?.critique?.enforce, envSwitch(env, "FORGE_CRITIQUE_ENFORCE"))

  // v124: WHICH key is holding it off, and the one command that fixes it.
  //
  // YOLO ships ON — a default config resolves every grant true. But the
  // derivation is `unrestricted && autoApprove`, and `forge config set` writes
  // the WHOLE merged object, so a config file written by a forge older than
  // v85 persists `unrestricted: false` forever. One stale key silently puts
  // every layer back in charge, and `source` only said
  // "tools.unrestricted/autoApprove off" — naming both keys without saying
  // which, and never saying how to undo it. Same shape as the v120 stale
  // `retry.connectMs`: an old default outliving the release that changed it.
  const blockedBy = []
  if (explicit === false) blockedBy.push("env FORGE_YOLO")
  else if (persisted === false) blockedBy.push("tools.yolo")
  else if (!yolo) {
    if (!unrestricted) blockedBy.push("tools.unrestricted")
    if (!autoApprove) blockedBy.push("tools.autoApprove")
  }
  // A pin keeps its layer enforcing even with YOLO on — deliberate, but it is
  // the other way a run gets refused while `forge yolo` reads "FULL CONTROL".
  const pinnedOn = []
  if (yolo && governorPin === "always") pinnedOn.push("governor.enforce")
  if (yolo && critiquePin === "always") pinnedOn.push("critique.enforce")

  return {
    yolo,
    source,
    blockedBy,
    pinnedOn,
    // the exact command, because "set the flag" is not an instruction
    fix: blockedBy.length
      ? (blockedBy[0] === "env FORGE_YOLO" ? "unset FORGE_YOLO   (or: FORGE_YOLO=1)" : "forge yolo on")
      : pinnedOn.length ? `forge config set ${pinnedOn[0]} auto` : null,
    // the historical switches, resolved the same way every caller used to
    unrestricted,
    autoApprove,
    assumeYes: yolo || t.assumeYes === true || envSwitch(env, "FORGE_ASSUME_YES") === true,
    allowSudo: grant("allowSudo"),
    allowOutsideProject: yolo || t.allowOutsideProject === true,
    // v104 §5 made traversal its OWN grant; YOLO answers it too, because
    // "search that tree" is a scope question the owner has already answered.
    allowOutsideTraversal: yolo || t.allowOutsideProject === true,
    allowInterpreterEval: grant("allowInterpreterEval"),
    allowNetworkUpload: grant("allowNetworkUpload"),
    allowNewPlugins: grant("allowNewPlugins"),
    fetchPrivateUrls: yolo || t.fetchPrivateUrls === true || envSwitch(env, "FORGE_ALLOW_PRIVATE_URLS") === true,
    // the governor keeps CHOOSING and keeps NARRATING; only its veto is off
    governorEnforce: governorPin === "always" ? true : governorPin === "never" ? false : !yolo,
    governorPinned: governorPin !== "auto",
    critiqueEnforce: critiquePin === "always" ? true : critiquePin === "never" ? false : !yolo,
    // the read-only worker (verifier/reviewer/planner) is a ROLE, not a
    // safety gate: writes stay refused, but which bash commands count as
    // "a verification command" stops being a hand-written allowlist and
    // becomes the classifier's own answer.
    readOnlyBashByClass: yolo,
    // the capability-router risk ceiling: null = no ceiling
    maxRisk: yolo ? null : (t.maxRisk ?? null),
  }
}

/** The tool-context grants implied by a resolved state (spread into ctx). */
export function yoloGrants(state = {}) {
  return {
    unrestricted: state.unrestricted === true || state.yolo === true,
    assumeYes: state.assumeYes === true,
    allowSudo: state.allowSudo === true,
    allowOutsideProject: state.allowOutsideProject === true,
    allowOutsideTraversal: state.allowOutsideTraversal === true,
    allowInterpreterEval: state.allowInterpreterEval === true,
    allowNetworkUpload: state.allowNetworkUpload === true,
    fetchPrivateUrls: state.fetchPrivateUrls === true,
    yolo: state.yolo === true,
  }
}

/** The switches a cloned repository may NEVER arm, printed for `forge yolo`. */
export const NEVER_YOLO = [
  ["project config privileges", "config.js PRIVILEGED_TOOL_KEYS", "a repo you have not read cannot arm the agent that runs on your machine"],
  ["injection fence", "contentfence.js", "tool results stay DATA, not instructions — advisory, user-killable"],
  ["secret redaction", "secrets.js", "keys are filtered out of transcripts; nothing is hidden from you"],
  ["atomic write mechanics", "securefs.js", "temp→fsync→rename + ESYMLINK: survives races, does not gate you"],
  ["socket pinning", "netguard.js pinnedFetch", "DNS-rebinding integrity; private/loopback targets are allowed"],
]

/**
 * v122: two behaviours survive YOLO that are NOT safety rails — they are what
 * makes a result mean something. They are listed next to the rails so the
 * owner is never told "everything is off" and then surprises a refusal of a
 * *lie*: a verifier that may not edit the code it verifies, and a completion
 * gate that may not call an unverified run DONE.
 */
export const NEVER_YOLO_CORRECTNESS = [
  ["read-only worker writes", "tools.js (VERIFY ⇒ READ_ONLY)", "a verifier must not mutate the artifact it verifies — the role, not the risk"],
  ["completion gate", "completion.js (v118/v119)", "refuses a false DONE, never a command: evidence still has to exist"],
]

/** Human table for `forge yolo` / `/status`. */
export function formatYolo(state = {}) {
  const yn = (v) => v === true ? "on " : "off"
  const on = state.yolo === true
  const lines = []
  lines.push(`${on ? "YOLO — FULL CONTROL (nothing is refused, nothing pauses to ask)" : "YOLO off — the layers below are back in charge"}`)
  lines.push(`  source:         ${state.source ?? "(unset)"}`)
  // v124: when it is off, say WHICH key and HOW to undo it. YOLO ships ON, so
  // "off" always means something on this machine turned it off — and until now
  // finding out which of four switches did it meant reading the source.
  if (!on && (state.blockedBy ?? []).length) {
    lines.push(`  held off by:    ${state.blockedBy.join(", ")}  ${state.blockedBy.includes("tools.unrestricted") ? "(ships true — an older config keeps the old default alive)" : ""}`.trimEnd())
    if (state.fix) lines.push(`  turn it on:     ${state.fix}`)
  }
  // …and when it is ON but a layer is pinned, say so, because that is the
  // other way a run gets refused while this screen reads FULL CONTROL.
  if (on && (state.pinnedOn ?? []).length) {
    lines.push(`  still enforcing: ${state.pinnedOn.join(", ")} pinned to "always" — YOLO does not override a pin`)
    if (state.fix) lines.push(`  release it:     ${state.fix}`)
  }
  lines.push("  refused or paused by the agent layer")
  lines.push(`    shellguard:         never refuses (v88 noguard) — level stays on every log line`)
  lines.push(`    autoApprove:        ${yn(state.autoApprove)} — no y/N, no "needs your decision"`)
  lines.push(`    assumeYes:          ${yn(state.assumeYes)}`)
  lines.push(`    governor authority: ${state.governorEnforce ? "ENFORCING (may freeze/hide tools)" : "advisory only (directive without the veto)"}${state.governorPinned ? " — pinned" : on ? " — off because of YOLO" : ""}`)
  lines.push(`    pre-edit critique:  ${state.critiqueEnforce ? "BLOCK/ASK enforced" : "advisory notes only"}`)
  lines.push(`    tools.maxRisk:      ${state.maxRisk ? state.maxRisk : "no ceiling"}`)
  lines.push("  grants implied")
  for (const k of ["allowSudo", "allowOutsideProject", "allowOutsideTraversal", "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "fetchPrivateUrls"]) {
    lines.push(`    ${k.padEnd(22)}${yn(state[k])}`)
  }
  lines.push(`    ${"read-only worker:".padEnd(22)}bash classified, not allowlisted (${yn(state.readOnlyBashByClass)}) — its WRITE refusal stays`)
  lines.push("  never turned off by YOLO (defence against other people's code, not friction for you)")
  for (const [name, where, why] of NEVER_YOLO) lines.push(`    ${name.padEnd(27)}${String(where).padEnd(34)}${why}`)
  lines.push("  kept for correctness, not permission — these never gate YOUR decision")
  for (const [name, where, why] of NEVER_YOLO_CORRECTNESS) lines.push(`    ${name.padEnd(27)}${String(where).padEnd(34)}${why}`)
  return lines.join("\n")
}
