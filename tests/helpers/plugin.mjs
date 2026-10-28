// bili-whale-cc：原来这里驱动的是 DSH 插件的 HTTP 路由（lib/index.js）；
// 移植后同一批断言改成直接调宿主的函数（host/core.mjs），覆盖的行为不变：
// 设置保存不重置计划 · 人设读写 · cookie 写入 · 审批失败放回草稿 · 缺运行时报错
import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import assert from 'node:assert/strict'
cp.execFile=(exe,args,options,cb)=>{
  if(args.includes('comment')) {
    const success=process.env.TEST_SEND_SUCCESS==='1'
    // bili-whale-cc：批准草稿的结果从 BILI_RESULT_FILE 拿（不从输出里找「code=」）
    if(options?.env?.BILI_RESULT_FILE) fs.writeFileSync(options.env.BILI_RESULT_FILE,JSON.stringify(success?{code:0,rpid:'123'}:{code:-101}))
    queueMicrotask(()=>cb(success?null:new Error('mock send failure'),success?'[go] 发送中…\ncode=0 rpid=123':'[go] 发送中…\ncode=-101',''))
  } else {
    assert.ok(args.includes('take')||args.includes('add'))
    const r=cp.spawnSync(exe,args,{...options,encoding:'utf8'})
    queueMicrotask(()=>cb(r.status?new Error(r.stderr):null,r.stdout,r.stderr))
  }
  return {kill(){}}
}
syncBuiltinESMExports()
const core=await import('../../host/core.mjs')
if(process.env.TEST_NO_NODE) {
  // 「外面找不到 node」的环境，在本进程里设好、两次检查都用它（Codex 复核第 10 版：以前只隔离了第一次，
  // 第二次 runtimeStatus 读真环境，找到系统装的 node；用别的 node 跑测试时 ≠ process.execPath 就失败）：
  //  · ProgramFiles：父进程单删没用（新进程里系统按 ProgramW6432 设回 C:\Program Files），装了官方 Node 的机器上那里真有 node.exe —— 进程里改成不存在的目录
  //  · 外部给的 node 位置（DSH_NODE / DSH_DESKTOP_NODE_EXECUTABLE）也清掉
  process.env.ProgramFiles=path.join(process.env.DSH_HOME,'no-program-files')
  delete process.env.DSH_NODE
  delete process.env.DSH_DESKTOP_NODE_EXECUTABLE
  // 外面找不到 node 时：严格解析要明确报错（不静默拿别的程序顶替）……
  const {resolveRuntime}=await import('../../tools/lib/runtime.mjs')
  assert.throws(()=>resolveRuntime(process.env.DSH_HOME),/node/)
  // ……而 Claude Code 版宿主自己就跑在真 node 上（不是 Electron），可以退回当前进程
  const r=core.runtimeStatus()
  assert.equal(r.ok,true)
  assert.equal(r.file,process.execPath)
} else {
  const stateFile=path.join(process.env.DSH_HOME,'whale-night.json')
  const preserved={schema:2,date:new Date().toLocaleDateString('sv-SE'),action:'skip',fired:false,atMs:Date.now()+3600000,endsAt:Date.now()+7200000,usedCount:{},skippedWindows:[]}
  fs.writeFileSync(stateFile,JSON.stringify(preserved))
  const settings=core.saveSettings({diary:{push:false}})
  assert.equal(settings.config.diary.push,false)
  assert.equal(settings.schedulingChanged,false)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),preserved)
  const text='测试人设：使用简洁句子。'
  assert.equal(core.setPersona(text).ok,true)
  assert.equal(core.getPersona(),text)
  core.setPersona('')
  assert.equal(core.getPersona(),'')
  await core.writeCookie({sessdata:'SESSDATA=replacement-cookie-local-test;',bili_jct:'b'.repeat(32)},{verify:false})
  const {loadCred}=await import('../../tools/lib/cred.mjs')
  assert.equal(loadCred().sessdata,'replacement-cookie-local-test')
  const pending=path.join(process.env.USERPROFILE,'.bili-ai/pending-replies.json')
  fs.writeFileSync(pending,JSON.stringify({items:[{id:'test',oid:'1',bvid:'BV1234567890',root:'2',parent:'2',message:'local draft'}]}))
  const response=await core.approveDraft('test')
  assert.equal(response.ok,process.env.TEST_SEND_SUCCESS==='1')
  const queue=JSON.parse(fs.readFileSync(pending,'utf8')).items
  assert.equal(queue.length,process.env.TEST_SEND_SUCCESS==='1'?0:1)
}
