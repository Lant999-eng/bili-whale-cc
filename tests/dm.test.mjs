// 主人私信：按消息序号增量取齐（连着发的几条都进上下文）、重复轮询不重复处理、崩溃不静默丢、首次启用不追发历史
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))

function sandbox(t,cfg={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-dm-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'data'); fs.mkdirSync(dsh,{recursive:true}); fs.mkdirSync(path.join(home,'.bili-ai'))
  const cfgFile=path.join(dsh,'bili-whale.config.json')
  fs.writeFileSync(cfgFile,JSON.stringify({owner:{mid:'222',name:'Owner'},self:{mid:'111',name:'Whale'},listen:{dm:true,comment:false,live:false},...cfg}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'test-cookie-not-a-real-account',bili_jct:'a'.repeat(32)}))
  const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:cfgFile,
    TEST_REQUESTS:path.join(home,'requests.jsonl'),TEST_DM_FILE:path.join(home,'dm.json'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/mock-fetch.mjs')).href}
  const s={env,home,cfgFile,state:path.join(home,'.bili-ai','dm-await-state.json'),msgs:[],others:[]}
  s.write=(extra={})=>fs.writeFileSync(env.TEST_DM_FILE,JSON.stringify({messages:s.msgs,others:s.others,...extra}))
  s.write()                                                      // 一开始：主人会话里还没有消息
  s.add=(seq,text,{from=222,type=1,status=0,ts=Math.floor(Date.now()/1000),content}={})=>{
    s.msgs.push({msg_seqno:seq,msg_key:'k'+seq,sender_uid:from,msg_type:type,msg_status:status,timestamp:ts,content:content??JSON.stringify({content:text})}); s.write()
  }
  s.run=(args,extra={})=>{const r=spawnSync(process.execPath,[path.join(root,'tools/commands/dm-await.mjs'),...args],{env:{...env,...extra},encoding:'utf8',timeout:20000});assert.ifError(r.error);return r}
  s.peek=(extra)=>{const r=s.run(['--once','--json','--peek'],extra);return {r,j:(()=>{try{return JSON.parse(r.stdout.trim().split('\n').pop())}catch{return null}})()}}
  s.st=()=>JSON.parse(fs.readFileSync(s.state,'utf8'))
  s.requests=()=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[]
  return s
}

test('dm: first run only sets the cursor (no history), then three messages sent in a row all arrive in order',t=>{
  const s=sandbox(t)
  s.add(1,'很久以前的话'); s.add(2,'也是以前的')
  let {r,j}=s.peek(); assert.equal(r.status,1,r.stdout+r.stderr); assert.equal(j.hit,false); assert.equal(j.baseline,'首次启用')
  assert.equal(s.st().cursor,2)
  s.add(3,'A'); s.add(4,'B'); s.add(5,'C')
  ;({r,j}=s.peek()); assert.equal(r.status,0,r.stderr)
  assert.deepEqual(j.messages.map(m=>m.text),['A','B','C']); assert.equal(j.text,'A\nB\nC'); assert.equal(j.cover,5)
  assert.ok(!j.messages.some(m=>/以前/.test(m.text)),'不追发历史')
})

test('dm: polling again before ack returns the same batch (same receipt) without re-reading; ack moves the cursor exactly to the batch',t=>{
  const s=sandbox(t)
  s.peek()                                                       // 建游标
  s.add(1,'A'); s.add(2,'B')
  const first=s.peek().j
  const before=s.requests().length
  s.add(3,'C')                                                   // 等待确认期间又来了一条
  const again=s.peek().j
  assert.equal(again.receipt,first.receipt); assert.deepEqual(again.messages.map(m=>m.text),['A','B'],'不重复处理，也不夹带新消息')
  assert.equal(s.requests().length,before,'待交付的一批原样再给，不再访问网络')
  assert.equal(s.run(['--ack','wrong-receipt']).status,2,'凭据不对不推进')
  assert.equal(s.run(['--ack',first.receipt]).status,0)
  assert.equal(s.st().cursor,2); assert.equal(s.st().pending,undefined)
  const next=s.peek().j; assert.deepEqual(next.messages.map(m=>m.text),['C'])
  s.run(['--ack',next.receipt]); assert.equal(s.peek().j.hit,false)
})

test('dm: a failure before the batch is saved changes nothing; a saved batch survives a restart until it is acknowledged',t=>{
  const s=sandbox(t)
  s.peek(); s.add(1,'A'); s.add(2,'B')
  const failed=s.peek({TEST_DM_FAIL:'1'}); assert.equal(failed.r.status,3)
  const st=s.st(); assert.equal(st.pending,undefined); assert.equal(st.cursor,0,'没取到就不推进')
  const got=s.peek().j; assert.deepEqual(got.messages.map(m=>m.text),['A','B'])
  // 「入队之后、确认之前」宿主崩了：新进程读到的还是同一批、同一张 receipt（宿主按 requestId 去重）
  const after=s.peek().j; assert.equal(after.receipt,got.receipt)
})

test('dm: only the owner\'s messages in the owner\'s session count; her own replies and other sessions are skipped; nothing is ever sent',t=>{
  const s=sandbox(t)
  s.others=[{talker_id:999,session_type:1,max_seqno:50,last_msg:{sender_uid:999,content:'{"content":"陌生人"}'}}]
  s.peek(); s.add(1,'在吗'); s.add(2,'嗯，在',{from:111}); s.add(3,'今天看了什么')
  const j=s.peek().j
  assert.deepEqual(j.messages.map(m=>m.text),['在吗','今天看了什么']); assert.equal(j.cover,3)
  s.run(['--ack',j.receipt])
  s.add(4,'我自己的回复',{from:111})                                 // 只有她自己的回复：游标往前推，不算命中
  assert.equal(s.peek().j.hit,false); assert.equal(s.st().cursor,4)
  const req=s.requests()
  assert.ok(req.every(x=>x.method==='GET'),'只读，不发')
  assert.ok(!req.some(x=>/send_msg/.test(x.url))); assert.ok(req.filter(x=>/fetch_session_msgs/.test(x.url)).every(x=>/talker_id=222/.test(x.url)),'只取主人的会话')
})

test('dm: more than one batch — the cursor never passes messages that were not delivered',t=>{
  const s=sandbox(t)
  s.peek()
  for(let i=1;i<=25;i++) s.add(i,'m'+i)
  const a=s.peek().j; assert.equal(a.messages.length,20); assert.equal(a.cover,20)
  s.run(['--ack',a.receipt]); assert.equal(s.st().cursor,20)
  const b=s.peek().j; assert.deepEqual(b.messages.map(m=>m.text),['m21','m22','m23','m24','m25'])
})

test('dm: switching her account or upgrading from the old single-message state re-baselines without sending history',t=>{
  const s=sandbox(t)
  s.peek(); s.add(1,'A'); const j=s.peek().j; s.run(['--ack',j.receipt])
  s.add(2,'换号之前的消息')
  const cfg=JSON.parse(fs.readFileSync(s.cfgFile,'utf8')); fs.writeFileSync(s.cfgFile,JSON.stringify({...cfg,self:{mid:'333',name:'Other'}}))
  assert.equal(s.peek().j.baseline,'换了号'); assert.equal(s.st().cursor,2)
  s.add(3,'换号之后'); assert.deepEqual(s.peek().j.messages.map(m=>m.text),['换号之后'])
  // 旧版状态（只认 last_msg 的 lastSeen / lastKey）：升级时游标建在最近一页之前，只交付比旧版位置新的（停机升级期间主人发的不丢）
  const now=Math.floor(Date.now()/1000)
  const t2=sandbox(t); t2.add(5,'旧版之前的历史',{ts:now-3600}); t2.add(6,'旧版已经交付过的',{ts:now-600}); t2.add(7,'升级停机时主人发的',{ts:now-60})
  fs.writeFileSync(t2.state,JSON.stringify({owner:'222',lastSeen:now-600,lastKey:'k6',at:'x'}))
  let up=t2.peek().j; assert.deepEqual(up.messages.map(m=>m.text),['升级停机时主人发的'],'不追发历史、不重发旧版交付过的、停机期间的不丢')
  t2.run(['--ack',up.receipt]); assert.equal(t2.st().cursor,7); assert.equal(t2.st().floorTs,undefined)
  // 什么新消息都没有的旧版状态：只建游标
  const t4=sandbox(t); t4.add(7,'旧版时期的消息')
  fs.writeFileSync(t4.state,JSON.stringify({owner:'222',lastSeen:123,lastKey:'k7',at:'x'}))
  assert.equal(t4.peek().j.baseline,'从旧版状态升级'); assert.equal(t4.st().cursor,7)
  // 旧版留下的一条待交付：没记是哪个号取的（旧版状态里也没有）—— 说不清，不交付、它的 receipt 不认、留记录（Astra 第七次审查之后）；
  //   比它新的照样交付（是现在这个号的会话里取的），比它早的不追发
  const t3=sandbox(t); t3.add(7,'待交付之前的',{ts:now-3600}); t3.add(9,'旧版那一条',{ts:now-600}); t3.add(10,'旧版待交付之后又来的',{ts:now})
  fs.writeFileSync(t3.state,JSON.stringify({owner:'222',lastSeen:1,pending:{hit:true,mid:'222',name:'Owner',text:'旧版那一条',ts:now-600,key:'k9',receipt:'r-old'}}))
  assert.equal(t3.run(['--ack','r-old']).status,2,'还没轮询过也不认旧版那一条的 receipt')
  // 作废的这一轮：先说出来就停（不往下取）
  let v=t3.peek(); assert.equal(v.r.status,1,v.r.stdout+v.r.stderr); assert.equal(v.j.hit,false); assert.deepEqual(v.j.dropped,{self:'',n:1,why:'unknown'})
  assert.match(fs.readFileSync(path.join(t3.home,'.bili-ai','dm-tick-err.log'),'utf8'),/旧版留下的 1 条你的私信.*记不清是哪个号收到的.*再发一次/)
  // 下一轮：比它新的照常交付；它自己（还在会话里）不再交付，比它早的不追发；也不再说一遍作废
  const after=t3.peek().j
  assert.deepEqual(after.messages.map(m=>m.text),['旧版待交付之后又来的']); assert.equal(after.dropped,undefined)
  assert.equal(t3.run(['--ack','r-old']).status,2,'旧版那一条的 receipt 不认')
  assert.equal(t3.run(['--ack',after.receipt]).status,0)
  assert.equal(t3.peek().j.dropped,undefined,'作废只说一次')
})

test('dm review 7: a v0.9-format state whose account was never recorded, holding a pending batch that has no account on it, is voided after an account switch — not delivered as the new account\'s',t=>{
  const s=sandbox(t,{self:{mid:'333'}})
  const T=Math.floor(Date.now()/1000)
  s.add(1,'以前的',{ts:T-3600}); s.add(2,'发给旧号111的私信',{ts:T-600})
  // 第 6 版写的：version 2、self 是空的（启用时还不知道是哪个号），待交付的那批没有 self
  fs.writeFileSync(s.state,JSON.stringify({version:2,owner:'222',self:'',cursor:1,seen:[],initializedAt:1,pending:{hit:true,mid:'222',name:'Owner',messages:[{key:'k2',seq:2,ts:T-600,type:1,text:'发给旧号111的私信'}],cover:2,text:'发给旧号111的私信',receipt:'r-v6'}}))
  s.add(3,'升级停机时发的',{ts:T-60})
  assert.equal(s.run(['--ack','r-v6']).status,2,'还没轮询过也不认')
  // 升级后第一次轮询取私信出错：不能趁机把现在这个号认成状态里的号（不然下一轮那批就被当成 333 的交付了）
  const fail=path.join(s.home,'dm-fail.flag'); fs.writeFileSync(fail,'1')
  assert.equal(s.peek({TEST_DM_SESSIONS_FAIL_FILE:fail}).r.status,3); assert.equal(s.st().self,''); assert.equal(s.st().pending.receipt,'r-v6')
  fs.rmSync(fail)
  const {r,j}=s.peek(); assert.equal(r.status,1,r.stdout+r.stderr)
  assert.equal(j.hit,false); assert.equal(j.baseline,'旧版待交付说不清是哪个号的'); assert.deepEqual(j.dropped,{self:'',n:1,why:'unknown'})
  assert.equal(s.st().pending,undefined); assert.equal(s.st().self,'333')
  assert.equal(s.run(['--ack','r-v6']).status,2)
  // 作废的那批之后来的（升级停机时发的）照样交付；作废的那条不再交付，更早的不追发
  s.add(4,'之后发给新号的',{ts:T})
  const n=s.peek().j; assert.deepEqual(n.messages.map(m=>m.text),['升级停机时发的','之后发给新号的']); assert.equal(n.self,'333'); assert.equal(n.dropped,undefined)
  // 记着是哪个号的（哪怕取的时候不知道 = 空串）：照原样再给，不拿现在这个号去补
  const s2=sandbox(t,{self:{mid:'333'}}); s2.add(1,'以前的'); s2.add(2,'取的时候不知道是哪个号')
  fs.writeFileSync(s2.state,JSON.stringify({version:2,owner:'222',self:'',cursor:1,seen:[],initializedAt:1,pending:{hit:true,mid:'222',name:'Owner',self:'',messages:[{key:'k2',seq:2,ts:Math.floor(Date.now()/1000),type:1,text:'取的时候不知道是哪个号'}],cover:2,text:'x',receipt:'r-unknown'}}))
  const again=s2.peek().j; assert.equal(again.receipt,'r-unknown'); assert.equal(again.self,'')
  // 取的时候不知道是哪个号（self 空串），之后状态认下了 111、现在又换成 333：作废，但不猜是 111 收到的
  const s3=sandbox(t,{self:{mid:'333'}}); s3.add(1,'以前的'); s3.add(2,'取的时候不知道是哪个号')
  fs.writeFileSync(s3.state,JSON.stringify({version:2,owner:'222',self:'111',cursor:1,seen:[],initializedAt:1,pending:{hit:true,mid:'222',name:'Owner',self:'',messages:[{key:'k2',seq:2,ts:Math.floor(Date.now()/1000),type:1,text:'取的时候不知道是哪个号'}],cover:2,text:'x',receipt:'r-u2'}}))
  const v3=s3.peek().j; assert.equal(v3.baseline,'换了号'); assert.deepEqual(v3.dropped,{self:'',n:1,why:'unknown'})
  assert.doesNotMatch(fs.readFileSync(path.join(s3.home,'.bili-ai','dm-tick-err.log'),'utf8'),/UID 111/)
})

test('dm: video shares, images and unknown types are described instead of dropped; recalled messages are skipped',t=>{
  const s=sandbox(t)
  s.peek()
  s.add(1,null,{type:7,content:JSON.stringify({bvid:'BV1234567890',title:'一个视频'})})
  s.add(2,null,{type:2,content:JSON.stringify({url:'https://i0.hdslb.com/x.png'})})
  s.add(3,'撤回了',{status:1}); s.add(4,null,{type:12,content:'{}'}); s.add(5,'好看吗')
  const j=s.peek().j
  assert.deepEqual(j.messages.map(m=>m.text),['[B站视频分享] 《一个视频》\nBV 号 BV1234567890\nhttps://www.bilibili.com/video/BV1234567890/','[图片]','[暂不支持显示的消息（类型 12）]','好看吗'])
})

test('dm: a shared video card arrives with its BV, title and UP even when the card only has an av id (the first fixture card); articles are not turned into videos',t=>{
  // tests/fixtures/dm-share-cards.json 的第一张：只有 av 号的卡片 —— 以前她拿到的是 av 链接，工具打不开，只好按标题搜
  const cards=JSON.parse(fs.readFileSync(path.join(root,'tests','fixtures','dm-share-cards.json'),'utf8')).cards
  const s=sandbox(t)
  s.peek()
  s.add(1,null,{type:7,content:JSON.stringify(cards[0].content)})
  s.add(2,null,{type:7,content:JSON.stringify(cards.find(c=>c.content.source===6).content)})
  s.add(3,null,{type:7,content:'不是 JSON'})
  s.add(4,'就这条，你看看')
  const {r,j}=s.peek(); assert.equal(r.status,0,r.stderr)
  assert.equal(j.messages[0].text,'[B站视频分享] 《示例视频》 · UP 主 某UP\nBV 号 BV17x411w7KC（av170001）\nhttps://www.bilibili.com/video/BV17x411w7KC/')
  assert.doesNotMatch(j.messages[0].text,/video\/av/)
  assert.match(j.messages[1].text,/^\[B站分享（不是视频，类型 6）\] 《一篇专栏》/); assert.doesNotMatch(j.messages[1].text,/BV/)
  assert.match(j.messages[2].text,/卡片内容读不出来/)
  assert.equal(j.messages[3].text,'就这条，你看看')
  // 换算不联网：除了取私信，没有别的请求
  assert.ok(s.requests().every(q=>/get_sessions|fetch_session_msgs/.test(q.url)),JSON.stringify(s.requests()))
})

test('dm: when the owner\'s session was not listed at baseline, only messages from after enabling are delivered',t=>{
  const s=sandbox(t)
  s.write({ownerMissing:true}); s.peek(); assert.equal(s.st().cursor,0)
  const old=Math.floor(Date.now()/1000)-3600
  s.add(1,'一小时前的旧消息',{ts:old}); s.add(2,'刚发的')
  assert.deepEqual(s.peek().j.messages.map(m=>m.text),['刚发的'])
})

test('host queue: a request id that already ran is not queued again (crash between enqueue and ack does not reprocess the batch)',t=>{
  const s=sandbox(t)
  const file=path.join(s.home,'q.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import path from 'node:path'
    import {ClaudeSessionController} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[]
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    await c.prompt({requestId:'bili-whale-dm-r1',self:'111',content:[{type:'text',text:'主人的三条'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    // 宿主重启：新的控制器，同一批私信（同一张 receipt）再投一次
    const c2=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    await c2.prompt({requestId:'bili-whale-dm-r1',self:'111',content:[{type:'text',text:'主人的三条'}]})
    await c2.prompt({requestId:'bili-whale-dm-r2',self:'111',content:[{type:'text',text:'下一批'}]})
    while(c2.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls,['主人的三条','下一批'])
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:30000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

// ─────────────── 对抗审查（第一轮）之后的回归测试 ───────────────
test('dm review: inside her session dm-await refuses every mode and changes nothing (only the host moves the owner\'s DM cursor)',t=>{
  const s=sandbox(t)
  s.peek(); s.add(1,'A')
  const before=fs.readFileSync(s.state,'utf8'), reqs=s.requests().length
  for(const args of [['--once'],['--once','--json','--peek'],['--baseline'],['--ack','x']]){
    const r=s.run(args,{BILI_WHALE_AGENT:'1'}); assert.equal(r.status,2,args.join(' ')); assert.match(r.stderr,/宿主/)
  }
  const viaShim=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'dm-await','--baseline'],{env:{...s.env,BILI_WHALE_AGENT:'1'},encoding:'utf8',timeout:20000})
  assert.equal(viaShim.status,2,viaShim.stdout+viaShim.stderr)
  assert.equal(fs.readFileSync(s.state,'utf8'),before); assert.equal(s.requests().length,reqs,'不访问网络')
  assert.deepEqual(s.peek().j.messages.map(m=>m.text),['A'],'宿主照样取得到')
})

test('dm review: a batch holds no more than the wake-up prompt shows; the rest waits for the next batch',t=>{
  const s=sandbox(t); s.peek()
  for(let i=1;i<=5;i++) s.add(i,`MARK${i} `+'字'.repeat(440))
  let j=s.peek().j; assert.deepEqual(j.messages.map(m=>m.text.slice(0,5)),['MARK1','MARK2','MARK3','MARK4']); assert.equal(j.cover,4)
  s.run(['--ack',j.receipt]); j=s.peek().j; assert.deepEqual(j.messages.map(m=>m.text.slice(0,5)),['MARK5'])
  s.run(['--ack',j.receipt]); s.add(6,'长'.repeat(3000)); j=s.peek().j; assert.equal(j.messages.length,1,'一条超长的照样单独交付')
})

test('dm review: a withdraw notice (type 5) is not a new message',t=>{
  const s=sandbox(t); s.peek()
  s.add(1,'说错了'); s.add(2,null,{type:5,content:'k1'}); s.add(3,'重说一遍')
  const j=s.peek().j; assert.deepEqual(j.messages.map(m=>m.text),['说错了','重说一遍'])
  s.run(['--ack',j.receipt]); s.add(4,null,{type:5,content:'k3'})
  assert.equal(s.peek().j.hit,false); assert.equal(s.st().cursor,4)
})

test('dm review: if the server returns the newest page, older owner messages are paged in instead of skipped; a gap that cannot be filled is reported',t=>{
  const s=sandbox(t); s.peek()
  for(let i=1;i<=60;i++) s.add(i,'m'+i)
  const got=[]
  for(let k=0;k<6;k++){ const j=s.peek({TEST_DM_NEWEST:'1'}).j; if(!j?.hit) break; assert.equal(j.gap,false); got.push(...j.messages.map(m=>m.text)); s.run(['--ack',j.receipt]) }
  assert.deepEqual(got,Array.from({length:60},(_,i)=>'m'+(i+1)),'按顺序、一条不少')
  const s2=sandbox(t); s2.peek(); for(let i=1;i<=60;i++) s2.add(i,'n'+i)
  const j2=s2.peek({TEST_DM_NEWEST:'1',TEST_DM_NO_END:'1'}).j; assert.equal(j2.hit,true); assert.equal(j2.gap,true,'接口不认 end_seqno：说出来，不悄悄跳过')
})

test('dm review: an unreadable state file has its own exit code (4), not "no new messages"',t=>{
  const s=sandbox(t); fs.writeFileSync(s.state,'{坏'); assert.equal(s.run(['--once','--json','--peek']).status,4)
})

test('dm review: the real scheduler shows every message it acks, logs real failures, tells the owner when they persist, and recovers',t=>{
  const s=sandbox(t)
  const r=spawnSync(process.execPath,[path.join(root,'tests/helpers/dm-scheduler.mjs')],{env:s.env,encoding:'utf8',timeout:120000})
  assert.ifError(r.error); assert.equal(r.status,0,r.stdout+r.stderr)
})

test('host queue review: a DM turn cut off by a crash runs once more; a second cut-off, an owner stop or a timeout drops it (and says so)',t=>{
  const s=sandbox(t)
  const file=path.join(s.home,'o.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController,RUNNING_FILE} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[], logs=[]
    const mk=()=>new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:(m)=>logs.push(m),runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    const qf=path.join(path.dirname(RUNNING_FILE),'queue.json')
    // 上一个宿主留下的回合：队列里还在、running.json 的进程已经不在了
    const orphan=(id,text,{item={},run={}}={})=>{
      fs.mkdirSync(path.dirname(RUNNING_FILE),{recursive:true})
      fs.writeFileSync(qf,JSON.stringify([{id,text,at:new Date().toISOString(),self:'111',...item}]))   // 新版排进来的都带着是哪个号收到的
      fs.writeFileSync(RUNNING_FILE,JSON.stringify({pid:999999,id,at:new Date().toISOString(),sessionId:'x',...run}))
    }
    const settle=async(c)=>{ c.kick(); while(c.isBusy()) await new Promise(r=>setTimeout(r,10)) }
    orphan('bili-whale-dm-a','主人的私信 A'); await settle(mk())
    assert.deepEqual(calls,['主人的私信 A'],'宿主崩了：私信回合再跑一次')
    orphan('bili-whale-dm-b','主人的私信 B',{item:{orphanRetry:1}}); await settle(mk())
    orphan('bili-whale-dm-c','主人的私信 C',{run:{stoppedByOwner:true}}); await settle(mk())
    orphan('bili-whale-listen-d','评论区那一轮'); await settle(mk())
    assert.deepEqual(calls,['主人的私信 A'],'重跑过一次的、主人停掉的、不是私信的：都不重跑')
    assert.ok(logs.some(l=>/bili-whale-dm-b.*不再重跑/.test(l))&&logs.some(l=>/bili-whale-dm-c.*主人停掉了宿主/.test(l)),logs.join(' | '))
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:60000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

// ─────────────── 对抗审查（第二轮）之后的回归测试 ───────────────
test('dm review 2: with the cursor starting at 0, history is held back across every page, not just the first',t=>{
  const s=sandbox(t)
  s.write({ownerMissing:true}); s.peek(); assert.equal(s.st().cursor,0); assert.ok(s.st().floorTs>0)
  const old=Math.floor(Date.now()/1000)-86400
  for(let i=1;i<=300;i++) s.add(i,'HISTORY'+i,{ts:old})                // 一次翻不完（最多 5 页 = 250 条）
  s.add(301,'NEW')
  const got=[]
  for(let k=0;k<5;k++){ const {j}=s.peek(); if(j?.hit){ got.push(...j.messages.map(m=>m.text)); s.run(['--ack',j.receipt]) } }
  assert.deepEqual(got,['NEW'],'一条历史都不追发')
})

test('dm review 2: "more coming" is said exactly when owner messages are still waiting',t=>{
  const s=sandbox(t); s.peek()
  for(let i=1;i<=22;i++) s.add(i,'part'+i)
  let j=s.peek().j; assert.equal(j.messages.length,20); assert.equal(j.truncated,true,'装满了：后面还有')
  s.run(['--ack',j.receipt]); j=s.peek().j; assert.deepEqual(j.messages.map(m=>m.text),['part21','part22']); assert.equal(j.truncated,false)
  const s2=sandbox(t); s2.peek()
  for(let i=1;i<=55;i++) s2.add(i,i%11===0?'owner'+i:'her'+i,{from:i%11===0?222:111})
  const n=s2.peek({TEST_DM_NEWEST:'1'}).j; assert.equal(n.messages.length,5); assert.equal(n.truncated,false,'往回翻全了：后面没有了')
})

test('dm review 2: an owner DM withdrawn after it was delivered is removed from her memory',t=>{
  const s=sandbox(t); s.peek()
  s.add(1,'我的新地址是某某路某某号'); s.add(2,'记一下')
  const j=s.peek().j; assert.equal(s.run(['--ack',j.receipt]).status,0)
  const mem=path.join(s.home,'.bili-ai','memory','222.json')
  assert.match(fs.readFileSync(mem,'utf8'),/某某路/)
  s.msgs[0].msg_status=1; s.add(3,null,{type:5,content:'k1'}); s.write()
  assert.equal(s.peek().j.hit,false)
  assert.doesNotMatch(fs.readFileSync(mem,'utf8'),/某某路/); assert.match(fs.readFileSync(mem,'utf8'),/记一下/)
})

test('dm review 2: unreadable credentials exit 2 with a clear message, not 1 ("no new DM")',t=>{
  const s=sandbox(t); s.peek()
  fs.writeFileSync(path.join(s.home,'.bili-ai','credentials.json'),'{坏')
  const r=s.run(['--once','--json','--peek']); assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stderr,/凭据/)
})

test('host queue review 2: a leftover turn the new host watched finish is not re-run; a failed DM turn is reported',async t=>{
  const s=sandbox(t)
  const file=path.join(s.home,'o2.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {spawn} from 'node:child_process'
    import {ClaudeSessionController,RUNNING_FILE} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[], logs=[]
    const mk=(ok=true)=>new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:(m)=>logs.push(m),runner:async({text,sess})=>{calls.push(text);return ok?{ok:true,sessionId:sess.id}:{ok:false,raw:'usage limit reached'}}})
    const qf=path.join(path.dirname(RUNNING_FILE),'queue.json')
    fs.mkdirSync(path.dirname(RUNNING_FILE),{recursive:true})
    // 上一个宿主留下的私信回合，进程还在跑（命令行里带着会话 id）：新宿主等它；它正常跑完了 → 不重跑
    const sid='0123abcd-0000-4000-8000-00000000beef'
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},120000)',sid],{stdio:'ignore'})
    fs.writeFileSync(qf,JSON.stringify([{id:'bili-whale-dm-live',self:'111',text:'主人的私信 L',at:new Date().toISOString()}]))
    fs.writeFileSync(RUNNING_FILE,JSON.stringify({pid:child.pid,id:'bili-whale-dm-live',at:new Date().toISOString(),sessionId:sid}))
    const c=mk()
    c.kick(); assert.deepEqual(calls,[],'还在跑：等它（宿主每 5 秒 kick 一次，会看到它还活着）')
    const gone=new Promise(r=>child.on('exit',r)); child.kill(); await gone          // 看到它在跑之后才让它结束（不靠计时，慢机器上也稳）
    c.kick(); while(c.isBusy()) await new Promise(r=>setTimeout(r,20))
    assert.deepEqual(calls,[],'看着它跑完的，不重跑')
    assert.ok(logs.some(l=>/跑完了/.test(l)),logs.join(' | '))
    // 私信回合失败（比如额度用完）：单独报主人，不和普通失败共用节流
    const f=mk(false)
    await f.prompt({requestId:'bili-whale-dm-fail',self:'111',content:[{type:'text',text:'主人的私信 F'}]})
    while(f.isBusy()) await new Promise(r=>setTimeout(r,20))
    assert.ok(logs.some(l=>/bili-whale-dm-fail.*没处理成.*usage limit/.test(l)),logs.join(' | '))
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:90000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

test('host queue review 2: a dead recorded pid does not count as finished while another process of the same session is still running',t=>{
  const s=sandbox(t)
  const file=path.join(s.home,'o3.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {spawn} from 'node:child_process'
    import {ClaudeSessionController,RUNNING_FILE} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[]
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:()=>{},runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    const qf=path.join(path.dirname(RUNNING_FILE),'queue.json')
    fs.mkdirSync(path.dirname(RUNNING_FILE),{recursive:true})
    const sid='0123abcd-0000-4000-8000-00000000cafe'
    // 记下的是已经不在的 cmd.exe（pid 999999），真正的 claude（命令行带着会话 id）还在跑
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},8000)','--','--resume',sid,'--output-format','json'],{stdio:'ignore'})
    fs.writeFileSync(qf,JSON.stringify([{id:'bili-whale-dm-x',self:'111',text:'主人的私信 X',at:new Date().toISOString()}]))
    fs.writeFileSync(RUNNING_FILE,JSON.stringify({pid:999999,id:'bili-whale-dm-x',at:new Date().toISOString(),sessionId:sid}))
    assert.equal(c.isBusy(),true); c.kick(); assert.deepEqual(calls,[],'同一会话还有进程在跑：不另起一个回合')
    child.kill()
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:90000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

// ─────────────── 对抗审查（第三轮）之后的回归测试 ───────────────
test('dm review 3: real 19-digit msg_keys stay exact — two close messages are both delivered, and a withdraw removes exactly the right one',t=>{
  const s=sandbox(t); s.peek()
  const raw=(seq,key,text,extra={})=>{ s.msgs.push({msg_seqno:seq,msg_key:key,sender_uid:222,msg_type:1,msg_status:0,timestamp:Math.floor(Date.now()/1000),content:JSON.stringify({content:text}),...extra}); s.write() }
  // 这两个编号当成 JS 数字会变成同一个值（…13000 附近），以前第二条会被当成「见过了」
  raw(1,'7065346163917013251','我的新地址是某某路某某号'); raw(2,'7065346163917013252','顺便提醒我周五交稿')
  const j=s.peek().j
  assert.deepEqual(j.messages.map(m=>m.key),['7065346163917013251','7065346163917013252'],'编号一位不差')
  assert.equal(s.run(['--ack',j.receipt]).status,0)
  const mem=path.join(s.home,'.bili-ai','memory','222.json')
  assert.match(fs.readFileSync(mem,'utf8'),/某某路/); assert.match(fs.readFileSync(mem,'utf8'),/7065346163917013251/)
  raw(3,'7065346163917099999',null,{msg_type:5,content:'7065346163917013251'})     // 撤回通知：内容是被撤回那条的编号（原样的字符串）
  assert.equal(s.peek().j.hit,false)
  const after=fs.readFileSync(mem,'utf8')
  assert.doesNotMatch(after,/某某路/,'撤回的那条删掉了'); assert.match(after,/周五交稿/,'挨着的那条还在')
})

test('dm review 3: "wait for the next batch" is only said when owner messages really wait; her own messages piling up after them do not count',t=>{
  const s=sandbox(t); s.peek()
  s.add(1,'今晚几点开会？')
  for(let i=2;i<=60;i++) s.add(i,'她的报备'+i,{from:111})
  let j=s.peek().j
  assert.deepEqual(j.messages.map(m=>m.text),['今晚几点开会？']); assert.equal(j.truncated,false); assert.equal(j.maybeMore,false)
  s.run(['--ack',j.receipt]); assert.equal(s.st().cursor,60); assert.equal(s.peek().j.hit,false)
  // 积压特别多、翻了几页还没到头：说「可能还有」，但不叫她别回
  const s2=sandbox(t); s2.peek()
  s2.add(1,'在吗')
  for(let i=2;i<=400;i++) s2.add(i,'她的报备'+i,{from:111})
  j=s2.peek().j; assert.deepEqual(j.messages.map(m=>m.text),['在吗']); assert.equal(j.truncated,false); assert.equal(j.maybeMore,true)
})

test('host review 3: cli stop also ends a claude that outlived its cmd.exe (same session id), and marks the turn as stopped by the owner',t=>{
  const s=sandbox(t)
  const sid=crypto.randomUUID()   // 每次不同：会话 id 是按全机进程扫描的，两份测试同时跑时固定的 id 会互相认错 / 互相结束进程
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)','--','--resume',sid,'--output-format','json'],{stdio:'ignore'})
  t.after(()=>{ try{ child.kill() }catch{} })
  const hostDir=path.join(s.env.DSH_HOME,'whale-cc')
  fs.mkdirSync(hostDir,{recursive:true})
  fs.writeFileSync(path.join(hostDir,'running.json'),JSON.stringify({pid:999999,id:'bili-whale-dm-z',at:new Date().toISOString(),sessionId:sid}))
  // cli open 等的就是 liveTurn()：同一会话的进程还在，就算有回合在跑
  const lt=spawnSync(process.execPath,['--input-type=module','-e',`import {liveTurn} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)};console.log(JSON.stringify(liveTurn()))`],{env:s.env,encoding:'utf8',timeout:90000})
  assert.deepEqual(JSON.parse(lt.stdout.trim().split('\n').pop()).pids,[child.pid],lt.stderr)
  const r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'stop'],{env:s.env,encoding:'utf8',timeout:90000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/已结束，不会重跑/)
  const dead=spawnSync(process.execPath,['-e',`try{process.kill(${child.pid},0);process.exit(1)}catch{process.exit(0)}`]).status===0
  assert.ok(dead,'同一会话的那个进程被结束了')
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostDir,'running.json'),'utf8')).stoppedByOwner,true)
})

// ─────────────── 对抗审查（第四轮）之后的回归测试 ───────────────
test('dm review 4: an unfillable gap is reported even when the newest part holds no owner message',t=>{
  const s=sandbox(t); s.peek(); s.add(1,'旧的'); const j0=s.peek().j; s.run(['--ack',j0.receipt])
  s.add(2,'今晚8点开会别忘了')
  for(let i=3;i<=62;i++) s.add(i,'她的报备'+i,{from:111})
  const j=s.peek({TEST_DM_NEWEST:'1',TEST_DM_NO_END:'1'}).j
  assert.equal(j.hit,false); assert.equal(j.gap,true,'说出来：中间那段可能有主人的私信')
})

test('dm review 4: upgrading from the old state does not re-deliver the message the old version delivered (its stored key was rounded)',t=>{
  const s=sandbox(t)
  const T=Math.floor(Date.now()/1000)-300
  s.msgs.push({msg_seqno:5,msg_key:'7065346163917013251',sender_uid:222,msg_type:1,msg_status:0,timestamp:T,content:JSON.stringify({content:'旧版已经交付过的'})})
  s.msgs.push({msg_seqno:6,msg_key:'7065346163917099999',sender_uid:222,msg_type:1,msg_status:0,timestamp:T+60,content:JSON.stringify({content:'升级期间发的'})})
  s.write()
  fs.writeFileSync(s.state,JSON.stringify({owner:'222',lastSeen:T,lastKey:String(Number('7065346163917013251'))}))   // 旧版按数字解析：近似值
  const j=s.peek().j
  assert.deepEqual(j.messages.map(m=>m.text),['升级期间发的'])
})

test('host review 4: cli stop leaves alone an old record\'s session processes and the owner\'s own interactive chat',t=>{
  const s=sandbox(t)
  const hostDir=path.join(s.env.DSH_HOME,'whale-cc'); fs.mkdirSync(hostDir,{recursive:true})
  const sid=crypto.randomUUID()   // 同上
  const kids=[]
  t.after(()=>{ for(const k of kids){ try{ k.kill() }catch{} } })
  const alive=(pid)=>spawnSync(process.execPath,['-e',`try{process.kill(${pid},0);process.exit(0)}catch{process.exit(1)}`]).status===0
  // ① 两天前留下的记录 + 一个同会话的无头进程：太旧了，不认
  const a=spawn(process.execPath,['-e','setTimeout(()=>{},60000)','--','--resume',sid,'--output-format','json'],{stdio:'ignore'}); kids.push(a)
  fs.writeFileSync(path.join(hostDir,'running.json'),JSON.stringify({pid:999999,id:'bili-whale-dm-old',at:new Date(Date.now()-2*86400000).toISOString(),sessionId:sid}))
  let r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'stop'],{env:s.env,encoding:'utf8',timeout:90000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.ok(alive(a.pid),'太旧的记录不动别的进程')
  // ② 新的记录，但同会话的只有主人自己 cli open 的交互式 claude（没有 --output-format）：不动
  const b=spawn(process.execPath,['-e','setTimeout(()=>{},60000)','--','--resume',sid],{stdio:'ignore'}); kids.push(b)
  a.kill()
  fs.writeFileSync(path.join(hostDir,'running.json'),JSON.stringify({pid:999999,id:'bili-whale-dm-new',at:new Date().toISOString(),sessionId:sid}))
  r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'stop'],{env:s.env,encoding:'utf8',timeout:90000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.ok(alive(b.pid),'主人当面聊的那个不动')
})

// ─────────────── Astra 审查：换号 ───────────────
test('dm review 5: after an account switch the old account\'s unacked batch is not redelivered, its receipt is refused, the drop is logged, and the new account starts from a fresh baseline',t=>{
  const s=sandbox(t)
  s.peek(); s.add(1,'旧号收到的A'); s.add(2,'旧号收到的B')
  const old=s.peek().j; assert.equal(old.self,'111'); assert.ok(old.receipt)
  const cfg=JSON.parse(fs.readFileSync(s.cfgFile,'utf8')); fs.writeFileSync(s.cfgFile,JSON.stringify({...cfg,self:{mid:'333',name:'Other'}}))
  const refused=s.run(['--ack',old.receipt]); assert.equal(refused.status,2,refused.stdout+refused.stderr); assert.match(refused.stderr,/换号/)
  assert.equal(s.st().pending.receipt,old.receipt,'确认被拒：什么都没推进')
  s.add(3,'新号这边以前的消息')
  const {r,j}=s.peek(); assert.equal(r.status,1,r.stdout+r.stderr)
  assert.equal(j.hit,false); assert.equal(j.baseline,'换了号'); assert.deepEqual(j.dropped,{self:'111',n:2})
  const st=s.st(); assert.equal(st.pending,undefined); assert.equal(st.self,'333'); assert.equal(st.cursor,3,'新号重新建游标，不追发历史')
  const err=fs.readFileSync(path.join(s.home,'.bili-ai','dm-tick-err.log'),'utf8')
  assert.match(err,/换号了.*旧号（UID 111）.*2 条/,'作废了也留个记录（面板「最近的错误」读这个文件）')
  assert.equal(s.run(['--ack',old.receipt]).status,2,'旧 receipt 再也确认不了')
  s.add(4,'换号之后发的')
  const next=s.peek().j; assert.deepEqual(next.messages.map(m=>m.text),['换号之后发的']); assert.equal(next.self,'333'); assert.notEqual(next.receipt,old.receipt)
  assert.equal(s.run(['--ack',next.receipt]).status,0)
  // 没换号：同一批照样原样再给（同一张 receipt），记着是哪个号取的
  s.add(5,'E'); const a=s.peek().j, b=s.peek().j; assert.equal(a.receipt,b.receipt); assert.equal(b.self,'333')
})

test('dm review 5: the account comes from the saved login first, so a switch is noticed even before the config\'s self.mid is updated',t=>{
  const s=sandbox(t)
  const cred=path.join(s.home,'.bili-ai','credentials.json'), c=JSON.parse(fs.readFileSync(cred,'utf8'))
  fs.writeFileSync(cred,JSON.stringify({...c,dedeuserid:'111'}))
  s.peek(); s.add(1,'A'); const old=s.peek().j; assert.equal(old.self,'111')
  fs.writeFileSync(cred,JSON.stringify({...c,dedeuserid:'333'}))                  // 新号的凭据存好了，配置里的 self 还是旧号
  assert.equal(s.run(['--ack',old.receipt]).status,2)
  const j=s.peek().j; assert.equal(j.hit,false); assert.equal(j.baseline,'换了号'); assert.deepEqual(j.dropped,{self:'111',n:1})
  assert.equal(s.st().self,'333')
})

test('dm review 5: a cursor set up while her account was unknown takes on her account at the next quiet poll, so a later switch is still noticed',t=>{
  const s=sandbox(t,{self:{mid:''}})
  s.add(1,'以前的')
  assert.equal(s.peek().j.baseline,'首次启用'); assert.ok(!s.st().self,'那会儿还不知道是哪个号')
  const cfg=JSON.parse(fs.readFileSync(s.cfgFile,'utf8')); fs.writeFileSync(s.cfgFile,JSON.stringify({...cfg,self:{mid:'111'}}))
  assert.equal(s.peek().r.status,1); assert.equal(s.st().self,'111','没新私信的轮询也要把认下的号存下来')
  fs.writeFileSync(s.cfgFile,JSON.stringify({...cfg,self:{mid:'333'}}))
  s.add(2,'新号这边以前的消息',{ts:Math.floor(Date.now()/1000)-7*86400})
  const {r,j}=s.peek(); assert.equal(r.status,1,r.stdout+r.stderr); assert.equal(j.hit,false); assert.equal(j.baseline,'换了号','换号认得出来：不追发新号这边的历史')
})

test('host queue review 5: the host checks the account the same way dm-await does (saved login first, then config)',t=>{
  const s=sandbox(t)
  const cred=path.join(s.home,'.bili-ai','credentials.json'), c=JSON.parse(fs.readFileSync(cred,'utf8'))
  fs.writeFileSync(cred,JSON.stringify({...c,dedeuserid:'333'}))                     // 新号的凭据存好了，配置里还是 111（改配置那一步还没做 / 没做成）
  const file=path.join(s.home,'sw2.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import path from 'node:path'
    import {ClaudeSessionController} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[]
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:()=>{},runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    await c.prompt({requestId:'bili-whale-dm-a',self:'111',content:[{type:'text',text:'旧号收到的'}]})
    await c.prompt({requestId:'bili-whale-dm-b',self:'333',content:[{type:'text',text:'新号收到的'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls,['新号收到的'],'按凭据里的号核对：配置还没跟上时，新号收到的照跑，旧号收到的不跑')
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:60000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

test('host queue review 7: a DM turn queued by the previous version (no account on it) is not run after an upgrade + account switch — dropped with a record and the owner told; old non-DM turns and new DM turns whose account was unknown still run',t=>{
  const s=sandbox(t)
  const hostDir=path.join(s.env.DSH_HOME,'whale-cc'); fs.mkdirSync(hostDir,{recursive:true})
  const at=new Date().toISOString()
  // 第 6 版的队列格式：只有 id / text / at
  fs.writeFileSync(path.join(hostDir,'queue.json'),JSON.stringify([{id:'bili-whale-dm-legacy',text:'旧版排进来的私信',at},{id:'bili-whale-7',text:'旧版排进来的普通一轮',at}]))
  const cfg=JSON.parse(fs.readFileSync(s.cfgFile,'utf8')); fs.writeFileSync(s.cfgFile,JSON.stringify({...cfg,self:{mid:'333'},notify:{type:'dm'}}))   // 升级前后换了号（111 → 333）；推送走 B站私信
  const file=path.join(s.home,'legacy.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[], logs=[]
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:(m)=>logs.push(m),runner:async({text,sess})=>{calls.push(text);return {ok:true,sessionId:sess.id}}})
    c.kick()
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    await c.prompt({requestId:'bili-whale-dm-unknown',self:'',content:[{type:'text',text:'取的时候不知道是哪个号'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls,['旧版排进来的普通一轮','取的时候不知道是哪个号'],'旧版的私信回合不交给现在这个号；别的照跑')
    assert.ok(logs.some(l=>/bili-whale-dm-legacy.*没处理成.*旧版排进来.*没记是哪个号/.test(l)),logs.join(' | '))
    const day=new Date().toLocaleDateString('sv-SE')
    const rec=fs.readFileSync(path.join(process.env.DSH_HOME,'whale-cc','logs',day+'.jsonl'),'utf8').trim().split('\\n').map(l=>JSON.parse(l)).find(l=>l.id==='bili-whale-dm-legacy')
    assert.equal(rec?.ok,false); assert.match(rec.result,/旧版/)
    assert.equal(c.queue.length,0)
    await c.prompt({requestId:'bili-whale-dm-legacy',self:'333',content:[{type:'text',text:'旧版排进来的私信'}]})
    assert.equal(c.queue.length,0,'作废过的那批再投一次也不再入队')
    // 告诉了主人：推送（B站私信）是另起的进程，等它发出去
    const sends=()=>{try{return fs.readFileSync(process.env.TEST_REQUESTS,'utf8').split('\\n').filter(l=>/send_msg/.test(l)).length}catch{return 0}}
    for(let i=0;i<300&&sends()<1;i++) await new Promise(r=>setTimeout(r,100))
    assert.equal(sends(),1,'作废的那一批：推送告诉主人要紧的再发一次（别的回合不推）')
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:60000}); assert.equal(r.status,0,r.stderr+r.stdout)
})

test('host queue review 5: a queued DM turn remembers which account received it and is skipped (with a log line and a turn record) if she switched accounts before it ran',t=>{
  const s=sandbox(t)
  const file=path.join(s.home,'sw.mjs')
  fs.writeFileSync(file,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController} from ${JSON.stringify(pathToFileURL(path.join(root,'host/claude.mjs')).href)}
    const calls=[], logs=[]
    let release; const gate=new Promise(r=>{ release=r })
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),log:(m)=>logs.push(m),runner:async({text,sess})=>{calls.push(text);if(text==='先跑的一轮') await gate;return {ok:true,sessionId:sess.id}}})
    await c.prompt({requestId:'bili-whale-1',content:[{type:'text',text:'先跑的一轮'}]})
    await c.prompt({requestId:'bili-whale-dm-old',self:'111',content:[{type:'text',text:'旧号收到的私信'}]})
    const cfgFile=process.env.BILI_WHALE_CONFIG
    fs.writeFileSync(cfgFile,JSON.stringify({...JSON.parse(fs.readFileSync(cfgFile,'utf8')),self:{mid:'333'}}))   // 排队期间换了号
    await c.prompt({requestId:'bili-whale-dm-new',self:'333',content:[{type:'text',text:'新号收到的私信'}]})
    await c.prompt({requestId:'bili-whale-2',content:[{type:'text',text:'不是私信的一轮'}]})
    release()
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls,['先跑的一轮','新号收到的私信','不是私信的一轮'],'旧号收到的那批不交给新号')
    assert.ok(logs.some(l=>/bili-whale-dm-old.*换号.*111.*333/.test(l)),logs.join(' | '))
    const day=new Date().toLocaleDateString('sv-SE')
    const rec=fs.readFileSync(path.join(process.env.DSH_HOME,'whale-cc','logs',day+'.jsonl'),'utf8').trim().split('\\n').map(l=>JSON.parse(l)).find(l=>l.id==='bili-whale-dm-old')
    assert.equal(rec?.ok,false); assert.match(rec.result,/换号/)
    await c.prompt({requestId:'bili-whale-dm-old',self:'111',content:[{type:'text',text:'旧号收到的私信'}]})
    assert.equal(c.queue.length,0,'同一批再投一次也不再入队')
  `)
  const r=spawnSync(process.execPath,[file],{env:s.env,encoding:'utf8',timeout:60000}); assert.equal(r.status,0,r.stderr+r.stdout)
})
