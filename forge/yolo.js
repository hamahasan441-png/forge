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
 * v130 "yolomode" gives the answer a NAME, because "full control" was being
 * asked for in two incompatible senses:
 *   off   the layers are in charge
 *   yolo  every grant open, the governor and the pre-edit critique ADVISE ONLY
 *   full  every grant open AND those two keep their veto — the machine is
 *         unrestricted, the audit trail is not
 * `forge yolo full` / `--yolo-full` / `FORGE_YOLO_MODE=full` /
 * `tools.yoloMode: "full"` all resolve to the same nine flags, printed by
 * `forge yolo` under "YOLO mode flags" (FULL_CONTROL_FLAGS).
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
 * v130 "yolomode": the control state has three NAMES, not two booleans.
 *
 *   off   the layers are in charge (v88's shell policy aside)
 *   yolo  every grant open, the governor and the critique ADVISE ONLY
 *   full  every grant open AND the governor + the pre-edit critique keep
 *         their veto — full control over the machine, no loss of oversight
 *
 * `full` is the state an owner has been asking for by hand: `forge yolo on`
 * plus `forge config set governor.enforce always` plus the same for
 * `critique.enforce`. Three commands, and the status screen then called the
 * result an anomaly ("still enforcing … release it"), because before this the
 * only way to be in that state was to pin two layers and be told you had
 * broken something.
 */
export const YOLO_MODES = ["off", "yolo", "full"]

const MODE_ALIAS = {
  off: "off", safe: "off", none: "off", guarded: "off",
  yolo: "yolo", on: "yolo", standard: "yolo",
  full: "full", fullcontrol: "full", "full-control": "full", "full_control": "full",
}

/** Normalize a mode value; null when it is not one (never a silent default). */
export function modeOf(value) {
  if (value === null || value === undefined || value === "") return null
  return MODE_ALIAS[String(value).trim().toLowerCase()] ?? null
}

/**
 * The nine flags that ARE "YOLO mode", in the order `forge yolo full` prints
 * them: seven grants, then the two oversight layers that STAY ON in full mode.
 * Full control is about the owner's friction — confirmation pauses, refusals,
 * frozen tools, scope ceilings. It is not about losing the audit trail, so the
 * two layers that produce one are part of the mode, not an exception to it.
 */
export const FULL_CONTROL_FLAGS = [
  "yolo",
  "assumeYes",
  "allowSudo",
  "allowOutsideProject",
  "allowInterpreterEval",
  "allowNetworkUpload",
  "allowNewPlugins",
  "governorEnforce",
  "critiqueEnforce",
]

/** The nine-flag view of a resolved state — what `forge yolo full` promises. */
export function yoloModeFlags(state = {}) {
  const out = {}
  for (const k of FULL_CONTROL_FLAGS) out[k] = state[k] === true
  return out
}

/**
 * Resolve the full control state. `config` is the MERGED config (the object
 * every layer already has); `env` defaults to process.env.
 *
 * Precedence, loudest first: FORGE_YOLO / --yolo (a flag for THIS process) >
 * FORGE_YOLO_MODE / --yolo-full (a MODE for this process) > tools.yolo (the
 * persisted switch) > tools.yoloMode (the persisted mode) > the historical
 * pair (unrestricted && autoApprove, both of which ship true, so YOLO is ON
 * out of the box). Env always beats a saved file; a process flag is the one
 * thing that cannot be argued with by a config someone else wrote.
 */
export function yoloState(config = {}, env = process.env) {
  const t = config?.tools ?? {}
  const unrestricted = t.unrestricted === true || envSwitch(env, "FORGE_UNRESTRICTED") === true
  const autoApprove = t.autoApprove === true || envSwitch(env, "FORGE_AUTO_APPROVE") === true

  const explicit = envSwitch(env, "FORGE_YOLO")
  const persisted = t.yolo === true ? true : t.yolo === false ? false : null
  const modeEnv = modeOf(env?.FORGE_YOLO_MODE)
  const modeCfg = modeOf(t.yoloMode)
  const requestedMode = modeEnv ?? modeCfg ?? null
  const modeSource = modeEnv !== null ? "env FORGE_YOLO_MODE"
    : modeCfg !== null ? "tools.yoloMode" : null

  // where the verdict came from — printed by `forge yolo` / `/status` so the
  // operator never has to guess which of five switches won
  let yolo
  let source
  if (explicit !== null) {
    yolo = explicit
    source = explicit ? "env FORGE_YOLO" : "env FORGE_YOLO=0"
  } else if (modeEnv !== null) {
    yolo = modeEnv !== "off"
    source = `env FORGE_YOLO_MODE=${modeEnv}`
  } else if (persisted !== null) {
    yolo = persisted
    source = persisted ? "tools.yolo" : "tools.yolo=false"
  } else if (modeCfg !== null) {
    yolo = modeCfg !== "off"
    source = `tools.yoloMode=${modeCfg}`
  } else {
    yolo = unrestricted && autoApprove
    source = yolo ? "defaults (tools.unrestricted && tools.autoApprove)" : "tools.unrestricted/autoApprove off"
  }

  // Every privileged grant YOLO implies. Each stays independently settable
  // when YOLO is off; when it is on, none of them can veto the owner.
  const grant = (key) => yolo || t[key] === true
  const governorPin = pinOf(config?.governor?.enforce, envSwitch(env, "FORGE_GOVERNOR"))
  const critiquePin = pinOf(config?.critique?.enforce, envSwitch(env, "FORGE_CRITIQUE_ENFORCE"))
  // v130: in FULL mode an "auto" pin resolves to "always" — the owner asked
  // for the oversight layers by name, so "auto" (which means "YOLO decides",
  // and YOLO would decide "advise only") is not what they meant. An explicit
  // "never" still wins: a sentence about one layer is louder than a mode about
  // all of them, and silently overriding it would be the exact surprise v122
  // was written to remove.
  const wantsFull = requestedMode === "full" && yolo
  const governorEff = wantsFull && governorPin === "auto" ? "always" : governorPin
  const critiqueEff = wantsFull && critiquePin === "auto" ? "always" : critiquePin

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
  else if (modeEnv === "off") blockedBy.push("env FORGE_YOLO_MODE=off")
  else if (persisted === false) blockedBy.push("tools.yolo")
  else if (modeCfg === "off") blockedBy.push("tools.yoloMode=off")
  else if (!yolo) {
    if (!unrestricted) blockedBy.push("tools.unrestricted")
    if (!autoApprove) blockedBy.push("tools.autoApprove")
  }
  const governorEnforce = governorEff === "always" ? true : governorEff === "never" ? false : !yolo
  const critiqueEnforce = critiqueEff === "always" ? true : critiqueEff === "never" ? false : !yolo
  // v130: the mode that is actually in force, derived from what got resolved
  // rather than from what was asked for — so `forge yolo` can never claim
  // "full" while one of the two layers is advising.
  const mode = !yolo ? "off" : (governorEnforce && critiqueEnforce) ? "full" : "yolo"
  // A pin keeps its layer enforcing even with YOLO on — deliberate, but it is
  // the other way a run gets refused while `forge yolo` reads "FULL CONTROL".
  // In FULL mode that is the whole point, not an anomaly, so it is not
  // reported as one (the mode line says it, and says what it costs).
  const pinnedOn = []
  if (mode === "yolo") {
    if (governorPin === "always") pinnedOn.push("governor.enforce")
    if (critiquePin === "always") pinnedOn.push("critique.enforce")
  }

  return {
    yolo,
    source,
    mode,
    requestedMode,
    modeSource,
    blockedBy,
    pinnedOn,
    // the exact command, because "set the flag" is not an instruction
    fix: blockedBy.length
      ? (blockedBy[0] === "env FORGE_YOLO" ? "unset FORGE_YOLO   (or: FORGE_YOLO=1)"
        : blockedBy[0] === "env FORGE_YOLO_MODE=off" ? "unset FORGE_YOLO_MODE   (or: FORGE_YOLO_MODE=full)"
          : "forge yolo on")
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
    governorEnforce,
    governorPinned: governorPin !== "auto",
    critiqueEnforce,
    critiquePinned: critiquePin !== "auto",
    // which of the two layers full mode is holding on, vs. an owner's own pin
    governorByMode: wantsFull && governorPin === "auto",
    critiqueByMode: wantsFull && critiquePin === "auto",
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
    allowNewPlugins: state.allowNewPlugins === true,
    fetchPrivateUrls: state.fetchPrivateUrls === true,
    yolo: state.yolo === true,
  }
}

/**
 * v130 "yolomode": the config patch a mode implies — pure, so the CLI, the
 * chat slash-command and the tests all persist the SAME thing.
 *
 * It writes the MINIMUM that resolves: `tools.yolo` (which every grant derives
 * from) plus, for full mode, the two enforce pins. It deliberately does NOT
 * write allowSudo/allowInterpreterEval/allowNetworkUpload/allowNewPlugins,
 * because a grant written into the file survives `forge yolo off` — `grant()`
 * is `yolo || tools[key]`, so persisting them would leave a machine that says
 * "yolo off" and still runs sudo. The derived grants are the honest ones.
 */
/** The three historical switches, at the values a GRANTED mode wants. */
const GRANTED = { unrestricted: true, autoApprove: true, assumeYes: true }
/** …and at the values forge SHIPS them, which is what `off` restores. */
const SHIPPED = { unrestricted: true, autoApprove: true, assumeYes: false }

export function applyYoloMode(config = {}, mode) {
  const m = modeOf(mode)
  const out = {
    ...config,
    tools: { ...(config?.tools ?? {}) },
    governor: { ...(config?.governor ?? {}) },
    critique: { ...(config?.critique ?? {}) },
  }
  if (m === "full") {
    out.tools.yolo = true
    out.tools.yoloMode = "full"
    Object.assign(out.tools, GRANTED)
    out.governor.enforce = "always"
    out.critique.enforce = "always"
  } else if (m === "yolo") {
    out.tools.yolo = true
    out.tools.yoloMode = "yolo"
    Object.assign(out.tools, GRANTED)
    // Downgrading releases the pins ONLY when full mode set them. A pin the
    // owner wrote by hand is theirs; clobbering it would be a silent change to
    // a layer they asked about explicitly.
    if (modeOf(config?.tools?.yoloMode) === "full") {
      out.governor.enforce = "auto"
      out.critique.enforce = "auto"
    }
  } else if (m === "off") {
    out.tools.yolo = false
    out.tools.yoloMode = "off"
    // "off" has to actually be off. The three historical switches are what
    // `grant()` ORs with, so leaving `assumeYes: true` behind after a mode that
    // wrote it would keep granting confirmations-free runs on a machine that
    // reports YOLO off — the same stale-key shape as v120's `retry.connectMs`
    // and v124's `unrestricted: false`. They go back to the values forge SHIPS
    // (unrestricted/autoApprove on, assumeYes off), not to "deleted":
    // `forge config set` writes the whole merged object, so a deleted key
    // reappears on the next load anyway.
    Object.assign(out.tools, SHIPPED)
  }
  return out
}

/** The three lines `forge yolo <mode>` prints after it saves. */
export function yoloModeNote(mode) {
  const m = modeOf(mode)
  if (m === "full") {
    return [
      "every grant is open, AND the governor keeps its veto and the pre-edit critique keeps BLOCK/ASK.",
      "what that costs: a governor ASK can park the run in WAITING_FOR_USER, and a critique BLOCK can stop an edit — that is the oversight you asked to keep.",
    ]
  }
  if (m === "yolo") {
    return [
      "every layer that can refuse, pause or freeze is off; the classification, the directive and the critique NOTE all stay visible.",
    ]
  }
  if (m === "off") {
    return [
      "the governor, the pre-edit critique, the risk ceiling and the scope grants are back in charge (the shell still never refuses — that has been v88 policy since).",
    ]
  }
  return []
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
  const mode = state.mode ?? (on ? "yolo" : "off")
  const lines = []
  lines.push(on
    ? (mode === "full"
      ? "YOLO — FULL CONTROL (every grant open; the governor and the critique still hold their veto)"
      : "YOLO — FULL CONTROL (nothing is refused, nothing pauses to ask)")
    : "YOLO off — the layers below are back in charge")
  lines.push(`  source:         ${state.source ?? "(unset)"}`)
  // v130: the mode is a NAME, because "full control" meant two different things
  // to two different people — one wanted nothing to stop the run, the other
  // wanted nothing to stop the run *unwatched*.
  lines.push(`  mode:           ${mode}${state.requestedMode && state.modeSource && state.requestedMode === mode ? ` (${state.modeSource})` : ""}${mode === "full" ? " — every grant open, governor + critique still enforcing" : mode === "yolo" ? " — every grant open, the two oversight layers advise only" : " — the layers are in charge"}${state.requestedMode && state.requestedMode !== mode ? `  (asked for ${state.requestedMode} via ${state.modeSource}; ${mode} is what resolved)` : ""}`)
  // v124: when it is off, say WHICH key and HOW to undo it. YOLO ships ON, so
  // "off" always means something on this machine turned it off — and until now
  // finding out which of four switches did it meant reading the source.
  if (!on && (state.blockedBy ?? []).length) {
    lines.push(`  held off by:    ${state.blockedBy.join(", ")}  ${state.blockedBy.includes("tools.unrestricted") ? "(ships true — an older config keeps the old default alive)" : ""}`.trimEnd())
    if (state.fix) lines.push(`  turn it on:     ${state.fix}`)
  }
  // …and when it is ON but a layer is pinned, say so, because that is the
  // other way a run gets refused while this screen reads FULL CONTROL. In
  // FULL mode the enforcement is the point, so it is described, not flagged.
  if (on && (state.pinnedOn ?? []).length) {
    lines.push(`  still enforcing: ${state.pinnedOn.join(", ")} pinned to "always" — YOLO does not override a pin`)
    lines.push(`                   ${dimNote()}`)
    if (state.fix) lines.push(`  release it:     ${state.fix}`)
  }
  if (mode === "full") lines.push(`  what full keeps: ${dimNote()}`)
  lines.push("  refused or paused by the agent layer")
  lines.push(`    shellguard:         never refuses (v88 noguard) — level stays on every log line`)
  lines.push(`    autoApprove:        ${yn(state.autoApprove)} — no y/N, no "needs your decision"`)
  lines.push(`    assumeYes:          ${yn(state.assumeYes)}`)
  lines.push(`    governor authority: ${state.governorEnforce ? "ENFORCING (may freeze/hide tools)" : "advisory only (directive without the veto)"}${state.governorPinned ? " — pinned" : state.governorByMode ? " — held on by mode=full" : on ? " — off because of YOLO" : ""}`)
  lines.push(`    pre-edit critique:  ${state.critiqueEnforce ? "BLOCK/ASK enforced" : "advisory notes only"}${state.critiquePinned ? " — pinned" : state.critiqueByMode ? " — held on by mode=full" : ""}`)
  lines.push(`    tools.maxRisk:      ${state.maxRisk ? state.maxRisk : "no ceiling"}`)
  lines.push("  grants implied")
  for (const k of ["allowSudo", "allowOutsideProject", "allowOutsideTraversal", "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "fetchPrivateUrls"]) {
    lines.push(`    ${k.padEnd(22)}${yn(state[k])}`)
  }
  lines.push(`    ${"read-only worker:".padEnd(22)}bash classified, not allowlisted (${yn(state.readOnlyBashByClass)}) — its WRITE refusal stays`)
  // v130: the nine flags `forge yolo full` is defined by, printed as ONE block
  // so "is it really full?" is a single glance and not a reading of the table.
  lines.push(`  YOLO mode flags   ${mode === "full" ? "(all nine on — this is what `forge yolo full` resolves)" : `(set with: forge yolo full · one process: forge --yolo-full · shell: FORGE_YOLO_MODE=full)`}`)
  for (const k of FULL_CONTROL_FLAGS) {
    lines.push(`    ${k.padEnd(22)}${yn(yoloModeFlags(state)[k])}`)
  }
  lines.push("  never turned off by YOLO (defence against other people's code, not friction for you)")
  for (const [name, where, why] of NEVER_YOLO) lines.push(`    ${name.padEnd(27)}${String(where).padEnd(34)}${why}`)
  lines.push("  kept for correctness, not permission — these never gate YOUR decision")
  for (const [name, where, why] of NEVER_YOLO_CORRECTNESS) lines.push(`    ${name.padEnd(27)}${String(where).padEnd(34)}${why}`)
  return lines.join("\n")
}

/** What an enforcing layer costs — printed wherever one is on under YOLO. */
function dimNote() {
  return "a governor ASK can park the run in WAITING_FOR_USER and a critique BLOCK can stop an edit — that is the oversight, and it is the only thing that can still say no"
}
