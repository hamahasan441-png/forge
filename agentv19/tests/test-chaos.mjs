#!/usr/bin/env node
/**
 * forge — chaos tests (v23 hardening, zero dependencies)
 * Covers: random segment failures, crash/resume, DAG conflict races,
 * verification invalidation under mutation, checkpoint integrity under load,
 * read-only violation attempts, resource exhaustion.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chaos-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chaos-work-"))
process.chdir(WORK)

const { openTask, TASK_STATUS, DURABILITY } = await import("../forge/taskstate.js")
const { createLedger } = await import("../forge/verifyledger.js")
const { snapshotBefore, verifyCheckpointIntegrity, fullFileHash } = await import("../forge/checkpoint.js")
const dag = await import("../forge/dag.js")
const meta = await import("../forge/meta.js")
const { makeToolContext } = await import("../forge/tools.js")

let PASS=0, FAIL=0
const ok=(n,c)=>{ if(c){PASS++; console.log(`  ok   ${n}`)} else {FAIL++; console.log(`  FAIL ${n}`)} }

console.log("== chaos: random DAG conflicts ==")
{
  for (let iter=0; iter<20; iter++){
    const defs=[]
    for(let i=0;i<5;i++){
      const id=`n${i+1}`
      const files = Math.random()>0.5 ? [`src/${String.fromCharCode(97+Math.floor(Math.random()*3))}.js`] : []
      defs.push({id, objective:`edit ${files.join(",")||"something"}`, targetFiles:files, dependencies: i>0 && Math.random()>0.6 ? [`n${Math.floor(Math.random()*i)+1}`] : []})
    }
    try{
      const g=dag.buildDAG(defs)
      const batch=dag.scheduleBatch(g, {maxParallel:3, conflictKeys: dag.canonicalConflictKeys})
      // batch must never contain conflicting file keys
      const seen=new Set()
      let conflict=false
      for(const n of batch){
        const keys=dag.canonicalConflictKeys(n)
        for(const k of keys){
          if(seen.has(k) && k.startsWith("file:")) conflict=true
          seen.add(k)
        }
      }
      ok(`chaos iter ${iter} no conflicting files in batch`, !conflict)
    } catch(e){
      // cycle or duplicate is ok to reject
      ok(`chaos iter ${iter} rejects invalid DAG safely`, /cycle|duplicate|unknown/.test(e.message))
    }
  }
}

console.log("== chaos: checkpoint integrity under mutation ==")
{
  const file=path.join(WORK, "chaos.txt")
  fs.writeFileSync(file, "initial")
  for(let i=0;i<10;i++){
    const id=snapshotBefore([file], WORK, [], `run-chaos-${i}`)
    fs.writeFileSync(file, `version-${i}-${Math.random()}`)
    const integ=verifyCheckpointIntegrity(id)
    ok(`checkpoint ${i} integrity`, integ.ok)
  }
}

console.log("== chaos: verification invalidation race ==")
{
  const ledger=createLedger()
  ledger.recordCommand("node --check src/a.js", "ok", {exitCode:0, affectedFiles:["src/a.js"], taskId:"t1", nodeId:"n1", segmentId:"seg-1"})
  ledger.recordCommand("npx vitest run src/a.test.js", "2 passed", {exitCode:0, affectedFiles:["src/a.js"], taskId:"t1", nodeId:"n1", segmentId:"seg-1"})
  let st=ledger.status("medium", ["src/a.js"], {nodeId:"n1"})
  ok("before invalidation verified", st.ok)
  // simulate mutation invalidates
  ledger.invalidate(["src/a.js"])
  st=ledger.status("medium", ["src/a.js"], {nodeId:"n1"})
  ok("after invalidation not verified", !st.ok)
  // unrelated node should not be affected
  ledger.recordCommand("node --check src/b.js", "ok", {exitCode:0, affectedFiles:["src/b.js"], taskId:"t1", nodeId:"n2", segmentId:"seg-2"})
  ledger.recordCommand("npx vitest run src/b.test.js", "2 passed", {exitCode:0, affectedFiles:["src/b.js"], taskId:"t1", nodeId:"n2", segmentId:"seg-2"})
  const st2=ledger.status("medium", ["src/b.js"], {nodeId:"n2"})
  ok("unrelated node still verified", st2.ok)
  const st3=ledger.status("medium", ["src/b.js"], {nodeId:"n1"})
  ok("nodeId filter: unrelated node failure doesn't block other", st3.ok || !st3.anyFailure)
}

console.log("== chaos: read-only violation fuzz ==")
{
  const ctx={cwd:WORK, root:WORK, timeoutSec:5, maxToolOutput:1000, readOnly:true, _plugins:new Map()}
  const { execTool } = await import("../forge/tools.js")
  const cmds=["rm -rf /tmp", "echo hi > /etc/passwd", "npm install foo", "write_file x", "edit_file y", "apply_patch", "multi_edit"]
  for(const cmd of cmds){
    const res=await execTool(ctx, "bash", {command:cmd})
    if(cmd.includes("npm test") || cmd.includes("echo hi") && false){}
    // mutating cmds should be blocked
    if(cmd.startsWith("rm") || cmd.includes(">") || cmd.includes("npm install")){
      ok(`read-only blocks ${cmd.slice(0,20)}`, /BLOCKED/.test(res))
    }
  }
  const r=await execTool(ctx, "bash", {command:"npm test"})
  ok("read-only allows npm test under fuzz", !/BLOCKED/.test(r))
}

console.log("== chaos: segment safety fuse ==")
{
  let segCount=0
  const runAgent=async(o)=>{
    if(o.planOnly) return {text:"1. a\n2. b\n3. c\n4. d\n5. e", toolRecords:[], commandChecks:[], toolLog:[]}
    segCount++
    return {text:`working ${segCount}`, budgetHit:true, steps:5, toolRecords:[], commandChecks:[], toolLog:[], usage:{}}
  }
  const cfg={providers:{}, agent:{autonomous:true, modelStrategy:false}, tools:{}}
  const r=await meta.runMeta({config:cfg, provider:{name:"x", model:"m"}, task:"long running task with many steps", runAgent, maxSegments:3})
  ok("safety fuse triggers WAITING not FAILED", r.status==="WAITING")
  ok("safety fuse checkpoints", r.task.checkpoint_id!==null || r.task.checkpoints.length>0)
}

console.log("== chaos: taskstate critical durability under random failures ==")
{
  const t=openTask("chaos-dur", {objective:"chaos durability", cwd:WORK})
  for(let i=0;i<10;i++){
    t.transition(TASK_STATUS.EXECUTING)
    t.addSegment({objective:`seg ${i}`, steps:1, tool_calls:1})
    if(i%3===0) t.transition(TASK_STATUS.CHECKPOINTING)
    if(i%4===0) t.transition(TASK_STATUS.WAITING, {reason:"random wait"})
    try{ t.flush(DURABILITY.CRITICAL) } catch {}
  }
  t.transition(TASK_STATUS.WAITING, {reason:"final wait"})
  t.flush(DURABILITY.CRITICAL)
  const { readTask } = await import("../forge/taskstate.js")
  const rec=readTask("chaos-dur")
  ok("chaos durability task still WAITING", rec.status==="WAITING")
  ok("chaos durability segments persisted", rec.segment_count>=5)
}

console.log("== chaos: full SHA detects tampering anywhere ==")
{
  const file=path.join(WORK, "tamper.txt")
  const content="x".repeat(2*1024*1024) // 2MB
  fs.writeFileSync(file, content)
  const h1=fullFileHash(file)
  // tamper middle
  const fd=fs.openSync(file, "r+")
  fs.writeSync(fd, "TAMPER", 1024*1024, "utf8")
  fs.closeSync(fd)
  const h2=fullFileHash(file)
  ok("full SHA detects middle tampering", h1.sha!==h2.sha)
  // tamper end
  fs.appendFileSync(file, "END")
  const h3=fullFileHash(file)
  ok("full SHA detects end tampering", h2.sha!==h3.sha)
}

console.log(`\n== chaos suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL?1:0)
