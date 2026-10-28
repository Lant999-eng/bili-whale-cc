import test from 'node:test'
import { wakePrompt } from '../lib/scheduler.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWorkDir } from '../lib/work-dir.js'
import { resolveRuntime, probeRuntime } from '../tools/lib/runtime.mjs'
import { execFileSync } from '../tools/lib/capture.mjs'
import { makePlan, completePlan, historyOf } from '../tools/lib/night-plan.mjs'
import { newReplies } from '../tools/lib/feedback.mjs'
import { mentionSummaryLines } from '../lib/mention-summary.js'
import { translateNamed } from '../tools/lib/cli-args.mjs'
const temp = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'whale-updates-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p }
test('issue 5: named positional arguments keep unrelated valued/boolean flags',()=>{
  assert.deepEqual(translateNamed('recon',['--bvid','BV1234567890','--ps','5','--json']),['BV1234567890','--ps','5','--json'])
  assert.deepEqual(translateNamed('search',['--page','2','--kw','猫','--json']),['猫','2','--json'])
  assert.deepEqual(translateNamed('recon',['BV1234567890','--ps','5']),['BV1234567890','--ps','5'])
})
test('issue 10: summary requires opt-in, owner mention and explicit request',()=>{
  const cfg={owner:{mid:'222'},listen:{mentionSummary:true}}
  const item={kind:'at',mid:'222',source:'请总结这个视频',uri:'https://www.bilibili.com/video/BV1234567890'}
  assert.equal(mentionSummaryLines({},[item]).length,0)
  assert.equal(mentionSummaryLines(cfg,[{...item,mid:'999'}]).length,0)
  assert.equal(mentionSummaryLines(cfg,[{...item,kind:'reply'}]).length,0)
  assert.equal(mentionSummaryLines(cfg,[{...item,source:'你好'}]).length,0)
  assert.equal(mentionSummaryLines(cfg,[{...item,source:'',title:'【年度总结】这是视频标题'}]).length,0,'收件箱的 title 不可靠：标题里有「总结」不算主人要总结')
  assert.doesNotMatch(mentionSummaryLines(cfg,[{...item,title:'【年度总结】这是视频标题'}]).join('\n'),/年度总结/,'交给她的也只有主人那条的正文')
  assert.match(mentionSummaryLines(cfg,[item]).join('\n'),/notify/)
})
test('issue 11/PR 13: configurable existing directory, invalid values fall back', t=>{
  const dir=temp(t), fallback=path.join(dir,'default'), file=path.join(dir,'file');fs.writeFileSync(file,'x')
  assert.equal(resolveWorkDir(dir,fallback),fs.realpathSync(dir))
  let warnings=0
  for(const v of ['relative',file,path.join(dir,'absent'),42,{}])assert.equal(resolveWorkDir(v,fallback,()=>warnings++),fallback)
  for(const v of ['',null,undefined])resolveWorkDir(v,fallback,()=>warnings++)
  assert.equal(warnings,5)
})
test('PR 12: resolve real node from PATH and verify execution', t=>{
  const dir=temp(t)
  const r=resolveRuntime(dir,{env:{PATH:path.dirname(process.execPath)},home:dir})
  assert.equal(r.file,process.execPath);assert.equal(probeRuntime(r.file,r.env),true)
})
test('PR 12: Electron fallback requires proof and node environment', t=>{
  const dir=temp(t), calls=[]
  const opts={home:dir,env:{PATH:''},platform:'linux',electron:true,execPath:'/mock/electron',probe:(p,e)=>{calls.push([p,e]);return e.ELECTRON_RUN_AS_NODE==='1'}}
  const r=resolveRuntime(dir,opts);assert.equal(r.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(calls.length,1)
  assert.throws(()=>resolveRuntime(dir,{...opts,probe:()=>false}),/node/)
})

test('PR 12: desktop-provided runtime is verified even without PATH', t=>{
 const dir=temp(t), calls=[]
 const r=resolveRuntime(dir,{home:dir,env:{PATH:'',DSH_DESKTOP_NODE_EXECUTABLE:process.execPath},probe:(p)=>{calls.push(p);return true}})
 assert.equal(r.file,process.execPath);assert.deepEqual(calls,[process.execPath])
})
test('PR 3: file capture preserves stdout, error status and stderr',()=>{
  assert.equal(execFileSync(process.execPath,['-e','process.stdout.write("hello")'],{encoding:'utf8'}),'hello')
  assert.throws(()=>execFileSync(process.execPath,['-e','process.stdout.write("out");process.stderr.write("err");process.exit(7)']),e=>e.status===7&&String(e.stdout)==='out'&&String(e.stderr)==='err')
})
test('minimum gap survives reconfiguration, done state and subsequent ticks',()=>{
  const now=new Date('2026-10-22T10:00:00').getTime()
  const cfg={windows:[{start:'10:00',end:'10:05',wakes:3}],skipChance:0,minGapMin:10}
  let state=completePlan(makePlan(cfg,{},now,()=>0),now)
  state=historyOf(state,now+60000)
  state=makePlan(cfg,state,now+60000,()=>0)
  assert.equal(state.action,'done')
  assert.equal(makePlan(cfg,state,now+120000,()=>0).action,'done')
  const longer={...cfg,windows:[{start:'10:00',end:'11:00',wakes:3}]}
  assert.ok(makePlan(longer,state,now+120000,()=>0).atMs>=now+600000)
})
test('invalid minimum gap cannot persist a NaN plan',()=>{
  const now=new Date('2026-10-22T10:00:00').getTime()
  const st=makePlan({windows:[{start:'10:00',end:'11:00',wakes:2}],minGapMin:'invalid'}, {},now,()=>0)
  assert.ok(Number.isFinite(st.atMs))
})
test('issue 17: early morning selects morning window, future windows never execute early',()=>{
  const cfg={windows:[{start:'18:00',end:'24:00',wakes:3},{start:'0:00',end:'8:00',wakes:3}]}
  const st=makePlan(cfg,{},new Date('2026-10-22T02:38:00').getTime(),()=>0)
  assert.equal(st.window,'0:00–8:00')
  const future=makePlan(cfg,{},new Date('2026-10-22T09:00:00').getTime(),()=>0)
  assert.ok(future.atMs>=future.startsAt)
})
test('issue 14: shrinking/reordered results and same-second replies are deduplicated',()=>{
  const now=Date.now(), time=new Date(now-3600000).toISOString()
  const a={id:'a',kind:'reply',time}, b={id:'b',kind:'reply',time}
  const first=newReplies([a,b],{},now), fb={replyIds:first.ids,lastReplyTime:first.time}
  assert.equal(newReplies([b],fb,now).fresh.length,0)
  assert.equal(newReplies([b,a],fb,now).fresh.length,0)
  assert.equal(newReplies([{...a,id:'c'}],fb,now).fresh.length,1)
  assert.equal(newReplies([{...a,id:'old',time:new Date(now-7200000).toISOString()}],fb,now).fresh.length,0)
})

test('wake prompt follows night.maxVideos instead of a hard-coded 5',()=>{
  const st={date:'2026-10-22',n:12}
  // 第 5 个参数给 null（= 给明天的信关着）：这个文件在跑测试的人自己的 HOME 里直接调 wakePrompt，不给的话会去读 ~/.bili-ai/letters.jsonl（2026-10-26 复查）
  for(const mv of [1,3,5]){
    const lines=wakePrompt(st,'',mv,undefined,null).split(/\r?\n/)
    const line=lines.find((l)=>l.includes('feed 选题'))
    assert.ok(line, '提示里应该有 feed 选题 这一行')
    assert.match(line,new RegExp('≤'+mv+' 条'),'maxVideos='+mv+' 时应显示 ≤'+mv+' 条，实际：'+line)
  }
  assert.match(wakePrompt(st,'',30,undefined,null).split(/\r?\n/).find((l)=>l.includes('feed 选题')),/≤30 条/)   // 以前最多 20
  // 2026-10-24 主人取消了上限：0 / 不是正数 = 不限，并提醒她一轮有时间上限
  for(const mv of [0,'','abc',-3]){
    const line=wakePrompt(st,'',mv,40,null).split(/\r?\n/).find((l)=>l.includes('feed 选题'))
    assert.match(line,/不限条数.*最多 40 分钟.*日记/,String(mv)); assert.doesNotMatch(line,/≤/)
  }
  // 没写（不传 / null）= 新装的默认 5 条
  for(const mv of [undefined,null]){
    const line=wakePrompt(st,'',mv,40,null).split(/\r?\n/).find((l)=>l.includes('feed 选题'))
    assert.match(line,/≤5 条/,String(mv))
  }
})

test('night.maxVideos: 0 means no limit, is kept as 0 by config set, and changing it does not re-roll tonight\'s wake plan',(t)=>{
  const home=temp(t), dsh=path.join(home,'data'); fs.mkdirSync(path.join(dsh,'whale-work'),{recursive:true}); fs.mkdirSync(path.join(home,'.bili-ai'))
  const cfgFile=path.join(dsh,'bili-whale.config.json')
  fs.writeFileSync(cfgFile,JSON.stringify({owner:{mid:'222',name:'Owner'},notify:{type:'none'},night:{windows:[{start:'20:00',end:'24:00',wakes:1}],maxVideos:5}}))
  const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:cfgFile}
  delete env.BILI_WHALE_AGENT
  const set=(v)=>execFileSync(process.execPath,[path.join(import.meta.dirname,'..','host','cli.mjs'),'config','set','night.maxVideos',v],{env,encoding:'utf8'})
  for(const [v,want] of [['0',0],['30',30],['abc',0],['-1',0]]){
    const out=set(v)
    assert.match(out,/已保存/,v); assert.doesNotMatch(out,/作息变了/,'改条数不该重排今天的计划：'+v)
    assert.equal(JSON.parse(fs.readFileSync(cfgFile,'utf8')).night.maxVideos,want,v)
  }
  // 宿主那边：config 文件变了，只有时间相关的几项会让计划重抽
  const daemon=fs.readFileSync(path.join(import.meta.dirname,'..','host','daemon.mjs'),'utf8')
  assert.match(daemon,/\['windows', 'skipChance', 'minGapMin'\]/); assert.doesNotMatch(daemon,/'maxVideos'/)
})
