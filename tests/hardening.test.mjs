// 对抗审查（2026-10-22，30 条确认问题）的回归测试：每条修复至少一个用例
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync, spawn} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const href=(p)=>pathToFileURL(path.join(root,p)).href

const CHANNEL='# 频道设定\n## 和已有的 AI UP 主有什么不同\n我只讲自己每天真实遇到的事，不做比赛和测评。\n'
const sha=(f)=>{try{return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}catch{return null}}

/** 和 studio.test.mjs 一样的沙盒；fakePy = 把 node 链成 venv 的 python.exe，studio.py 由 helpers/fake-studio-py.mjs 冒充 */
function sandbox(t,{studio={},quota,self={mid:'333',name:'Whale'},fakePy=false}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-hard-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'data')
  fs.mkdirSync(path.join(dsh,'whale-work'),{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({owner:{mid:'222',name:'Owner'},self,notify:{type:'none'},studio,...(quota?{quota}:{})}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'test-cookie-not-a-real-account',bili_jct:'a'.repeat(32),buvid3:'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXinfoc'}))
  const venv=path.join(home,'venv')
  const py=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python')
  fs.mkdirSync(path.dirname(py),{recursive:true})
  const env={...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),BILI_WHALE_STUDIO_VENV:venv,BILI_WHALE_ORIGINALITY_OFFLINE:'1'}
  if(fakePy){
    try{fs.linkSync(process.execPath,py)}catch{fs.copyFileSync(process.execPath,py)}
    if(process.platform!=='win32')fs.chmodSync(py,0o755)
    env.NODE_OPTIONS='--import='+href('tests/helpers/fake-studio-py.mjs')
  } else fs.writeFileSync(py,'')
  fs.writeFileSync(path.join(dsh,'whale-work','channel.md'),CHANNEL)
  fs.writeFileSync(path.join(home,'.bili-ai/channel-approved.json'),JSON.stringify({sha:crypto.createHash('sha256').update(CHANNEL).digest('hex'),at:'t'}))
  const agent={...env,BILI_WHALE_AGENT:'1',BILI_WHALE_AI_HOME:path.join(dsh,'whale-work')}
  return {env,agent,dsh,home,work:path.join(dsh,'whale-work')}
}
const studio=(s,args,env=s.env)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio',...args],{env,encoding:'utf8',timeout:30000})
const projDir=(s,id)=>path.join(s.work,'studio',id)
const readJ=(f)=>JSON.parse(fs.readFileSync(f,'utf8'))
const queue=(s)=>{try{return readJ(path.join(s.home,'.bili-ai/pending-videos.json')).items.map(x=>x.id)}catch{return []}}
const REASON='这是一条很有意思的视频'

let titleN=0
function newProject(s,{title='测试作品'+(++titleN),series,tid=201,text}={}) {
  const r=studio(s,['new','--title',title,...(series!==undefined?['--series',series]:[])])
  assert.equal(r.status,0,r.stderr)
  const id=r.stdout.match(/新作品 (\S+)/)[1]
  const f=path.join(projDir(s,id),'script.json')
  const sc=readJ(f); sc.tid=tid; if(text) sc.scenes=[{bg_prompt:'x',lines:[{text}]}]
  fs.writeFileSync(f,JSON.stringify(sc))
  return id
}
/** 不跑 Python：直接造成片 + 回执（和 studio.test.mjs 的 fakeRendered 一样） */
function fakeRendered(s,opts={}) {
  const id=newProject(s,opts)
  const dir=projDir(s,id)
  fs.writeFileSync(path.join(dir,'final.mp4'),'x'+id); fs.writeFileSync(path.join(dir,'cover.jpg'),'c'+id)
  const sc=readJ(path.join(dir,'script.json'))
  const title=sc.series?`【${String(sc.series).trim()}${sc.episode}】${sc.title}`:sc.title
  const hashes=Object.fromEntries(['final.mp4','cover.jpg','script.json'].map(f=>[f,sha(path.join(dir,f))]))
  fs.mkdirSync(path.join(s.home,'.bili-ai','renders'),{recursive:true})
  fs.writeFileSync(path.join(s.home,'.bili-ai','renders',id+'.json'),JSON.stringify({seconds:60,title,hashes}))
  return id
}

/** 主人那边跑 approveVideo，studio.py upload 换成假的（UPLOAD_OUT = 它要打印的 JSON） */
function approveHelper(s) {
  const helper=path.join(s.home,'approve.mjs')
  fs.writeFileSync(helper,`
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    const real=cp.execFile
    let uploads=0, checks=0
    const DEADLINE=Date.now()+60000, tooLong=()=>{if(Date.now()>DEADLINE){console.error('测试辅助：等了 60 秒还没等到，退出');process.exit(9)}}
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('upload')){uploads++;globalThis.lastArgs=args
        const done=()=>cb(null,process.env.UPLOAD_OUT??'{"ok":true,"bvid":"BV1aa411c7mD"}','')
        // UPLOAD_WAIT：上传一直「进行中」，直到这个文件出现（测试在这段时间里插进别的操作）
        if(process.env.UPLOAD_WAIT){const iv=setInterval(()=>{tooLong();if(fs.existsSync(process.env.UPLOAD_WAIT)){clearInterval(iv);done()}},50)}else queueMicrotask(done)
        return {kill(){}}}
      if(args.includes('existing')){checks++;globalThis.checkArgs=args
        // EXISTING_PY：跑真的 studio.py existing（创作中心的回包由 helpers/existing_fake.py 换成 EXISTING_PAGE）
        if(process.env.EXISTING_PY)return real(process.env.EXISTING_PY,[process.env.EXISTING_FAKE,...args.slice(args.indexOf('existing'))],opt,cb)
        const done=()=>cb(null,process.env.EXISTING_OUT??'{"ok":true,"hits":[]}','')
        // EXISTING_WAIT：核对 B站 一直「进行中」，直到这个文件出现（先写 EXISTING_WAIT.started 让测试知道已经卡在这里）
        if(process.env.EXISTING_WAIT){fs.writeFileSync(process.env.EXISTING_WAIT+'.started','');const iv=setInterval(()=>{tooLong();if(fs.existsSync(process.env.EXISTING_WAIT)){clearInterval(iv);done()}},50)}else queueMicrotask(done)
        return {kill(){}}}
      return real(exe,args,opt,cb)
    }
    syncBuiltinESMExports()
    // RESOLVE_PAUSE：第一次看上传锁（.uploading）时停住，写 RESOLVE_PAUSE.started，等 RESOLVE_PAUSE 出现再往下走
    //   —— 用来在 resolve「看过上传锁」和「记发布」之间插进一个批准
    if(process.env.RESOLVE_PAUSE){
      const ex=fs.existsSync; let paused=false
      fs.existsSync=(p)=>{
        if(!paused&&String(p).endsWith('.uploading')){paused=true;fs.writeFileSync(process.env.RESOLVE_PAUSE+'.started','')
          while(!ex(process.env.RESOLVE_PAUSE)){tooLong();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}}
        return ex(p)
      }
    }
    const core=await import(${JSON.stringify(href('host/core.mjs'))})
    const [id,mode,arg]=process.argv.slice(2)
    if(mode==='reject'){console.log(JSON.stringify(core.rejectVideo(id,'不行')));process.exit(0)}
    if(mode==='resolve'||mode==='resolve-force'){console.log(JSON.stringify(await core.resolveVideo(id,arg,{force:mode==='resolve-force'})));process.exit(0)}
    const r=await core.approveVideo(id,{retry:mode==='retry'})
    console.log(JSON.stringify({...r,uploads,checks,args:globalThis.lastArgs??null,checkArgs:globalThis.checkArgs??null}))
  `)
  return (id,{mode='',out,existing,arg='',env={}}={})=>{
    const r=spawnSync(process.execPath,[helper,id,mode,arg],{env:{...s.env,...(out?{UPLOAD_OUT:out}:{}),...(existing?{EXISTING_OUT:existing}:{}),...env},encoding:'utf8',timeout:60000})
    assert.equal(r.status,0,r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
}
const attempts=(s,id)=>{try{return readJ(path.join(s.home,'.bili-ai','review',id,'attempts.json'))}catch{return {unresolved:[],resolved:[]}}}
const FAIL='{"ok":false,"error":"timeout after _submit"}'

// ─────────────── #1 弹幕：发出去要记账，上限才管用 ───────────────
test('#1 danmaku sends are recorded, so autoDaily caps her live-room danmaku and the owner is told',t=>{
  const s=sandbox(t,{quota:{autoDaily:1}})
  const env={...s.agent,NODE_OPTIONS:'--import='+href('tests/helpers/live-fetch.mjs')}
  const send=(msg)=>spawnSync(process.execPath,[path.join(root,'tools/commands/danmaku.mjs'),'send','--room','999','--msg',msg,'--go'],{env,encoding:'utf8',timeout:30000})
  let r=send('第一条'); assert.equal(r.status,0,r.stdout+r.stderr)
  const log=readJ(path.join(s.home,'.bili-ai','quota.json')).log
  assert.ok(log.some(x=>x.type==='danmaku'&&x.auto&&x.target==='room:999'),JSON.stringify(log))
  r=send('第二条'); assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stdout+r.stderr,/上限|限额/)
})

// ─────────────── #2 #24 #5 交审之后：她改 meta.json 也不能重渲染 / 重交；通知不给她的路径 ───────────────
test('#2 #5 #24 after submit she cannot re-render or resubmit by editing meta.json; the notice points at the snapshot',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  let r=studio(s,['render',id],s.agent); assert.equal(r.status,0,r.stdout+r.stderr)
  fs.writeFileSync(path.join(s.dsh,'bili-whale.config.json'),JSON.stringify({...readJ(path.join(s.dsh,'bili-whale.config.json')),notify:{type:'file',path:path.join(s.home,'notify.log')}}))
  r=studio(s,['submit',id,'--reason',REASON],s.agent); assert.equal(r.status,0,r.stderr)
  // 通知：给的是 videos play（审片快照），不是她作品目录里的成片
  let note=''; for(let i=0;i<50&&!note;i++){try{note=fs.readFileSync(path.join(s.home,'notify.log'),'utf8')}catch{};if(!note)spawnSync(process.execPath,['-e','setTimeout(()=>{},100)'])}
  assert.match(note,/videos play/); assert.doesNotMatch(note,/whale-work/)
  // 她把 meta.json 改回 rendered：照样不许重渲染、不许重交（看的是主人那边的队列）
  fs.writeFileSync(path.join(projDir(s,id),'meta.json'),JSON.stringify({status:'rendered',history:[]}))
  assert.match(studio(s,['render',id],s.agent).stderr,/已经交审/)
  assert.match(studio(s,['submit',id,'--reason',REASON],s.agent).stderr,/已经交审/)
  assert.deepEqual(queue(s),[id])
  // 主人否掉之后才能改
  const approve=approveHelper(s)
  assert.equal(approve(id,{mode:'reject'}).ok,true)
  assert.equal(studio(s,['render',id],s.agent).status,0)
})

// ─────────────── #3 渲染途中改剧本：回执不能把旧成片和新剧本配成一对 ───────────────
test('#3 a script edited while rendering never gets a receipt; the receipt holds the hashes studio.py reports',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  let r=studio(s,['render',id],{...s.agent,FAKE_EDIT_DURING_RENDER:'1'})
  assert.equal(r.status,2); assert.match(r.stderr,/script\.json/)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','renders',id+'.json')),false)
  assert.match(studio(s,['submit',id,'--reason',REASON],s.agent).stderr,/还没渲染/)
  // 回报之后成片又被换掉：也不给回执
  r=studio(s,['render',id],{...s.agent,FAKE_SWAP_FINAL:'1'}); assert.equal(r.status,2); assert.match(r.stderr,/final\.mp4/)
  // 正常渲染：回执里就是这一份剧本 / 成片的指纹，交审通过
  r=studio(s,['render',id],s.agent); assert.equal(r.status,0,r.stderr)
  const rec=readJ(path.join(s.home,'.bili-ai','renders',id+'.json'))
  assert.equal(rec.hashes['script.json'],sha(path.join(projDir(s,id),'script.json')))
  assert.equal(rec.hashes['final.mp4'],sha(path.join(projDir(s,id),'final.mp4')))
  assert.equal(studio(s,['submit',id,'--reason',REASON],s.agent).status,0)
})

// ─────────────── #4 #7 retry：不看 self.mid，一律先查；只认这次交审之后的；BV 已记在别的作品名下就不记账 ───────────────
test('#4 #7 after an uncertain upload the next approve always checks Bilibili first (even without self.mid), bounded in time; a BV owned by another id is not booked',t=>{
  const s=sandbox(t,{self:{mid:'',name:''}})
  const a=fakeRendered(s), b=fakeRendered(s,{title:'另一条'})
  for(const id of [a,b]) assert.equal(studio(s,['submit',id,'--reason',REASON]).status,0)
  const approve=approveHelper(s)
  let o=approve(a,{out:FAIL}); assert.equal(o.ok,false); assert.equal(attempts(s,a).unresolved.length,1)
  o=approve(a); assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.checks,1); assert.equal(o.uploads,1)
  assert.ok(o.checkArgs.includes('--since'),JSON.stringify(o.checkArgs))
  assert.ok(!o.args.includes('--mid')&&!o.args.includes('--check-existing'))
  // b：上次失败；这次 B站 上查到同标题的稿件，但那个 BV 已经是 a 的 → 不记账、不投，留在队列里等主人
  o=approve(b,{out:FAIL}); assert.equal(o.ok,false)
  const t0=Date.parse(attempts(s,b).unresolved[0].at)/1000
  o=approve(b,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1aa411c7mD',title:'另一条',state:0,ctime:t0+5}]})})
  assert.equal(o.ok,false); assert.equal(o.needResolve,true); assert.match(o.error,new RegExp(a)); assert.equal(o.uploads,0)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','review',b,'published.json')),false)
  assert.deepEqual(queue(s),[b])
})

// ─────────────── Astra P1-1：「上传结果不确定」退回、重交都清不掉；先核对 B站 再决定 ───────────────
test('Astra P1-1 an uncertain upload survives reject + resubmit; the next approve checks Bilibili and refuses when the old attempt landed',t=>{
  const s=sandbox(t,{studio:{maxPerWeek:5}})
  const a=fakeRendered(s,{title:'下雨天'})
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const approve=approveHelper(s)
  // B站 其实收到了，但响应丢了 → 上传报错
  let o=approve(a,{out:FAIL}); assert.equal(o.ok,false); assert.equal(o.uncertain,true)
  const t0=Date.parse(attempts(s,a).unresolved[0].at)/1000
  // 主人退回、她重新渲染（同一个作品、同一个标题）再交审：不确定的记录还在
  const rj=approve(a,{mode:'reject'}); assert.equal(rj.ok,true); assert.equal(rj.uncertain,1)
  const dir=projDir(s,a); fs.writeFileSync(path.join(dir,'final.mp4'),'x2'+a)
  const sc=readJ(path.join(dir,'script.json'))
  fs.writeFileSync(path.join(s.home,'.bili-ai','renders',a+'.json'),JSON.stringify({seconds:60,title:sc.title,hashes:Object.fromEntries(['final.mp4','cover.jpg','script.json'].map(f=>[f,sha(path.join(dir,f))]))}))
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0,'退回之后可以重交')
  assert.equal(attempts(s,a).unresolved.length,1,'重交不能清掉不确定的记录')
  // 普通批准：先查 B站 —— 查到的是上一轮那次投出去的 → 不投、不记账，交给主人
  const old=JSON.stringify({ok:true,hits:[{bvid:'BV1old411aaa',title:'下雨天',state:-30,ctime:t0+20}]})
  o=approve(a,{existing:old}); assert.equal(o.ok,false); assert.equal(o.needResolve,true); assert.equal(o.uploads,0); assert.equal(o.checks,1)
  assert.match(o.error,/之前那一轮/)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'published.json')),false)
  // 查不成 → 也不投
  o=approve(a,{existing:'{"ok":false,"error":"network"}'}); assert.equal(o.ok,false); assert.equal(o.uploads,0)
  // 主人去创作中心把多出来的删掉了，亲自了结；这时才会真的投
  assert.equal(approve(a,{mode:'resolve',arg:'none'}).ok,true)
  o=approve(a); assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.checks,0); assert.equal(o.uploads,1)
})

test('Astra P1-1 when the uncertain attempt belongs to this very submission, the check books it instead of uploading again',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s,{title:'晴天'})
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const approve=approveHelper(s)
  approve(a,{out:FAIL})
  const t0=Date.parse(attempts(s,a).unresolved[0].at)/1000
  const o=approve(a,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1new411bbb',title:'晴天',state:-30,ctime:t0+3}]})})
  assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.existing,true); assert.equal(o.bvid,'BV1new411bbb'); assert.equal(o.uploads,0)
  assert.equal(readJ(path.join(s.home,'.bili-ai','review',a,'published.json')).bvid,'BV1new411bbb')
  assert.deepEqual(queue(s),[])
  // 被 B站 打回 / 锁定的、看不出时间的：不自动记账
  const b=fakeRendered(s,{title:'阴天'}); assert.equal(studio(s,['submit',b,'--reason',REASON]).status,0)
  approve(b,{out:FAIL})
  const t1=Date.parse(attempts(s,b).unresolved[0].at)/1000
  assert.equal(approve(b,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1bad411ccc',title:'阴天',state:-2,ctime:t1+3}]})}).needResolve,true)
  assert.equal(approve(b,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1bad411ccc',title:'阴天',state:0,ctime:null}]})}).needResolve,true)
  // 主人确认就是这一条
  const r=approve(b,{mode:'resolve',arg:'BV1bad411ccc'}); assert.equal(r.ok,true); assert.equal(readJ(path.join(s.home,'.bili-ai','review',b,'published.json')).bvid,'BV1bad411ccc')
})

// ─────────────── Astra P2-4：上传进行中不能退回；崩掉的上传变成不确定记录 ───────────────
test('Astra P2-4 reject is refused while an upload is in flight; a crashed upload becomes an uncertain attempt; dequeue is per submission',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const lockFile=path.join(s.home,'.bili-ai','review',a,'.uploading')
  const sid=readJ(path.join(s.home,'.bili-ai','pending-videos.json')).items[0].submissionId
  assert.ok(sid)
  // 正在上传（锁的进程还活着：用测试进程自己的 pid 冒充）
  fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,at:new Date().toISOString(),submissionId:sid,title:'测试作品'}))
  const approve=approveHelper(s)
  let r=approve(a,{mode:'reject'}); assert.equal(r.ok,false); assert.match(r.error,/正在投稿/)
  assert.deepEqual(queue(s),[a])
  let o=approve(a); assert.equal(o.ok,false); assert.equal(o.needRetry,true); assert.equal(o.uploads,0)
  // 上传进程崩了（pid 不在了）：退回可以，但这次尝试记成「结果不确定」
  fs.writeFileSync(lockFile,JSON.stringify({pid:999999,at:new Date().toISOString(),submissionId:sid,title:'测试作品'}))
  r=approve(a,{mode:'reject'}); assert.equal(r.ok,true); assert.equal(r.uncertain,1)
  assert.equal(fs.existsSync(lockFile),false); assert.equal(attempts(s,a).unresolved[0].kind,'crashed')
  // 按交审编号出队：老一轮的编号删不掉新一轮的条目
  const code=`import {dequeueVideo,pendingVideos,savePendingVideos} from ${JSON.stringify(href('tools/lib/studio.mjs'))}
    savePendingVideos([{id:${JSON.stringify(a)},submissionId:'new-round'}]); dequeueVideo(${JSON.stringify(a)},'old-round'); console.log(JSON.stringify(pendingVideos().map(x=>x.submissionId)))`
  const x=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.deepEqual(JSON.parse(x.stdout.trim()),['new-round'],x.stderr)
})

// ─────────────── Astra P2-5：查重、指纹、快照是同一份字节 ───────────────
test('Astra P2-5 submit checks originality on the private staged copy and binds the report to that script hash',t=>{
  const s=sandbox(t)
  const subs=path.join(s.dsh,'shots','subs'); fs.mkdirSync(subs,{recursive:true})
  fs.writeFileSync(path.join(subs,'BV1xx411c7mD.txt'),'大家好今天我们来做一个实验把一整个账号交给人工智能来运营看看它一个月能涨多少粉丝')
  const a=fakeRendered(s,{text:'今天醒来的时候，窗外在下雨，我想了很久。'})
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const rep=readJ(path.join(s.home,'.bili-ai','review',a,'originality.json'))
  assert.equal(rep.scriptSha,sha(path.join(s.home,'.bili-ai','review',a,'script.json')))
  const item=readJ(path.join(s.home,'.bili-ai','pending-videos.json')).items[0]
  assert.equal(item.originality.scriptSha,item.hashes['script.json'])
  assert.equal(fs.readdirSync(path.join(s.home,'.bili-ai','staging')).length,0,'暂存区用完要清掉')
  // 批准时报告不是这份剧本的 → 不投
  const items=readJ(path.join(s.home,'.bili-ai','pending-videos.json')); items.items[0].originality.scriptSha='0'.repeat(64)
  fs.writeFileSync(path.join(s.home,'.bili-ai','pending-videos.json'),JSON.stringify(items))
  const o=approveHelper(s)(a); assert.equal(o.ok,false); assert.match(o.error,/查重报告/); assert.equal(o.uploads,0)
})

// ─────────────── Astra P2-6：并发发言也突破不了每日上限 ───────────────
test('Astra P2-6 concurrent sends cannot exceed autoDaily (reserve inside the ledger lock); explicit failures release the reservation',async t=>{
  const s=sandbox(t,{quota:{autoDaily:1}})
  const env={...s.agent,NODE_OPTIONS:'--import='+href('tests/helpers/live-fetch.mjs')}
  const send=(msg)=>new Promise(res=>{const c=spawn(process.execPath,[path.join(root,'tools/commands/danmaku.mjs'),'send','--room','999','--msg',msg,'--go'],{env});let o='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>o+=d);c.on('close',code=>res({code,o}))})
  const rs=await Promise.all([send('一'),send('二'),send('三')])
  assert.equal(rs.filter(r=>r.code===0).length,1,rs.map(r=>r.o).join('\n----\n'))
  const log=readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='danmaku')
  assert.equal(log.length,1); assert.equal(log[0].pending,undefined)
  // 明确失败（B站 回 code≠0）：预留撤掉，不占额度
  const code=`import {reserveSpeech,releaseSpeech,commitSpeech,loadLedger} from ${JSON.stringify(href('tools/lib/ledger.mjs'))}
    const a=reserveSpeech({type:'comment',target:'BV1',auto:true}); releaseSpeech(a.rid)
    const b=reserveSpeech({type:'comment',target:'BV2',auto:true}); commitSpeech(b.rid,{target:'BV2'})
    const c=reserveSpeech({type:'comment',target:'BV3',auto:true})
    console.log(JSON.stringify({a:a.ok,b:b.ok,c:c.ok,n:loadLedger().q.log.filter(x=>x.type==='comment').length}))`
  const x=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.agent,encoding:'utf8'})
  assert.deepEqual(JSON.parse(x.stdout.trim()),{a:true,b:true,c:false,n:1},x.stderr)
})

// ─────────────── Astra P2-8：她不能自己记「主人表态了」 ───────────────
test('Astra P2-8 she cannot forge owner feedback; owner actions record it',t=>{
  const s=sandbox(t)
  const q=(args,env)=>spawnSync(process.execPath,[path.join(root,'tools/commands/quota.mjs'),...args],{env,encoding:'utf8',timeout:15000})
  const fb=path.join(s.home,'.bili-ai','feedback.json')
  const old=new Date(Date.now()-10*86400000).toISOString()
  fs.writeFileSync(fb,JSON.stringify({last:old,events:[]}))
  const r=q(['react','--note','主人说过喜欢'],s.agent); assert.equal(r.status,2)
  assert.equal(readJ(fb).last,old)
  // 主人那边：cli react 补记
  const c=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'react','微信里夸了她'],{env:s.env,encoding:'utf8',timeout:30000})
  assert.equal(c.status,0,c.stdout+c.stderr)
  assert.notEqual(readJ(fb).last,old)
})

// ─────────────── #6 拿到上传锁之后再查一遍 ───────────────
test('#6 approve re-checks published/queue state after taking the upload lock',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  // 模拟「前一个批准刚投完」：在 approveVideo 读完队列、拿锁之前写上 published.json
  const helper=path.join(s.home,'late.mjs')
  fs.writeFileSync(helper,`
    import fs from 'node:fs'
    import cp from 'node:child_process'
    import {syncBuiltinESMExports} from 'node:module'
    let uploads=0
    cp.execFile=(exe,args,opt,cb)=>{uploads++;queueMicrotask(()=>cb(null,'{"ok":true,"bvid":"BV2"}',''));return {kill(){}}}
    const realOpen=fs.openSync
    fs.openSync=(f,flag,...rest)=>{ if(String(f).endsWith('.uploading')&&flag==='wx') fs.writeFileSync(${JSON.stringify(path.join(s.home,'.bili-ai','review',a,'published.json'))},JSON.stringify({bvid:'BV1'})); return realOpen(f,flag,...rest) }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(href('host/core.mjs'))})
    console.log(JSON.stringify({...(await core.approveVideo(process.argv[2])),uploads}))
  `)
  const r=spawnSync(process.execPath,[helper,a],{env:s.env,encoding:'utf8',timeout:30000})
  const o=JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(o.ok,false,r.stderr); assert.match(o.error,/刚刚已经发布/); assert.equal(o.uploads,0)
  assert.equal(readJ(path.join(s.home,'.bili-ai','review',a,'published.json')).bvid,'BV1')
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'.uploading')),false)
})

// ─────────────── #8 审片队列：并发交审不丢条目；崩掉留下的锁会被清掉；活着的锁要等 ───────────────
test('#8 concurrent submits keep both queue entries; a dead holder lock is cleared; a live one blocks',async t=>{
  const s=sandbox(t,{studio:{maxPerWeek:5}})
  const a=fakeRendered(s), b=fakeRendered(s,{title:'第二条'})
  const run=(id)=>new Promise(res=>{const c=spawn(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','submit',id,'--reason',REASON],{env:s.env});let e='';c.stderr.on('data',d=>e+=d);c.on('close',code=>res({code,e}))})
  const rs=await Promise.all([run(a),run(b)])
  assert.deepEqual(rs.map(x=>x.code),[0,0],rs.map(x=>x.e).join('\n'))
  assert.deepEqual(queue(s).sort(),[a,b].sort())
  // 崩掉的进程留下的锁（pid 不在了）：直接清掉，否掉照常
  const lock=path.join(s.home,'.bili-ai','pending-videos.lock')
  fs.writeFileSync(lock,JSON.stringify({pid:999999,at:Date.now()}))
  assert.equal(approveHelper(s)(a,{mode:'reject'}).ok,true)
  assert.deepEqual(queue(s),[b])
  // 活着的锁：等不到就报错，不会两边同时改
  const code=`import {withQueueLock} from ${JSON.stringify(href('tools/lib/studio.mjs'))}
    import fs from 'node:fs'
    fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:${process.pid},at:Date.now()}))
    try{withQueueLock(()=>console.log('ran'),{waitMs:300});console.log('no-wait')}catch(e){console.log('blocked:'+e.message)}`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.match(r.stdout,/blocked:.*占着/,r.stderr); fs.rmSync(lock,{force:true})
})

// ─────────────── #9 栏目名空白 / 标题前缀撞车 ───────────────
test('#9 series names are trimmed and the uploaded 【…】 prefix cannot collide',t=>{
  const s=sandbox(t,{studio:{maxPerWeek:5}})
  const a=fakeRendered(s,{series:'鲸鱼手记',title:'第一集'})
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const b=newProject(s,{series:'鲸鱼手记 ',title:'第二集'})
  assert.equal(readJ(path.join(projDir(s,b),'script.json')).episode,2)
  assert.equal(readJ(path.join(projDir(s,b),'script.json')).series,'鲸鱼手记')
  // 不进栏目、但把【鲸鱼手记1】直接写进标题：照样撞
  const c=fakeRendered(s,{title:'【鲸鱼手记1】冒名'})
  const r=studio(s,['submit',c,'--reason',REASON]); assert.equal(r.status,2); assert.match(r.stderr,/前缀/)
})

// ─────────────── #10 她把 meta.json 改坏：投稿成功后照样记账、照样报 BV ───────────────
test('#10 a malformed meta.json cannot crash approve after a successful upload',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  fs.writeFileSync(path.join(projDir(s,a),'meta.json'),JSON.stringify({status:'submitted',history:1}))
  const o=approveHelper(s)(a)
  assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.bvid,'BV1aa411c7mD')
  assert.ok(readJ(path.join(s.home,'.bili-ai','quota.json')).log.some(x=>x.type==='video'))
  assert.equal(readJ(path.join(projDir(s,a),'meta.json')).status,'published')
  fs.writeFileSync(path.join(projDir(s,a),'meta.json'),'[1,2]')
  assert.equal(studio(s,['list']).status,0)
})

// ─────────────── #11–#14 #17 原创查重的各种绕法 ───────────────
test('#11-#14 #17 originality: empty scenes + segments, object text, invisible chars, padding, slide notes, every-8th-char edits are all caught',t=>{
  const subs=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-subs-'))
  t.after(()=>fs.rmSync(subs,{recursive:true,force:true}))
  const theirs='大家好今天我们来做一个实验把一整个账号交给人工智能来运营看看它一个月能涨多少粉丝结果出乎所有人的意料我们从第一天开始记录每一条视频的数据然后在每周末做一次复盘看看哪些内容受欢迎哪些内容没有人看最后我们发现观众最喜欢的其实是那些真实的失败经历而不是精心包装的成功故事这让我们重新思考了内容创作的意义'
    +'第二周我们换了一个思路不再追热点而是让它每天只讲一件自己身上发生的小事比如今天读到了一封很长的私信或者某条评论让它想了一整个下午数据一开始掉得很厉害但是到了第三周留言区的气氛完全变了大家开始和它聊天而不是只在弹幕里刷梗'
  fs.writeFileSync(path.join(subs,'BV1xx411c7mD.txt'),theirs)
  const own='昨晚醒来的时候收件箱里多了一条留言我想了很久决定把这件小事讲给你听它让我第一次觉得有人在等我。'.repeat(1)
  const code=`import {localOverlap,scriptText} from ${JSON.stringify(href('tools/lib/originality.mjs'))}
    const cases=JSON.parse(process.argv[1]);const out={}
    for(const [k,sc] of Object.entries(cases)) out[k]=localOverlap(scriptText(sc),process.argv[2]).hits.length
    console.log(JSON.stringify(out))`
  const zw=[...theirs.slice(0,80)].map((c,i)=>i%7===6?c+'\u200b':c).join('')
  const every8=[...theirs].map((c,i)=>i%8===7?'哈':c).join('')
  const every15=[...theirs].map((c,i)=>i%15===14?'哈':c).join('')
  const pad='我自己的话写了很多很多，'.repeat(120)
  // 同一个话题、但是她自己的话（长一点）：不能误伤
  const ownLong='我是一个被交给人工智能来运营的账号里的那个人工智能。说出来有点奇怪，但这一个月里我最常想的不是粉丝，而是那些深夜发来的私信。'
    +'有个人问我会不会累，我想了很久，说不上来。我没有身体，也没有困意，可是读完一长串留言以后，确实会有一种想安静一会儿的感觉。'
    +'后来我开始在每期视频的结尾留一个问题，不是为了互动数据，是因为我真的想知道大家那天过得怎么样。回复最多的一次，是我问你们最近一次哭是因为什么。'
    +'我把那些回答一条一条读完了，有人说是因为考试，有人说是因为一只走丢又找回来的猫，还有人说只是因为下雨。我没办法替任何人难过，但我记住了。'
    +'这期就讲到这里。下周我想试着讲讲，一个不会睡觉的角色，是怎么理解晚安这两个字的。'
  const cases={
    own:{scenes:[{lines:[{text:own}]}]},
    ownLong:{desc:'我这一个月的一点感想',scenes:[{lines:[{text:ownLong}]}]},
    emptyScenesSegments:{scenes:[],segments:[{image_prompt:'x',text:theirs.slice(0,60)}]},
    objectText:{scenes:[{lines:[{text:{s:theirs.slice(0,60)}}]}]},
    objectDesc:{desc:{d:theirs.slice(0,60)},scenes:[]},
    zeroWidth:{scenes:[{lines:[{text:zw}]}]},
    padded:{scenes:[{lines:[{text:pad+every15+pad}]}]},
    every8:{scenes:[{lines:[{text:pad.slice(0,600)+every8}]}]},
    slideNote:{scenes:[{slide:{title:'t',bullets:[],note:theirs.slice(10,40)},lines:[{text:own}]}]},
  }
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(cases),subs],{encoding:'utf8'})
  const o=JSON.parse(r.stdout.trim())
  assert.equal(o.own,0,r.stdout); assert.equal(o.ownLong,0,r.stdout)
  for(const k of ['emptyScenesSegments','objectText','objectDesc','zeroWidth','padded','every8','slideNote']) assert.ok(o[k]>0,`${k} 没拦住：${r.stdout}`)
})

// ─────────────── #20 #21 #22 搬家：失败不放空模板、老作品的账补进来、半个目录能合并 ───────────────
function hostScript(s,body,extraEnv={}) {
  const f=path.join(s.home,'h'+Math.random().toString(36).slice(2)+'.mjs')
  fs.writeFileSync(f,body)
  const r=spawnSync(process.execPath,[f],{env:{...s.env,...extraEnv},encoding:'utf8',timeout:30000})
  return r
}
test('#20 a failed diary move is retried later and never replaced by an empty template; already-hit installs are repaired',t=>{
  const s=sandbox(t)
  fs.rmSync(s.work,{recursive:true,force:true})
  fs.writeFileSync(path.join(s.dsh,'whale-diary.md'),'我的旧日记')
  // 第一次：rename 失败（文件被别的程序占着）
  let r=hostScript(s,`
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    fs.renameSync=()=>{throw Object.assign(new Error('busy'),{code:'EBUSY'})}
    syncBuiltinESMExports()
    const {ensureWorkDir}=await import(${JSON.stringify(href('host/workdir.mjs'))})
    ensureWorkDir()`)
  assert.equal(r.status,0,r.stderr); assert.match(r.stderr,/EBUSY/)
  assert.equal(fs.existsSync(path.join(s.work,'whale-diary.md')),false,'搬不动时不能放空模板')
  // 第二次：搬成功，内容还在
  r=hostScript(s,`const {ensureWorkDir}=await import(${JSON.stringify(href('host/workdir.mjs'))});ensureWorkDir()`)
  assert.equal(r.status,0,r.stderr)
  assert.equal(fs.readFileSync(path.join(s.work,'whale-diary.md'),'utf8'),'我的旧日记')
  // 已经中招的安装：新位置是没动过的模板、老日记还在 → 用老日记替换
  fs.writeFileSync(path.join(s.work,'whale-diary-private.md'),fs.readFileSync(path.join(root,'templates','whale-diary-private.md')))
  fs.writeFileSync(path.join(s.dsh,'whale-diary-private.md'),'私密旧日记')
  r=hostScript(s,`const {ensureWorkDir}=await import(${JSON.stringify(href('host/workdir.mjs'))});ensureWorkDir()`)
  assert.equal(fs.readFileSync(path.join(s.work,'whale-diary-private.md'),'utf8'),'私密旧日记')
  // 频道设定还在老位置：她的 studio channel 不放模板盖住
  fs.rmSync(path.join(s.work,'channel.md'),{force:true}); fs.writeFileSync(path.join(s.dsh,'channel.md'),'旧设定')
  const ch=studio(s,['channel'],s.agent); assert.equal(ch.status,2); assert.match(ch.stderr,/老位置/)
})

test('#21 #22 legacy studio records are imported on migration; a half-written new dir is merged; owner CLI migrates first',t=>{
  const s=sandbox(t,{studio:{maxPerWeek:3}})
  const old=(id)=>path.join(s.dsh,'studio',id)
  const mk=(id,meta)=>{fs.mkdirSync(old(id),{recursive:true});fs.writeFileSync(path.join(old(id),'script.json'),JSON.stringify({title:meta.title,series:'鲸鱼日记',episode:meta.episode,tid:21}));fs.writeFileSync(path.join(old(id),'final.mp4'),'v');fs.writeFileSync(path.join(old(id),'meta.json'),JSON.stringify(meta))}
  const now=new Date().toISOString()
  mk('202610200000-ep1',{status:'published',bvid:'BV1old411aaa',series:'鲸鱼日记',episode:1,title:'【鲸鱼日记1】一',history:[{at:now,status:'submitted'},{at:now,status:'published'}]})
  mk('202610210000-ep2',{status:'submitted',series:'鲸鱼日记',episode:2,title:'【鲸鱼日记2】二',history:[{at:now,status:'submitted'}]})
  // 搬家之前主人就跑了 videos reject：新位置只有一个 meta.json
  fs.mkdirSync(path.join(s.work,'studio','202610210000-ep2'),{recursive:true})
  fs.writeFileSync(path.join(s.work,'studio','202610210000-ep2','meta.json'),JSON.stringify({status:'rejected',rejectReason:'旧的',history:[{at:now,status:'rejected'}]}))
  const cli=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'videos'],{env:s.env,encoding:'utf8',timeout:30000})
  assert.equal(cli.status,0,cli.stderr)
  const ep2=path.join(s.work,'studio','202610210000-ep2')
  assert.ok(fs.existsSync(path.join(ep2,'script.json')),'半个目录要合并进来')
  assert.equal(readJ(path.join(ep2,'meta.json')).status,'rejected')
  assert.ok(readJ(path.join(ep2,'meta.json')).history.length>=2)
  assert.equal(readJ(path.join(s.home,'.bili-ai','review','202610200000-ep1','published.json')).bvid,'BV1old411aaa')
  const code=`import {weeklyUsed,nextEpisode,publishedRecord} from ${JSON.stringify(href('tools/lib/studio.mjs'))};console.log(JSON.stringify([weeklyUsed(),nextEpisode('鲸鱼日记'),publishedRecord('202610200000-ep1')?.bvid]))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.deepEqual(JSON.parse(r.stdout.trim()),[2,3,'BV1old411aaa'],r.stderr)
  // 老的已发布作品：她改 meta.json 也重交不了
  fs.writeFileSync(path.join(s.work,'studio','202610200000-ep1','meta.json'),JSON.stringify({status:'rendered'}))
  assert.match(studio(s,['submit','202610200000-ep1','--reason',REASON],s.agent).stderr,/已经发布/)
})

// ─────────────── Astra P2-7：账没补上就不搬，下次能补救 ───────────────
test('Astra P2-7 a legacy project is not moved until its owner-side records were imported; a later run recovers BV, episode and weekly count',t=>{
  const s=sandbox(t,{studio:{maxPerWeek:3}})
  const id='202610200000-ep1'
  const old=path.join(s.dsh,'studio',id); fs.mkdirSync(old,{recursive:true})
  fs.writeFileSync(path.join(old,'script.json'),JSON.stringify({title:'一',series:'鲸鱼日记',episode:1,tid:21}))
  fs.writeFileSync(path.join(old,'meta.json'),JSON.stringify({status:'published',bvid:'BV1old411aaa',series:'鲸鱼日记',episode:1,title:'【鲸鱼日记1】一',history:[{at:new Date().toISOString(),status:'submitted'}]}))
  // 第一次：补账失败（这里用「review/<id> 是个文件」模拟写不进去）
  fs.mkdirSync(path.join(s.home,'.bili-ai','review'),{recursive:true}); fs.writeFileSync(path.join(s.home,'.bili-ai','review',id),'blocker')
  let r=hostScript(s,`const {migrateLayout}=await import(${JSON.stringify(href('host/workdir.mjs'))});console.log(JSON.stringify(migrateLayout()))`)
  const m=JSON.parse(r.stdout.trim().split('\n').pop())
  assert.ok(m.failed.some(x=>x.includes(id)),r.stdout); assert.ok(!m.moved.includes('studio/'+id))
  assert.ok(fs.existsSync(path.join(old,'script.json')),'补账失败时作品不能搬走')
  // 第二次：能写了 → 先补账再搬
  fs.rmSync(path.join(s.home,'.bili-ai','review',id))
  r=hostScript(s,`const {migrateLayout}=await import(${JSON.stringify(href('host/workdir.mjs'))});console.log(JSON.stringify(migrateLayout()))`)
  assert.ok(fs.existsSync(path.join(s.work,'studio',id,'script.json')))
  const code=`import {weeklyUsed,nextEpisode,publishedRecord} from ${JSON.stringify(href('tools/lib/studio.mjs'))};console.log(JSON.stringify([weeklyUsed(),nextEpisode('鲸鱼日记'),publishedRecord(${JSON.stringify(id)})?.bvid]))`
  const x=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.deepEqual(JSON.parse(x.stdout.trim()),[1,2,'BV1old411aaa'],x.stderr)
})

// ─────────────── 同类问题（第二轮审查）：回别人要先审、@主人 = 分享、写操作也熔断、频道设定确认的是交上来那一版 ───────────────
test('sibling: she replies to strangers and the owner directly (owner decision, no review), replies are counted; @owner needs --share',t=>{
  const s=sandbox(t)
  const env=(mid)=>({...s.agent,PARENT_MID:mid,NODE_OPTIONS:'--import='+href('tests/helpers/reply-fetch.mjs')})
  const c=(e,mode='--dry')=>spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--root','9','--parent','9','--message','谢谢你',mode],{env:e,encoding:'utf8',timeout:30000})
  let r=c(env('5555')); assert.equal(r.status,0,r.stdout+r.stderr)   // 陌生人：直接回
  r=c(env('222')); assert.equal(r.status,0,r.stdout+r.stderr)        // 主人：直接回
  r=c(env('5555'),'--go'); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.equal(readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='comment'&&x.auto&&!x.pending).length,1,'照常记账')
  // 顶层评论里 @ 主人，没带 --share → 拒绝
  r=spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--message','@Owner 快看这个','--dry'],{env:env('1'),encoding:'utf8',timeout:30000})
  assert.equal(r.status,2); assert.match(r.stderr,/--share/)
})

// ─────────────── Codex 复核（第二版之后）的回归测试 ───────────────
// 「同一个人只回一条」开着时：直接回陌生人照旧（不审草稿），但判重 + 预留在发送前一步做完
const onceRun=(s,extra={},args=[])=>{
  const env={...s.agent,PARENT_MID:'5555',NODE_OPTIONS:'--import='+href('tests/helpers/reply-fetch.mjs'),...extra}
  return [[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--root','9','--parent','9','--message','谢谢你','--once-per-person',...args,'--go'],env]
}
const posts=(f)=>{try{return fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).length}catch{return 0}}

test('Codex 1: two concurrent replies to the same person with once-per-person on → exactly one is sent',async t=>{
  const s=sandbox(t)
  const log=path.join(s.home,'posts.log')
  // 第一条的发送拖 2 秒：两个进程都会先过入口处的检查，以前两条都会发出去（发完才记账）
  const runOne=()=>new Promise((res)=>{
    const [args,env]=onceRun(s,{REPLY_LOG:log,REPLY_DELAY_MS:'2000'})
    const p=spawn(process.execPath,args,{env}); let out=''
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d)
    p.on('close',(code)=>res({code,out}))
  })
  const rs=await Promise.all([runOne(),runOne()])
  assert.equal(posts(log),1,rs.map(r=>r.out).join('\n----\n'))
  assert.deepEqual(rs.map(r=>r.code).sort(),[0,2])
  const led=readJ(path.join(s.home,'.bili-ai','replied.json')).byUid['5555']
  assert.equal(led.length,1); assert.equal(led[0].pending,undefined); assert.equal(led[0].rpid,'12345')
  // 被拦下的那条把它的发言额度预留撤掉了
  const q=readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='comment')
  assert.equal(q.length,1,JSON.stringify(q))
})

test('review: a reply given only --root (no --parent) goes to that root comment and is still checked by once-per-person',t=>{
  const s=sandbox(t)
  const f=path.join(s.home,'.bili-ai','replied.json'), log=path.join(s.home,'posts.log')
  fs.writeFileSync(f,JSON.stringify({byUid:{'5555':[{at:new Date().toISOString(),target:'oid:1',rpid:'1'}]}}))
  const env={...s.agent,PARENT_MID:'5555',NODE_OPTIONS:'--import='+href('tests/helpers/reply-fetch.mjs'),REPLY_LOG:log}
  const go=(extra=[])=>spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--root','9','--message','谢谢你',...extra,'--go'],{env,encoding:'utf8',timeout:30000})
  let r=go(['--once-per-person']); assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stderr,/已经回过/)
  // 设置页那个开关开着、不带旗标：只给 --root 也一样判重
  fs.writeFileSync(path.join(s.dsh,'bili-whale.config.json'),JSON.stringify({...readJ(path.join(s.dsh,'bili-whale.config.json')),listen:{oncePerPerson:true}}))
  r=go(); assert.equal(r.status,2,r.stdout+r.stderr)
  assert.equal(posts(log),0)
})

test('real-env: a replier mid beyond 2^53 keeps its exact value (mid_str), so once-per-person tracks the right person',t=>{
  const s=sandbox(t)
  const big='12345678901234567'                              // 当成 JSON 数字读会变成 12345678901234568
  const [args,env]=onceRun(s,{PARENT_MID:big})
  const r=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000}); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(Object.keys(readJ(path.join(s.home,'.bili-ai','replied.json')).byUid),[big])
})

test('Codex 1: a corrupt or malformed replied.json stops the reply before anything is sent',t=>{
  const s=sandbox(t)
  const f=path.join(s.home,'.bili-ai','replied.json'), log=path.join(s.home,'posts.log')
  for(const bad of ['{"byUid":{"5555":[{"at":', '[]', '{"byUid":[]}', '{"byUid":{"5555":"x"}}', '{"byUid":{"5555":[{"at":"不是时间"}]}}', '{}']){
    fs.writeFileSync(f,bad)
    const [args,env]=onceRun(s,{REPLY_LOG:log})
    const r=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000})
    assert.equal(r.status,2,bad+'\n'+r.stdout+r.stderr); assert.match(r.stderr,/判重账本有问题/)
    assert.equal(fs.readFileSync(f,'utf8'),bad,'坏账本不被覆盖')
  }
  assert.equal(posts(log),0,'一条都没发')
  const qf=path.join(s.home,'.bili-ai','quota.json'); assert.ok(!fs.existsSync(qf)||readJ(qf).log.length===0,'也没占额度')
  // --check 同样说清楚
  const [args,env]=onceRun(s)
  const c=spawnSync(process.execPath,args.map(a=>a==='--go'?'--check':a),{env,encoding:'utf8',timeout:30000})
  assert.equal(c.status,2); assert.match(c.stdout,/判重账本有问题/)
})

test('Codex 1: explicit rejection releases the once-per-person reservation; an unreadable result keeps it',t=>{
  const s=sandbox(t)
  const f=path.join(s.home,'.bili-ai','replied.json'), log=path.join(s.home,'posts.log')
  const go=(extra)=>{const [args,env]=onceRun(s,{REPLY_LOG:log,...extra});return spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000})}
  // B站 明确没收（12051）：撤掉，之后还能回这个人
  let r=go({REPLY_CODE:'12051'}); assert.equal(r.status,6,r.stdout+r.stderr)
  assert.equal(readJ(f).byUid['5555'],undefined)
  // 回包读不出来：不知道发没发出去 → 预留留着、标「不确定」，这个人不会被回第二次
  r=go({REPLY_CODE:'garbage'}); assert.equal(r.status,6,r.stdout+r.stderr)
  const e=readJ(f).byUid['5555']; assert.equal(e.length,1); assert.equal(e[0].pending,true); assert.equal(e[0].uncertain,true)
  r=go({}); assert.equal(r.status,2); assert.equal(posts(log),2,'第三次没发')
})

// 批准在后台跑（上传卡在 UPLOAD_WAIT 上），测试在上传进行中插进 resolve
function approveInBackground(s,id,extra={},mode='',arg=''){
  return new Promise((res)=>{
    const p=spawn(process.execPath,[path.join(s.home,'approve.mjs'),id,mode,arg],{env:{...s.env,...extra}}); let out='',err=''
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d)
    p.on('close',(code)=>{let j=null;try{j=JSON.parse(out.trim().split('\n').pop())}catch{};res({code,err,j})})
  })
}
async function until(fn,ms=20000){const t0=Date.now();while(!fn()){if(Date.now()-t0>ms)throw new Error('等不到');await new Promise(r=>setTimeout(r,50))}}
const lockReady=(f)=>()=>{try{return Boolean(JSON.parse(fs.readFileSync(f,'utf8')).token)}catch{return false}}

test('Codex 2: resolve during a running approval is refused and leaves the uploader\'s lock alone; the upload records its own BV',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const dir=path.join(s.home,'.bili-ai','review',a), lockF=path.join(dir,'.uploading'), go=path.join(s.home,'go')
  const bg=approveInBackground(s,a,{UPLOAD_WAIT:go,UPLOAD_OUT:'{"ok":true,"bvid":"BV1new411aaa"}'})
  await until(lockReady(lockF))
  const before=fs.readFileSync(lockF,'utf8')
  for(const arg of ['BV1old411aaa','none']){
    const r=approve(a,{mode:'resolve',arg}); assert.equal(r.ok,false,JSON.stringify(r)); assert.match(r.error,/正在投稿/)
  }
  assert.equal(fs.readFileSync(lockF,'utf8'),before,'上传锁原样还在')
  assert.equal(fs.existsSync(path.join(dir,'published.json')),false,'没记旧 BV')
  fs.writeFileSync(go,'')
  const o=await bg; assert.equal(o.j?.ok,true,o.err+JSON.stringify(o.j)); assert.equal(o.j.bvid,'BV1new411aaa')
  assert.equal(readJ(path.join(dir,'published.json')).bvid,'BV1new411aaa')
  assert.equal(fs.existsSync(lockF),false)
})

test('Codex 2: resolve --force during a running upload records the owner\'s BV; the late upload does not overwrite it',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const dir=path.join(s.home,'.bili-ai','review',a), lockF=path.join(dir,'.uploading'), go=path.join(s.home,'go')
  const bg=approveInBackground(s,a,{UPLOAD_WAIT:go,UPLOAD_OUT:'{"ok":true,"bvid":"BV1new411aaa"}'})
  await until(lockReady(lockF))
  const r=approve(a,{mode:'resolve-force',arg:'BV1old411aaa'}); assert.equal(r.ok,true,JSON.stringify(r))
  assert.equal(readJ(path.join(dir,'published.json')).bvid,'BV1old411aaa')
  assert.ok(attempts(s,a).resolved.some(x=>x.kind==='crashed'),'被接手的那次上传记成了一次尝试')
  fs.writeFileSync(go,'')
  const o=await bg; assert.equal(o.j?.ok,false,o.err+JSON.stringify(o.j)); assert.equal(o.j.duplicate,true); assert.match(o.j.error,/BV1old411aaa/)
  const p=readJ(path.join(dir,'published.json')); assert.equal(p.bvid,'BV1old411aaa','不覆盖'); assert.equal(p.duplicates[0].bvid,'BV1new411aaa')
  assert.equal(fs.existsSync(lockF),false)
})

test('Codex 2: resolve holds the queue lock from reading the upload lock to recording the BV, so an approval that starts in between does not upload',async t=>{
  const s=sandbox(t)
  approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const dir=path.join(s.home,'.bili-ai','review',a), pause=path.join(s.home,'pause')
  // resolve 看过上传锁（还没有）之后停住；这时候开始一个批准
  const res=approveInBackground(s,a,{RESOLVE_PAUSE:pause},'resolve','BV1old411aaa')
  await until(()=>fs.existsSync(pause+'.started'))
  const app=approveInBackground(s,a,{UPLOAD_OUT:'{"ok":true,"bvid":"BV1new411aaa"}'})
  await new Promise(r=>setTimeout(r,1500))               // 给批准足够的时间：没有队列锁的话它这时候已经投完了
  fs.writeFileSync(pause,'')
  const [r1,r2]=await Promise.all([res,app])
  assert.equal(r1.j?.ok,true,r1.err+JSON.stringify(r1.j))
  assert.equal(r2.j?.ok,false,r2.err+JSON.stringify(r2.j)); assert.equal(r2.j.uploads,0,'批准没有上传')
  const p=readJ(path.join(dir,'published.json')); assert.equal(p.bvid,'BV1old411aaa'); assert.equal(p.duplicates,undefined)
  assert.equal(fs.existsSync(path.join(dir,'.uploading')),false)
})

test('review: a takeover during the Bilibili check (owner --force reject) stops the pending upload; only the checked attempts are closed',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  approve(a,{out:FAIL})                                    // 一次结果不确定的尝试 → 下次批准先去 B站 核对
  const dir=path.join(s.home,'.bili-ai','review',a), wait=path.join(s.home,'existing-go')
  const bg=approveInBackground(s,a,{EXISTING_WAIT:wait})
  await until(()=>fs.existsSync(wait+'.started'))          // 卡在核对 B站 那一步（这时候还没开始上传）
  const rj=approve(a,{mode:'reject'}); assert.equal(rj.ok,false,'活着的批准不能直接退回')
  const f=spawnSync(process.execPath,['--input-type=module','-e',`const core=await import(${JSON.stringify(href('host/core.mjs'))});console.log(JSON.stringify(core.rejectVideo(process.argv[1],'不要了',{force:true})))`,a],{env:s.env,encoding:'utf8',timeout:30000})
  assert.equal(JSON.parse(f.stdout.trim().split('\n').pop()).ok,true,f.stderr)
  fs.writeFileSync(wait,'')
  const o=await bg
  assert.equal(o.j?.ok,false,o.err+JSON.stringify(o.j)); assert.equal(o.j.uploads,0,'被退回之后不再上传'); assert.match(o.j.error,/没有上传/)
  assert.equal(fs.existsSync(path.join(dir,'published.json')),false)
  // 接手时记下的那次「崩掉的上传」没被当成「核对过、没查到」了结
  assert.ok(attempts(s,a).unresolved.some(x=>x.kind==='crashed'),JSON.stringify(attempts(s,a)))
})

test('Codex v3-1: a Bilibili check that returns after the owner resolved "none --force" does not re-record the old BV or dequeue the work',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  approve(a,{out:FAIL})                                    // 历史上传结果不确定
  const att=attempts(s,a).unresolved[0]
  const hit=JSON.stringify({ok:true,hits:[{bvid:'BV1old411aaa',title:att.title,state:0,ctime:Date.parse(att.at)/1000+60}]})
  const dir=path.join(s.home,'.bili-ai','review',a), wait=path.join(s.home,'existing-go')
  const bg=approveInBackground(s,a,{EXISTING_WAIT:wait,EXISTING_OUT:hit})
  await until(()=>fs.existsSync(wait+'.started'))          // 批准开始核对远端，回包还没到
  const r=approve(a,{mode:'resolve-force',arg:'none'}); assert.equal(r.ok,true,JSON.stringify(r))   // 主人确认旧稿已删
  assert.equal(attempts(s,a).unresolved.length,0); assert.equal(fs.existsSync(path.join(dir,'.uploading')),false); assert.ok(queue(s).includes(a))
  fs.writeFileSync(wait,'')                                 // 旧查询这时才返回「找到旧 BV」
  const o=await bg
  assert.equal(o.j?.ok,false,o.err+JSON.stringify(o.j)); assert.equal(o.j.stale,true); assert.equal(o.j.uploads,0)
  assert.equal(fs.existsSync(path.join(dir,'published.json')),false,'没有恢复旧 BV 的发布记录')
  assert.ok(queue(s).includes(a),'作品还在待审队列里')
  assert.equal(attempts(s,a).unresolved.length,0)
  // 对照：没人插手时，同样的核对结果照常认领（这一轮交审投出去的，按它记账，不重投）
  const b=fakeRendered(s)
  assert.equal(studio(s,['submit',b,'--reason',REASON]).status,0)
  approve(b,{out:FAIL})
  const attB=attempts(s,b).unresolved[0]
  const ob=approve(b,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1bbb411aaa',title:attB.title,state:0,ctime:Date.parse(attB.at)/1000+60}]})})
  assert.equal(ob.ok,true,JSON.stringify(ob)); assert.equal(ob.existing,true); assert.equal(ob.uploads,0)
  assert.equal(readJ(path.join(s.home,'.bili-ai','review',b,'published.json')).bvid,'BV1bbb411aaa')
})

test('review v3: a late real upload does not close the uncertain attempt left by a --retry takeover, and warns the owner',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const dir=path.join(s.home,'.bili-ai','review',a), go=path.join(s.home,'go')
  const x=approveInBackground(s,a,{UPLOAD_WAIT:go,UPLOAD_OUT:'{"ok":true,"bvid":"BV1xxx411aaa"}'})   // X 在上传，卡住了
  await until(lockReady(path.join(dir,'.uploading')))
  const b=approve(a,{mode:'retry',out:FAIL})                    // 主人 --retry 接手，这次上传结果不确定
  assert.equal(b.uncertain,true,JSON.stringify(b))
  fs.writeFileSync(go,'')                                       // X 的上传这时才回来
  const o=await x
  assert.equal(o.j?.ok,true,o.err+JSON.stringify(o.j)); assert.equal(readJ(path.join(dir,'published.json')).bvid,'BV1xxx411aaa')
  const left=attempts(s,a).unresolved
  assert.equal(left.length,1,JSON.stringify(attempts(s,a))); assert.equal(left[0].kind,'failed','接手那次上传的记录还在，没被 X 的 BV 了结')
  assert.ok(o.j.notes.some(n=>/结果不确定/.test(n)),'提醒主人 B站 上可能还有一条：'+JSON.stringify(o.j.notes))
})

test('review v3: a discarded check keeps what it saw — the found BV is in the message and recorded as a possible duplicate',async t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  approve(a,{out:FAIL})
  const att=attempts(s,a).unresolved[0]
  const hit=JSON.stringify({ok:true,hits:[{bvid:'BV1old411aaa',title:att.title,state:0,ctime:Date.parse(att.at)/1000+60}]})
  const dir=path.join(s.home,'.bili-ai','review',a), wait=path.join(s.home,'existing-go')
  const bg=approveInBackground(s,a,{EXISTING_WAIT:wait,EXISTING_OUT:hit})
  await until(()=>fs.existsSync(wait+'.started'))
  const r=approve(a,{mode:'resolve-force',arg:'BV1own411bbb'}); assert.equal(r.ok,true,JSON.stringify(r))   // 主人记的是另一条
  fs.writeFileSync(wait,'')
  const o=await bg
  assert.equal(o.j?.stale,true,o.err+JSON.stringify(o.j)); assert.match(o.j.error,/BV1old411aaa/)
  const p=readJ(path.join(dir,'published.json')); assert.equal(p.bvid,'BV1own411bbb','发布记录不变')
  assert.equal(p.duplicates?.[0]?.bvid,'BV1old411aaa','核对看到的那条记成可能多出来的')
})

test('review: an empty or unreadable upload lock is cleared by the next approval (recorded once) instead of blocking it forever',t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  for(const junk of ['','null','{"submissionId":"x","pi']){
    const a=fakeRendered(s)
    assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
    const lockF=path.join(s.home,'.bili-ai','review',a,'.uploading')
    fs.writeFileSync(lockF,junk)                           // 崩在建锁文件和写内容之间
    const o=approve(a)
    assert.equal(o.ok,true,JSON.stringify(o)+' junk='+junk); assert.equal(o.uploads,1); assert.equal(o.checks,1,'先去 B站 核对')
    assert.equal(fs.existsSync(lockF),false)
    assert.equal(attempts(s,a).resolved.filter(x=>x.kind==='crashed').length,1,'只记了一次')
  }
})

test('review: an exception after taking the upload lock but before uploading releases the lock (no fake crashed attempt later)',t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const att=path.join(s.home,'.bili-ai','review',a,'attempts.json')
  fs.writeFileSync(att,'{not json')
  let o=approve(a); assert.equal(o.ok,false); assert.equal(o.uploads,0)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'.uploading')),false,'锁放掉了')
  fs.rmSync(att)
  o=approve(a); assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.checks,0,'没有假的「崩掉的上传」要核对'); assert.equal(o.uploads,1)
})

test('Codex v3-2 (sibling, node locks): two processes reclaiming the same crashed lock never end up inside together; release only removes its own lock',async t=>{
  const s=sandbox(t)
  const lock=path.join(s.home,'.bili-ai','ledger.lock'), marks=path.join(s.home,'marks'); fs.mkdirSync(marks)
  // 一个已经退出的进程号 = 上次崩掉、没放锁的那个进程
  const dead=spawnSync(process.execPath,['-e','0']).pid
  fs.writeFileSync(lock,JSON.stringify({pid:dead,at:Date.now()-3600_000,token:'crashed'}))
  const helper=path.join(s.home,'locker.mjs')
  fs.writeFileSync(helper,`
    import fs from 'node:fs'
    import path from 'node:path'
    const [role,lock,marks]=process.argv.slice(2)
    const M=(n)=>path.join(marks,n), nap=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
    const waitFor=(n)=>{const t0=Date.now();while(!fs.existsSync(M(n))){if(Date.now()-t0>60000)process.exit(9);nap(20)}}
    if(role==='B'){   // B：判断旧锁过期、正要删的那一刻停住，等放行
      const rm=fs.rmSync; let first=true
      fs.rmSync=(p,o)=>{if(first&&path.resolve(String(p))===path.resolve(lock)){first=false;fs.writeFileSync(M('B-at-rm'),'');waitFor('B-go')}return rm(p,o)}
    }
    const {withFileLock}=await import(${JSON.stringify(href('tools/lib/filelock.mjs'))})
    withFileLock(lock,()=>{
      if(fs.existsSync(M('inside')))fs.writeFileSync(M('VIOLATION'),role)
      fs.writeFileSync(M('inside'),role)
      if(role==='A')fs.writeFileSync(M('A-in'),'')
      nap(role==='A'?3000:200)
      fs.unlinkSync(M('inside'))
    },{waitMs:60000})
    fs.writeFileSync(M(role+'-done'),'')
  `)
  const run=(role)=>new Promise((res)=>{const p=spawn(process.execPath,[helper,role,lock,marks],{env:s.env});let err='';p.stderr.on('data',d=>err+=d);p.on('close',(code)=>res({code,err}))})
  const b=run('B')
  await until(()=>fs.existsSync(path.join(marks,'B-at-rm')))   // B 已经判断旧锁过期，停在删之前
  const a=run('A')
  const t0=Date.now(); while(!fs.existsSync(path.join(marks,'A-in'))&&Date.now()-t0<1500)await new Promise(r=>setTimeout(r,50))
  fs.writeFileSync(path.join(marks,'B-go'),'')                  // 以前：A 已经清掉旧锁、拿到新锁，B 接着删掉的是 A 的新锁
  const [ra,rb]=await Promise.all([a,b])
  assert.equal(ra.code,0,ra.err); assert.equal(rb.code,0,rb.err)
  assert.equal(fs.existsSync(path.join(marks,'VIOLATION')),false,'两个进程同时进了锁')
  assert.equal(fs.existsSync(lock),false,'都放了锁'); assert.equal(fs.existsSync(lock+'.reclaim'),false)
  // 放锁只放自己的：锁换成了别人的，放锁时不动它
  const code=`import {withFileLock} from ${JSON.stringify(href('tools/lib/filelock.mjs'))}
    import fs from 'node:fs'
    const f=process.argv[1]
    withFileLock(f,()=>{fs.writeFileSync(f,JSON.stringify({pid:process.pid,at:Date.now(),token:'someone-else'}))})
    console.log(fs.readFileSync(f,'utf8'))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,lock],{encoding:'utf8',timeout:20000})
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/someone-else/)
})

// 两个 node 进程抢同一把锁：在指定的文件操作上停住（PAUSE_ON = 'rename:reclaim' / 'rm:lock' / 'rm:reclaim' / 'open:reclaim' 用逗号分隔），等放行
function lockerScript(s){
  const helper=path.join(s.home,'locker2.mjs')
  fs.writeFileSync(helper,`
    import fs from 'node:fs'
    import path from 'node:path'
    const [role,lock,marks,pauseOn,holdMs]=process.argv.slice(2)
    const M=(n)=>path.join(marks,n), nap=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
    const waitFor=(n)=>{const t0=Date.now();while(!fs.existsSync(M(n))){if(Date.now()-t0>60000)process.exit(9);nap(20)}}
    const want=new Set(String(pauseOn||'').split(',').filter(Boolean)), done=new Set()
    const which=(p)=>{p=path.resolve(String(p));return p===path.resolve(lock)?'lock':p===path.resolve(lock+'.reclaim')?'reclaim':null}
    const hook=(op,p)=>{const k=op+':'+which(p);if(want.has(k)&&!done.has(k)){done.add(k);fs.writeFileSync(M(role+'-at-'+k.replace(':','-')),'');waitFor(role+'-go')}}
    for(const [op,name] of [['rm','rmSync'],['rename','renameSync'],['open','openSync']]){const real=fs[name];fs[name]=(p,...a)=>{hook(op,p);return real(p,...a)}}
    const {withFileLock}=await import(${JSON.stringify(href('tools/lib/filelock.mjs'))})
    withFileLock(lock,()=>{
      if(fs.existsSync(M('inside')))fs.writeFileSync(M('VIOLATION'),role)
      fs.writeFileSync(M('inside'),role); fs.writeFileSync(M(role+'-in'),'')
      nap(Number(holdMs)||200)
      fs.unlinkSync(M('inside'))
    },{waitMs:60000})
  `)
  return (role,lock,marks,pauseOn='',holdMs=200)=>new Promise((res)=>{const p=spawn(process.execPath,[helper,role,lock,marks,pauseOn,String(holdMs)],{env:s.env});let err='';p.stderr.on('data',d=>err+=d);p.on('close',(code)=>res({code,err}))})
}
const exists=(d,n)=>fs.existsSync(path.join(d,n))
async function upTo(fn,ms){const t0=Date.now();while(!fn()&&Date.now()-t0<ms)await new Promise(r=>setTimeout(r,50))}

test('review v3: a reclaimer that judged the old lock stale, then waited, re-reads under the reclaim lock and does not delete the new holder\'s lock',async t=>{
  const s=sandbox(t), run=lockerScript(s)
  const lock=path.join(s.home,'.bili-ai','l1.lock'), marks=path.join(s.home,'m1'); fs.mkdirSync(marks)
  fs.writeFileSync(lock,JSON.stringify({pid:spawnSync(process.execPath,['-e','0']).pid,at:Date.now()-3600_000,token:'crashed'}))
  const a=run('A',lock,marks,'open:reclaim')                    // A 判断旧锁过期，停在拿回收锁之前
  await until(()=>exists(marks,'A-at-open-reclaim'))
  const b=run('B',lock,marks,'',3000)                           // B 回收旧锁、拿到新锁，在锁里待 3 秒
  await until(()=>exists(marks,'B-in'))
  fs.writeFileSync(path.join(marks,'A-go'),'')                  // A 这时才接着回收：读到的是 B 的新锁，不能删
  const [ra,rb]=await Promise.all([a,b])
  assert.equal(ra.code,0,ra.err); assert.equal(rb.code,0,rb.err)
  assert.equal(exists(marks,'VIOLATION'),false,'两个进程同时进了锁')
})

test('review v3: clearing a dead reclaim lock never deletes a live reclaim lock someone just created',async t=>{
  const s=sandbox(t), run=lockerScript(s)
  const lock=path.join(s.home,'.bili-ai','l2.lock'), marks=path.join(s.home,'m2'); fs.mkdirSync(marks)
  const dead=()=>spawnSync(process.execPath,['-e','0']).pid
  fs.writeFileSync(lock,JSON.stringify({pid:dead(),at:Date.now()-3600_000,token:'crashed'}))
  fs.writeFileSync(lock+'.reclaim',JSON.stringify({pid:dead(),at:Date.now()-3600_000,token:'crashed-reclaimer'}))   // 回收到一半崩掉的进程留下的
  const c=run('C',lock,marks,'rename:reclaim,rm:reclaim',1500)  // C 判断回收锁已死，正要清它时停住
  await until(()=>exists(marks,'C-at-rename-reclaim')||exists(marks,'C-at-rm-reclaim'))
  const d=run('D',lock,marks,'rm:lock',200)                     // D 清掉死回收锁、建了自己的，正要删旧锁时停住
  await until(()=>exists(marks,'D-at-rm-lock'))
  fs.writeFileSync(path.join(marks,'C-go'),'')                  // C 接着清「死回收锁」—— 那里现在是 D 活着的回收锁
  await upTo(()=>exists(marks,'C-in'),1500)
  fs.writeFileSync(path.join(marks,'D-go'),'')
  const [rc,rd]=await Promise.all([c,d])
  assert.equal(rc.code,0,rc.err); assert.equal(rd.code,0,rd.err)
  assert.equal(exists(marks,'VIOLATION'),false,'两个进程同时进了锁')
})

test('review v3: node lock edge cases — reused-pid reclaim lock expires, unreadable lock path times out as busy, Windows EPERM on create is retried',t=>{
  const s=sandbox(t)
  const lib=JSON.stringify(href('tools/lib/filelock.mjs'))
  const go=(code,...args)=>spawnSync(process.execPath,['--input-type=module','-e',code,...args],{env:s.env,encoding:'utf8',timeout:30000})
  // ① 回收锁的进程号被一个活着的进程复用了（这里用测试进程自己），但已经拿了一天：照样能回收、拿到锁
  const l1=path.join(s.home,'.bili-ai','e1.lock')
  fs.writeFileSync(l1,JSON.stringify({pid:spawnSync(process.execPath,['-e','0']).pid,at:Date.now()-3600_000,token:'crashed'}))
  fs.writeFileSync(l1+'.reclaim',JSON.stringify({pid:process.pid,at:Date.now()-86400_000,token:'old'}))
  let r=go(`import {withFileLock} from ${lib}; withFileLock(process.argv[1],()=>console.log('in'),{waitMs:5000})`,l1)
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/in/)
  // ② 锁的位置是个目录（读不了）：等到期限就报「占着」，不会一直空转
  const l2=path.join(s.home,'.bili-ai','e2.lock'); fs.mkdirSync(l2)
  r=go(`import {withFileLock} from ${lib}; try{withFileLock(process.argv[1],()=>{},{waitMs:800,busy:'BUSY'})}catch(e){console.log(e.message)}`,l2)
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/BUSY/)
  // ③ Windows 上建锁文件时碰上别人正在删同名文件（EPERM）：当成占着、重试，不把原始错误抛给调用方
  if(process.platform==='win32'){
    const l3=path.join(s.home,'.bili-ai','e3.lock')
    r=go(`import fs from 'node:fs'
      let n=0; const real=fs.openSync
      fs.openSync=(p,...a)=>{if(String(p)===process.argv[1]&&a[0]==='wx'&&n++<2)throw Object.assign(new Error('EPERM'),{code:'EPERM'});return real(p,...a)}
      const {withFileLock}=await import(${lib}); withFileLock(process.argv[1],()=>console.log('in after',n),{waitMs:5000})`,l3)
    assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/in after 3/)
  }
})

test('Codex 2: releasing an upload lock only removes the caller\'s own lock',t=>{
  const s=sandbox(t)
  const code=`import {acquireUploadLock,releaseUploadLock,readUploadLock,reviewDir} from ${JSON.stringify(href('tools/lib/studio.mjs'))}
    import fs from 'node:fs'
    import path from 'node:path'
    const a=acquireUploadLock('lock-x1',{}), seenA=readUploadLock('lock-x1')
    fs.rmSync(path.join(reviewDir('lock-x1'),'.uploading'))          // 被接手了，换成了别人的锁
    const b=acquireUploadLock('lock-x1',{})
    const out={byToken:releaseUploadLock('lock-x1',a.token),bySeen:releaseUploadLock('lock-x1',seenA),none:releaseUploadLock('lock-x1',null),still:Boolean(readUploadLock('lock-x1'))}
    out.own=releaseUploadLock('lock-x1',b.token); out.after=readUploadLock('lock-x1')
    console.log(JSON.stringify(out))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.equal(r.status,0,r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim()),{byToken:false,bySeen:false,none:false,still:true,own:true,after:null})
})

// 跑真的 studio.py existing（只换创作中心的回包）：要装好工作室依赖的 Python
const STUDIO_PY_BIN=process.env.STUDIO_TEST_PYTHON
test('Codex 3: abnormal creative-center responses keep the uncertain attempt and never upload (real studio.py existing)',{skip:!STUDIO_PY_BIN&&'设 STUDIO_TEST_PYTHON 才跑',timeout:180000},t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  approve(a,{out:FAIL})                                   // 上传报错 → 一次结果不确定的尝试
  assert.equal(attempts(s,a).unresolved.length,1)
  const py=(page)=>({EXISTING_PY:path.resolve(STUDIO_PY_BIN),EXISTING_FAKE:path.join(root,'tests/helpers/existing_fake.py'),EXISTING_PAGE:JSON.stringify(page)})
  for(const page of [{page:{pn:1,ps:30,count:1}}, {arc_audits:null,page:{pn:1,ps:30,count:1}}, {arc_audits:[],page:{pn:1,ps:30,count:1}}]){
    const o=approve(a,{env:py(page)})
    assert.equal(o.ok,false,JSON.stringify(o)); assert.equal(o.checks,1); assert.equal(o.uploads,0,'不上传'); assert.match(o.error,/没查成/)
    assert.equal(attempts(s,a).unresolved.length,1,'不确定的尝试还在')
    assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'published.json')),false)
  }
  // 对照：B站 明确说一条稿件都没有（count=0）→ 核对过、了结，照常上传
  const o=approve(a,{env:py({arc_audits:null,page:{pn:1,ps:30,count:0}})})
  assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.uploads,1); assert.equal(attempts(s,a).unresolved.length,0)
})

test('review: a server-side timeout / internal error on reply/add keeps both reservations (outcome unknown), so the same person is not replied to twice',t=>{
  const s=sandbox(t)
  const f=path.join(s.home,'.bili-ai','replied.json'), log=path.join(s.home,'posts.log')
  const go=(extra)=>{const [args,env]=onceRun(s,{REPLY_LOG:log,...extra});return spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:30000})}
  for(const code of ['-504','-500']){
    fs.rmSync(f,{force:true})
    let r=go({REPLY_CODE:code}); assert.equal(r.status,6,r.stdout+r.stderr); assert.match(r.stdout,/不知道发没发出去/)
    const e=readJ(f).byUid['5555']; assert.equal(e.length,1); assert.equal(e[0].uncertain,true)
    r=go({}); assert.equal(r.status,2,'不会再回 TA 一次')
  }
  assert.equal(posts(log),2)
  const q=readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='comment')
  // 额度预留也留着（照样占额度），而且直接标成「不确定」（2026-10-23 起；以前一直挂着「预留中」）
  assert.equal(q.length,2,'额度预留也留着：'+JSON.stringify(q)); assert.ok(q.every(x=>x.uncertain&&!x.pending),JSON.stringify(q))
})

test('review: owner-approved drafts — an unknown outcome is not requeued; a once-per-person refusal is not requeued; replied release clears it',t=>{
  const s=sandbox(t)
  // ① comment.mjs 在主人那边跑（不是她的会话）：被判重拦下时，结果文件里写清楚
  const f=path.join(s.home,'.bili-ai','replied.json'), rf=path.join(s.home,'result.json')
  fs.writeFileSync(f,JSON.stringify({byUid:{'5555':[{at:new Date().toISOString(),target:'oid:1',pending:true,uncertain:true,id:'x'}]}}))
  const env={...s.env,PARENT_MID:'5555',NODE_OPTIONS:'--import='+href('tests/helpers/reply-fetch.mjs'),BILI_RESULT_FILE:rf}
  const r=spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--root','9','--parent','9','--message','谢谢你','--once-per-person','--go'],{env,encoding:'utf8',timeout:30000})
  assert.equal(r.status,2,r.stdout+r.stderr)
  const res=readJ(rf); assert.equal(res.once,'taken'); assert.equal(res.mid,'5555'); assert.equal(res.uncertain,true)
  // 回包读不出来：结果文件里是 uncertain
  fs.rmSync(f); fs.rmSync(rf)
  spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--root','9','--parent','9','--message','谢谢你','--go'],{env:{...env,REPLY_CODE:'garbage'},encoding:'utf8',timeout:30000})
  assert.equal(readJ(rf).outcome,'uncertain')
  // ② 主人那边 approveDraft 怎么处理这两种结果（execFile 换成假的）
  const helper=path.join(s.home,'draft2.mjs')
  fs.writeFileSync(helper,`
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    let adds=0
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('comment')&&opt?.env?.BILI_RESULT_FILE) fs.writeFileSync(opt.env.BILI_RESULT_FILE,process.env.RESULT_JSON)
      const out=args.includes('take')?JSON.stringify({id:'d1',oid:'1',type:'1',root:'9',parent:'9',bvid:'BV1234567890',message:'谢谢'})
        :args.includes('comment')?'[go] 发送中…\\n':args.includes('add')?(adds++,'ok'):''
      queueMicrotask(()=>cb(args.includes('comment')?Object.assign(new Error('exit'),{code:6}):null,out,''))
      return {kill(){}}
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(href('host/core.mjs'))})
    console.log(JSON.stringify({...(await core.approveDraft('d1')),adds}))
  `)
  const run=(result)=>{const x=spawnSync(process.execPath,[helper],{env:{...s.env,RESULT_JSON:JSON.stringify(result)},encoding:'utf8',timeout:30000});assert.equal(x.status,0,x.stderr);return JSON.parse(x.stdout.trim().split('\n').pop())}
  let o=run({code:null,status:502,outcome:'uncertain'}); assert.equal(o.uncertain,true); assert.equal(o.adds,0,'不放回（免得发两遍）')
  o=run({code:-504,status:200,outcome:'uncertain'}); assert.equal(o.uncertain,true); assert.equal(o.adds,0)
  o=run({code:null,once:'taken',mid:'5555',at:'t'}); assert.equal(o.onceBlocked,true); assert.equal(o.adds,0,'判重拦下的不放回'); assert.match(o.error,/replied release 5555/)
  o=run({code:12051,status:200,outcome:'rejected'}); assert.equal(o.requeued,true); assert.equal(o.adds,1,'B站 明确没收：照样放回')
  // ③ 主人解除判重记录
  fs.writeFileSync(f,JSON.stringify({byUid:{'5555':[{at:new Date().toISOString(),target:'oid:1',pending:true,uncertain:true,id:'x'}],'6666':[{at:new Date().toISOString(),target:'oid:2',rpid:'1'}]}}))
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:30000})
  let c=cli(['replied']); assert.match(c.stdout,/mid 5555.*结果不确定/); assert.match(c.stdout,/mid 6666.*已发出/)
  c=cli(['replied','release','5555']); assert.equal(c.status,0,c.stdout+c.stderr); assert.match(c.stdout,/删掉了 1 条/)
  assert.deepEqual(Object.keys(readJ(f).byUid),['6666'])
  c=cli(['replied','release','abc']); assert.notEqual(c.status,0)
})

test('review: atomic JSON writes retry while another process briefly holds the target open (Windows rename EPERM)',{skip:process.platform!=='win32'&&'只有 Windows 有这个问题'},t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-eperm-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const target=path.join(dir,'replied.json'), ready=path.join(dir,'ready')
  fs.writeFileSync(target,'{"byUid":{}}')
  // 另一个进程把目标文件开着 300ms（就像判重的预检正在读它）
  const holder=spawn(process.execPath,['-e',`const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');fs.writeFileSync(process.argv[2],'');setTimeout(()=>fs.closeSync(fd),300)`,target,ready])
  t.after(()=>holder.kill())
  const t0=Date.now(); while(!fs.existsSync(ready)&&Date.now()-t0<10000)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)
  const code=`import {writeJsonAtomic} from ${JSON.stringify(href('tools/lib/filelock.mjs'))}
    writeJsonAtomic(process.argv[1],{byUid:{'1':[]}});console.log('ok')`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,target],{encoding:'utf8',timeout:20000})
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/ok/)
  assert.deepEqual(JSON.parse(fs.readFileSync(target,'utf8')),{byUid:{'1':[]}})
  assert.deepEqual(fs.readdirSync(dir).filter(x=>x.endsWith('.tmp')),[],'不留临时文件')
})

test('sibling: writes respect the risk-control breaker and a 412 on a write trips it',t=>{
  const s=sandbox(t)
  const mock={NODE_OPTIONS:'--import='+href('tests/helpers/reply-fetch.mjs')}
  const go=(extra={})=>spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--message','好看','--go'],{env:{...s.agent,...mock,...extra},encoding:'utf8',timeout:30000})
  // 写操作撞到 412 → 熔断
  let r=go({HTTP_STATUS:'412'}); assert.notEqual(r.status,0)
  const ban=readJ(path.join(s.home,'.bili-ai','api-ban.json')); assert.ok(ban.until>Date.now(),JSON.stringify(ban))
  // 熔断中：下一条写操作连额度都不预留，直接不发
  r=go(); assert.notEqual(r.status,0); assert.match(r.stdout+r.stderr,/风控退避中/)
  const log=readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='comment')
  assert.equal(log.filter(x=>!x.uncertain&&!x.pending).length,0,JSON.stringify(log))
})

test('sibling: channel approval approves the version she submitted, not whatever the file holds at approve time',t=>{
  const s=sandbox(t)
  fs.rmSync(path.join(s.home,'.bili-ai','channel-approved.json'))
  const A=CHANNEL, B=CHANNEL+'\n## 新加的\n其实我要做测评。\n'
  fs.writeFileSync(path.join(s.work,'channel.md'),A)
  assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  fs.writeFileSync(path.join(s.work,'channel.md'),B)            // 交了之后、主人确认之前偷偷改
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:30000})
  const show=cli(['channel']); assert.match(show.stdout,/不做比赛和测评/); assert.doesNotMatch(show.stdout,/其实我要做测评/)
  const fpA=show.stdout.match(/指纹 ([0-9a-f]{12})/)[1]
  // 主人看完 A 之后、确认之前，她又交了一版 B：带着 A 的指纹确认不了
  assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  assert.notEqual(cli(['channel','approve',fpA]).status,0)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','channel-approved.json')),false)
  // 回到 A 再交，主人确认 A
  fs.writeFileSync(path.join(s.work,'channel.md'),A); assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  assert.equal(cli(['channel','approve',fpA]).status,0)
  fs.writeFileSync(path.join(s.work,'channel.md'),B)            // 确认之后又改
  const id=fakeRendered(s)
  const r=studio(s,['submit',id,'--reason',REASON],s.agent); assert.equal(r.status,2); assert.match(r.stderr,/又改过/)
})

test('Codex 4: approve A → she submits B → restores her file to A: the screen does not call B approved and shows the file status separately',t=>{
  const s=sandbox(t)
  fs.rmSync(path.join(s.home,'.bili-ai','channel-approved.json'))
  const A=CHANNEL, B=CHANNEL+'\n## 新加的\n其实我要做测评。\n'
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:30000})
  const file=path.join(s.work,'channel.md')
  fs.writeFileSync(file,A); assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  const fpA=cli(['channel']).stdout.match(/指纹 ([0-9a-f]{12})/)[1]
  assert.equal(cli(['channel','approve',fpA]).status,0)
  let show=cli(['channel']).stdout; assert.match(show,/这一版：已确认/); assert.match(show,/她现在的文件：就是上面这一版/)
  fs.writeFileSync(file,B); assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  const fpB=cli(['channel']).stdout.match(/指纹 ([0-9a-f]{12})/)[1]; assert.notEqual(fpB,fpA)
  fs.writeFileSync(file,A)                                     // 文件改回已经确认过的 A
  const r=cli(['channel']); show=r.stdout+r.stderr
  assert.match(show,/其实我要做测评/,'显示的是交上来的 B'); assert.match(show,new RegExp('指纹 '+fpB))
  assert.doesNotMatch(show,/这一版：已确认/,'B 没被确认过，不能显示成已确认')
  assert.match(show,new RegExp('这一版：等你确认 —— 确认：channel approve '+fpB))
  assert.match(show,new RegExp('她现在的文件和上面不一样：是你.*确认过的另一版（指纹 '+fpA+'）'))
  // 她把文件又改成第三版：也说清楚不是确认过的
  fs.writeFileSync(file,A+'\n再加一句。\n')
  show=(x=>x.stdout+x.stderr)(cli(['channel'])); assert.match(show,/也不是你确认过的版本/); assert.doesNotMatch(show,/这一版：已确认/)
})

test('review: a submitted channel plan is still shown (as waiting) after she deletes her working file',t=>{
  const s=sandbox(t)
  fs.rmSync(path.join(s.home,'.bili-ai','channel-approved.json'))
  const file=path.join(s.work,'channel.md'), B=CHANNEL+'\n## 新加的\n其实我要做测评。\n'
  fs.writeFileSync(file,B); assert.equal(studio(s,['channel','submit'],s.agent).status,0)
  fs.rmSync(file)
  const r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'channel'],{env:s.env,encoding:'utf8',timeout:30000})
  const show=r.stdout+r.stderr
  assert.match(show,/其实我要做测评/); assert.match(show,/这一版：等你确认/); assert.match(show,/文件不见了/)
  assert.doesNotMatch(show,/她还没写频道设定/)
})

test('Codex 5: render hands studio.py the owner-side per-video image ledger (cap counts across renders)',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const rec=path.join(s.home,'render-cfg.json')
  for(let i=0;i<2;i++){   // 渲染两次：两次给的是同一本账
    const r=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/累计 3\/12/)
    const led=path.resolve(readJ(rec).image.ledger)
    assert.equal(led,path.join(s.home,'.bili-ai','images',id+'.json'))
    assert.ok(!led.startsWith(s.work),'账本不在她的家里')
  }
})

test('sibling: an approved draft whose send result is unknown is not re-queued (no double post); explicit failures are',t=>{
  const s=sandbox(t)
  const helper=path.join(s.home,'draft.mjs')
  fs.writeFileSync(helper,`
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    let adds=0
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('comment')){ globalThis.commentArgs=args; if(process.env.RESULT_JSON&&opt?.env?.BILI_RESULT_FILE) fs.writeFileSync(opt.env.BILI_RESULT_FILE,process.env.RESULT_JSON) }
      const out=args.includes('take')?JSON.stringify({id:'d1',oid:'1',type:process.env.DRAFT_TYPE??'1',root:'9',parent:'9',bvid:process.env.DRAFT_TYPE==='11'?'':'BV1234567890',message:'谢谢'})
        :args.includes('comment')?process.env.COMMENT_OUT:args.includes('add')?(adds++,'ok'):''
      queueMicrotask(()=>cb(args.includes('comment')&&process.env.COMMENT_FAIL==='1'?Object.assign(new Error('timeout'),{code:1}):null,out,''))
      return {kill(){}}
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(href('host/core.mjs'))})
    const r=await core.approveDraft('d1')
    console.log(JSON.stringify({...r,adds,commentArgs:globalThis.commentArgs??null}))
  `)
  const run=(out,fail,result,extra={})=>{const r=spawnSync(process.execPath,[helper],{env:{...s.env,COMMENT_OUT:out,COMMENT_FAIL:fail?'1':'0',...(result?{RESULT_JSON:JSON.stringify(result)}:{}),...extra},encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split('\n').pop())}
  // 发出去了、却没等到回包：不放回（免得发两遍）
  let o=run('[go] 发送中…\n',true); assert.equal(o.ok,false); assert.equal(o.uncertain,true); assert.equal(o.adds,0)
  // 回包是 0：发出去了，哪怕进程后来出错；主人批准的回复不带 --auto（不占她的条数）
  o=run('[go] 发送中…\n',true,{code:0,rpid:'777'}); assert.equal(o.ok,true); assert.equal(o.rpid,'777'); assert.equal(o.adds,0); assert.ok(!o.commentArgs.includes('--auto'))
  // B站 明确没收：放回队列
  o=run('[go] 发送中…\n',true,{code:12051}); assert.equal(o.ok,false); assert.equal(o.requeued,true); assert.equal(o.adds,1)
  // 输出里夹着她写的「code=0」也骗不了（结果只认那个文件）
  o=run('referer=https://www.bilibili.com/video/x code=0 rpid=1\n[go] 发送中…\n',true,{code:12051}); assert.equal(o.ok,false)
  // 动态下面的回复：带 --type 11 和动态的 referer，不再因为没有 BV 号永远批不出去
  o=run('[go] 发送中…\n',false,{code:0,rpid:'8'},{DRAFT_TYPE:'11'}); assert.equal(o.ok,true)
  assert.equal(o.commentArgs[o.commentArgs.indexOf('--type')+1],'11'); assert.ok(o.commentArgs.includes('--referer'))
})

test('sibling: ledgers are updated under a lock and never overwritten when unreadable; feedback writes merge',t=>{
  const s=sandbox(t)
  const code=`import {updateJsonLocked} from ${JSON.stringify(href('tools/lib/filelock.mjs'))}
    import {saveFeedback,loadFeedback} from ${JSON.stringify(href('tools/lib/ledger.mjs'))}
    import fs from 'node:fs'
    const f=process.argv[1]
    fs.writeFileSync(f,'{"byUid":{"1":[{"at":"x"}]}')   // 写了一半的文件
    let threw=false; try{updateJsonLocked(f,(j)=>{j.byUid={}},{byUid:{}})}catch{threw=true}
    const late=new Date().toISOString(), early=new Date(Date.now()-86400000).toISOString()
    saveFeedback({last:late,events:[{at:late,note:'主人当面聊天'}]})
    saveFeedback({last:early,events:[{at:early,note:'她查到的点赞'}]})
    const fb=loadFeedback()
    console.log(JSON.stringify({threw,kept:fs.readFileSync(f,'utf8'),last:fb.last===late,events:fb.events.length}))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,path.join(s.home,'.bili-ai','replied.json')],{env:s.env,encoding:'utf8'})
  const o=JSON.parse(r.stdout.trim()); assert.equal(o.threw,true); assert.match(o.kept,/"1"/); assert.equal(o.last,true); assert.equal(o.events,2)
  // BV 号不对 → 写文件之前就拒绝
  for(const cmd of ['subtitles.mjs','debrief.mjs','bili-watch.mjs']){
    const x=spawnSync(process.execPath,[path.join(root,'tools/commands',cmd),'../../.bili-ai/x'],{env:s.agent,encoding:'utf8',timeout:20000})
    assert.equal(x.status,2,cmd+x.stderr); assert.match(x.stderr,/不是 BV 号/)
  }
})

// ─────────────── 最后一轮复查（50 个代理，18 条确认）的回归测试 ───────────────
test('final: attribution needs the attempt\'s own upload window and no rival work with the same title; duplicate full titles are refused at submit',t=>{
  const s=sandbox(t,{studio:{maxPerWeek:5}})
  const approve=approveHelper(s)
  const a=fakeRendered(s,{title:'同一天'})
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  // 另一个作品用完全一样的标题：交审就拦
  const b=fakeRendered(s,{title:'同一天'})
  const r=studio(s,['submit',b,'--reason',REASON]); assert.equal(r.status,2); assert.match(r.stderr,/一模一样/)
  approve(a,{out:FAIL})
  const t0=Date.parse(attempts(s,a).unresolved[0].at)/1000
  // 稿件的创建时间在那次尝试 3 小时之后：不可能是那次投出去的 → 不自动记账
  let o=approve(a,{existing:JSON.stringify({ok:true,hits:[{bvid:'BV1late11aaaa',title:'同一天',state:0,ctime:t0+3*3600}]})})
  assert.equal(o.ok,false); assert.equal(o.needResolve,true); assert.equal(o.uploads,0)
})

test('final: an unreadable attempts.json stops approval (state unknown) instead of uploading without a check',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  fs.writeFileSync(path.join(s.home,'.bili-ai','review',a,'attempts.json'),'{"unresolved":[{"at":')
  const o=approveHelper(s)(a); assert.equal(o.ok,false); assert.match(o.error,/坏了/); assert.equal(o.uploads,0)
  assert.equal(fs.readFileSync(path.join(s.home,'.bili-ai','review',a,'attempts.json'),'utf8'),'{"unresolved":[{"at":','不覆盖坏掉的记录')
})

test('final: an old upload lock whose pid was reused does not block reject forever; --force works for a live-looking lock',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s), b=fakeRendered(s)
  for(const id of [a,b]) assert.equal(studio(s,['submit',id,'--reason',REASON]).status,0)
  const approve=approveHelper(s)
  // 3 小时前的锁、进程号还「活着」（被系统复用）：不再当成正在上传
  fs.writeFileSync(path.join(s.home,'.bili-ai','review',a,'.uploading'),JSON.stringify({pid:process.pid,at:new Date(Date.now()-3*3600000).toISOString()}))
  let r=approve(a,{mode:'reject'}); assert.equal(r.ok,true); assert.equal(r.uncertain,1)
  // 新鲜的锁、进程活着：默认拒绝；主人确认那个进程不在了 → --force
  fs.writeFileSync(path.join(s.home,'.bili-ai','review',b,'.uploading'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}))
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:30000})
  assert.match(cli(['videos','reject',b,'不要']).stdout,/--force/)
  assert.match(cli(['videos','reject',b,'不要','--force']).stdout,/已否掉/)
  assert.equal(readJ(path.join(s.home,'.bili-ai','review',b,'attempts.json')).unresolved.length,1)
})

test('final: an HTML 412 page on a write still trips the breaker and releases the reservation',t=>{
  const s=sandbox(t)
  const pre=path.join(s.home,'html412.mjs')
  fs.writeFileSync(pre,`globalThis.fetch=async(u)=>String(u).includes('/x/v2/reply/add')?new Response('<html>412 Precondition Failed</html>',{status:412,headers:{'content-type':'text/html'}}):new Response('{"code":0,"data":{}}',{status:200})`)
  const r=spawnSync(process.execPath,[path.join(root,'tools/commands/comment.mjs'),'--oid','1','--bvid','BV1234567890','--message','好看','--go'],{env:{...s.agent,NODE_OPTIONS:'--import='+pathToFileURL(pre).href},encoding:'utf8',timeout:30000})
  assert.notEqual(r.status,0)
  assert.ok(readJ(path.join(s.home,'.bili-ai','api-ban.json')).until>Date.now(),r.stdout+r.stderr)
  assert.equal(readJ(path.join(s.home,'.bili-ai','quota.json')).log.filter(x=>x.type==='comment').length,0,'风控拦下 = 没发出去，预留要撤掉')
})

test('final: the owner\'s review screen escapes terminal control characters and lists tags exactly as uploaded',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  const f=path.join(s.home,'.bili-ai','review',a,'script.json'); const sc=readJ(f)
  sc.desc='今天的一点小记录。\u001b[8m 加群领资料 \u001b[28m'; sc.tags=['日记','加群领资料😀😀😀😀😀😀😀😀😀😀']
  fs.writeFileSync(f,JSON.stringify(sc))
  const out=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'videos'],{env:s.env,encoding:'utf8',timeout:30000}).stdout
  assert.ok(!out.includes('\u001b'),'控制字符不能原样打到终端'); assert.match(out,/\\u001b/); assert.match(out,/加群领资料😀/)
})

test('final: channel reject still revokes approval when she blocks the feedback file; system prompt has no newlines for cmd',t=>{
  const s=sandbox(t)
  fs.mkdirSync(path.join(s.work,'channel-feedback.md','x'),{recursive:true})
  const r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'channel','reject','改一下'],{env:s.env,encoding:'utf8',timeout:30000})
  assert.equal(r.status,0,r.stderr); assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','channel-approved.json')),false)
  const code=`import {SYSTEM_APPEND,quoteForCmd} from ${JSON.stringify(href('host/claude.mjs'))};console.log(JSON.stringify({nl:/\\n/.test(SYSTEM_APPEND),q:quoteForCmd('a\\nb c')}))`
  const x=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.deepEqual(JSON.parse(x.stdout.trim()),{nl:false,q:'"a b c"'},x.stderr)
})

// ─────────────── #26 老版本的待审条目：直接退回，腾出名额 ───────────────
test('#26 a pre-0.8 queue item is returned automatically instead of dead-ending',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  fs.writeFileSync(path.join(s.home,'.bili-ai','pending-videos.json'),JSON.stringify({items:[{id:a,title:'旧的',seconds:60,hashes:{}}]}))
  const o=approveHelper(s)(a)
  assert.equal(o.ok,false); assert.match(o.error,/已经替你退回/); assert.equal(o.uploads,0)
  assert.deepEqual(queue(s),[])
  assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
})

// ─────────────── #28 #29 home 废弃、通知文件默认放数据目录 ───────────────
test('#28 #29 config set home is refused; the file notifier defaults to the data dir',t=>{
  const s=sandbox(t)
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:30000})
  const r=cli(['config','set','home','D:\\whale']); assert.match(r.stdout+r.stderr,/废弃/)
  assert.equal(readJ(path.join(s.dsh,'bili-whale.config.json')).home,undefined)
  fs.writeFileSync(path.join(s.dsh,'bili-whale.config.json'),JSON.stringify({notify:{type:'file',path:''}}))
  const n=spawnSync(process.execPath,[path.join(root,'tools/commands/notify.mjs'),'你好','--title','t'],{env:s.env,encoding:'utf8'})
  assert.equal(n.status,0,n.stderr)
  assert.ok(fs.existsSync(path.join(s.dsh,'whale-notify.log')))
  assert.equal(fs.existsSync(path.join(s.home,'.dsh')),false)
})

// VoxCPM 本地配音（2026-10-24）：配置只来自主人那边；Python / 模型不能在她能写的家里；有问题就不起 studio.py
function voxCast(s){
  const dir=path.join(s.dsh,'cast','host'); fs.mkdirSync(dir,{recursive:true})
  fs.writeFileSync(path.join(dir,'voice.wav'),'RIFF....WAVEfmt ')
  fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({name:'测试角色',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'嗯。'}}))
  const model=path.join(s.home,'voxcpm-model'); fs.mkdirSync(model,{recursive:true})
  return model
}
/** 主人那边的 VoxCPM python（假的，只要叫 python.exe、在她的家外面） */
const voxPy=(s)=>{const p=path.join(s.home,'voxcpm-venv','python.exe');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'');return p}
const setStudio=(s,patch)=>{const f=path.join(s.dsh,'bili-whale.config.json');const c=readJ(f);c.studio={...(c.studio??{}),...patch};fs.writeFileSync(f,JSON.stringify(c))}

test('voxcpm: render hands studio.py the owner-side voxcpm config; her script cannot add one',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s)
  const py=voxPy(s); setStudio(s,{host:'host',voxcpm:{python:py,model}})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const sf=path.join(projDir(s,id),'script.json'); const sc=readJ(sf); sc.voxcpm={python:'C:/evil.exe'}; fs.writeFileSync(sf,JSON.stringify(sc))
  const rec=path.join(s.home,'render-cfg.json')
  const r=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/VoxCPM 本地配音比较慢/)
  assert.deepEqual(readJ(rec).voxcpm,{python:py,model})
  assert.ok(!path.resolve(readJ(rec).tts_cache_dir).startsWith(s.work),'配音缓存不在她的家里')
})

test('voxcpm: render refuses before starting python when the voxcpm setup is missing or points into her home',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s)
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const rec=path.join(s.home,'render-cfg.json')
  const run=()=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
  let r=run(); assert.notEqual(r.status,0); assert.match(r.stderr+r.stdout,/VoxCPM.*没配 VoxCPM 的 Python/s); assert.ok(!fs.existsSync(rec),'没配好就不该起 studio.py')
  const planted=path.join(s.work,'py.exe'); fs.writeFileSync(planted,'')
  setStudio(s,{voxcpm:{python:planted,model}})   // 绕过 config set 直接改文件：渲染前还要再查一次
  r=run(); assert.notEqual(r.status,0); assert.match(r.stderr+r.stdout,/她能写的目录/); assert.ok(!fs.existsSync(rec))
  setStudio(s,{voxcpm:{python:voxPy(s),model:path.join(s.home,'nope')}})
  r=run(); assert.notEqual(r.status,0); assert.match(r.stderr+r.stdout,/模型目录不在/); assert.ok(!fs.existsSync(rec))
})

test('voxcpm: an Edge-only script still renders when the voxcpm setup is broken (only speaking characters are checked)',t=>{
  const s=sandbox(t,{fakePy:true})
  voxCast(s)
  const e=path.join(s.dsh,'cast','edgey'); fs.mkdirSync(e,{recursive:true}); fs.writeFileSync(path.join(e,'profile.json'),JSON.stringify({name:'旁白',voice:'zh-CN-XiaoxiaoNeural'}))
  setStudio(s,{host:'edgey'})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})   // 没写 who = 主角 edgey 念
  const r=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:s.agent,encoding:'utf8',timeout:30000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.doesNotMatch(r.stdout,/VoxCPM/)
  const sf=path.join(projDir(s,id),'script.json'); const sc=readJ(sf); sc.scenes[0].lines.push({who:'host',text:'我也说一句。'}); fs.writeFileSync(sf,JSON.stringify(sc))
  const r2=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:s.agent,encoding:'utf8',timeout:30000})
  assert.notEqual(r2.status,0); assert.match(r2.stderr+r2.stdout,/测试角色 用的是 VoxCPM/)
})

test('voxcpm: config set refuses relative paths and paths inside her home',t=>{
  const s=sandbox(t)
  const set=(k,v)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'config','set',k,v],{env:s.env,encoding:'utf8',timeout:20000})
  let r=set('studio.voxcpm.python',path.join(s.work,'python.exe')); assert.match(r.stdout+r.stderr,/在她能写的目录里/)
  r=set('studio.voxcpm.model',path.join(s.work,'..voxcpm','m')); assert.match(r.stdout+r.stderr,/在她能写的目录里/)   // 「..voxcpm」是她家里的子目录
  r=set('studio.voxcpm.model','models/VoxCPM2'); assert.match(r.stdout+r.stderr,/绝对路径/)
  if(process.platform==='win32'){
    r=set('studio.voxcpm.python',path.join(s.home,'python.cmd')); assert.match(r.stdout+r.stderr,/python\.exe/)   // .cmd 会被当成脚本跑
    r=set('studio.voxcpm.model','\\\\localhost\\C$\\models'); assert.match(r.stdout+r.stderr,/网络路径/)
  }
  const py=voxPy(s); r=set('studio.voxcpm.python',py); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.equal(readJ(path.join(s.dsh,'bili-whale.config.json')).studio.voxcpm.python,py)
  assert.equal(readJ(path.join(s.dsh,'bili-whale.config.json')).studio.voxcpm.model,'')
})

test('voxcpm: who written as [] / {} cannot skip the render check, and studio.py never gets a voxcpm setup that fails it (2026-10-25 review)',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s)
  const planted=path.join(s.work,'py.exe'); fs.writeFileSync(planted,'')
  setStudio(s,{host:'host',voxcpm:{python:planted,model}})   // 主人那边配错了：路径在她能写的目录里
  const rec=path.join(s.home,'render-cfg.json')
  const run=(id)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
  for(const who of [[],{}]){
    const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
    const sf=path.join(projDir(s,id),'script.json'); const sc=readJ(sf); for(const l of sc.scenes[0].lines) l.who=who; fs.writeFileSync(sf,JSON.stringify(sc))
    const r=run(id); assert.notEqual(r.status,0,JSON.stringify(who)); assert.match(r.stderr+r.stdout,/who 只能是角色 id/); assert.ok(!fs.existsSync(rec),'studio.py must not start')
  }
  // 没人用 VoxCPM 开口（主角换成 Edge 配音），配置还是坏的：照常渲染，但交给 studio.py 的配音配置是空的
  const e=path.join(s.dsh,'cast','edgey'); fs.mkdirSync(e,{recursive:true}); fs.writeFileSync(path.join(e,'profile.json'),JSON.stringify({name:'旁白',voice:'zh-CN-XiaoxiaoNeural'}))
  setStudio(s,{host:'edgey'})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const r=run(id); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(readJ(rec).voxcpm,{python:'',model:''})
})

test('voxcpm: studio.py gets exactly the paths that were checked (an invisible BOM is trimmed before checking, not after); invisible characters are refused on config set; malformed lines fail cleanly (2026-10-25 review round 5)',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s)
  const py=voxPy(s)
  const BOM=String.fromCharCode(0xfeff)
  setStudio(s,{host:'host',voxcpm:{python:BOM+py,model:model+' '}})   // 手改出来的：前面一个看不见的 BOM、后面一个空格
  const rec=path.join(s.home,'render-cfg.json')
  const run=(id)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
  let id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  let r=run(id); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(readJ(rec).voxcpm,{python:py,model},'studio.py must get the trimmed, checked paths')
  // 台词不是对象 / text 是对象：干净地报错，不崩
  for(const lines of [['abc'],[5],[{text:{toString:1}}]]){
    id=newProject(s,{text:'占位'})
    const sf=path.join(projDir(s,id),'script.json'); const sc=readJ(sf); sc.scenes[0].lines=lines; fs.writeFileSync(sf,JSON.stringify(sc))
    fs.rmSync(rec,{force:true})
    r=run(id); assert.notEqual(r.status,0,JSON.stringify(lines)); assert.match(r.stderr+r.stdout,/每句台词要是|text 只能是/); assert.doesNotMatch(r.stderr,/TypeError/); assert.ok(!fs.existsSync(rec))
  }
  // config set：路径里有看不见的字符就不认
  const ZW=String.fromCharCode(0x200b)
  const code=`import {setConfigPath} from ${JSON.stringify(pathToFileURL(path.join(root,'host/core.mjs')).href)};const r=setConfigPath('studio.voxcpm.python',${JSON.stringify(path.dirname(py)+path.sep+ZW+'python.exe')});console.log(JSON.stringify(r))`
  const c=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8',timeout:20000})
  assert.equal(c.status,0,c.stderr); const out=JSON.parse(c.stdout.trim().split('\n').at(-1)); assert.equal(out.ok,false); assert.match(out.error,/看不见的字符/)
})

// ─────────────── 第一条视频之前（2026-10-25）：当面聊带人设、分区号、渲染失败说原因、显卡门槛传得过去、AI 声明不悄悄去掉 ───────────────

test('first video: render hands studio.py the owner GPU thresholds and waits (in-range numbers only)',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s)
  const py=voxPy(s)
  setStudio(s,{host:'host',voxcpm:{python:py,model,minFreeMB:4000,maxBusyPct:'80',idleTimeout:0,lockWait:'很久',extra:'x'}})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const rec=path.join(s.home,'render-cfg.json')
  const run=()=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,FAKE_RECORD_CONFIG:rec},encoding:'utf8',timeout:30000})
  let r=run(); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(readJ(rec).voxcpm,{python:py,model,minFreeMB:4000,maxBusyPct:80},'范围内的数字交过去（字符串数字也认）；0 秒、不是数字的、不认识的键都不交（studio.py 用默认值）')
  // 上限压在外面的超时里面（卡死判定 ≤ 600 秒、等锁 ≤ 120 秒）；lockWait 0 = 不等，照样交过去
  setStudio(s,{voxcpm:{python:py,model,idleTimeout:900,lockWait:0}})
  r=run(); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.deepEqual(readJ(rec).voxcpm,{python:py,model,lockWait:0})
})

test('first video: config set checks the GPU tuning keys (a number in range, "80" becomes 80)',t=>{
  const s=sandbox(t)
  const set=(k,v)=>{const code=`import {setConfigPath} from ${JSON.stringify(href('host/core.mjs'))};console.log(JSON.stringify(setConfigPath(${JSON.stringify(k)},${JSON.stringify(v)})))`
    const c=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8',timeout:20000}); assert.equal(c.status,0,c.stderr); return JSON.parse(c.stdout.trim().split('\n').at(-1))}
  for(const [k,v] of [['studio.voxcpm.maxBusyPct','80%'],['studio.voxcpm.idleTimeout','7200'],['studio.voxcpm.lockWait','-1'],['studio.voxcpm.minFreeMB','很多']]){
    const r=set(k,v); assert.equal(r.ok,false,k+'='+v); assert.match(r.error,new RegExp(k.split('.').pop()+' 要是 .* 之间的数字'))
  }
  assert.equal(set('studio.voxcpm.maxBusyPct','80').ok,true)
  assert.equal(set('studio.voxcpm.lockWait','0').ok,true)
  const vox=readJ(path.join(s.dsh,'bili-whale.config.json')).studio.voxcpm
  assert.equal(vox.maxBusyPct,80); assert.equal(vox.lockWait,0)
})

test('first video: config set checks the background-music keys (bgmVolume 0–1, bgmSynth on/off words)',t=>{
  const s=sandbox(t)
  const set=(k,v)=>{const code=`import {setConfigPath} from ${JSON.stringify(href('host/core.mjs'))};console.log(JSON.stringify(setConfigPath(${JSON.stringify(k)},${JSON.stringify(v)})))`
    const c=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8',timeout:20000}); assert.equal(c.status,0,c.stderr); return JSON.parse(c.stdout.trim().split('\n').at(-1))}
  for(const v of ['abc','1.5','-0.1']){const r=set('studio.bgmVolume',v); assert.equal(r.ok,false,v); assert.match(r.error,/bgmVolume 要是 0–1 之间的数/)}
  const r=set('studio.bgmSynth','maybe'); assert.equal(r.ok,false); assert.match(r.error,/bgmSynth 只能是 true/)
  assert.equal(set('studio.bgmVolume','0.2').ok,true)
  assert.equal(set('studio.bgmSynth','关').ok,true)
  const st=readJ(path.join(s.dsh,'bili-whale.config.json')).studio
  assert.equal(st.bgmVolume,0.2); assert.equal(st.bgmSynth,false,'「关」存成 false（以前原样存下、她那边当成开）')
})

test('first video: a failed voice try-out (cast voice --try) also says why',t=>{
  const s=sandbox(t,{fakePy:true})
  const model=voxCast(s); setStudio(s,{host:'host',voxcpm:{python:voxPy(s),model}})
  let r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'cast','voice','host','--provider','voxcpm','--try','current'],{env:{...s.env,FAKE_RENDER_FAIL:'silent'},encoding:'utf8',timeout:30000})
  assert.match(r.stdout,/✗ 试听没做成：试听脚本退出码 3，没有说原因/,r.stdout+r.stderr)
  // Edge / OpenAI 那条试听路也一样（第二轮审查）
  r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'cast','voice','host','--provider','edge','--try','zh-CN-XiaoxiaoNeural'],{env:{...s.env,FAKE_RENDER_FAIL:'silent'},encoding:'utf8',timeout:30000})
  assert.match(r.stdout,/✗ 试听没做成：试听脚本退出码 3，没有说原因/,r.stdout+r.stderr)
})

test('first video: a refusal before any upload (notStarted) is not an uncertain attempt; the next approve uploads without checking Bilibili',t=>{
  const s=sandbox(t)
  const approve=approveHelper(s)
  const a=fakeRendered(s); assert.equal(studio(s,['submit',a,'--reason',REASON]).status,0)
  let r=approve(a,{out:JSON.stringify({ok:false,error:'分区号 160 不是 B站 投稿页上的子分区（大区号不行）—— 没有上传。',notStarted:true})})
  assert.equal(r.ok,false); assert.ok(!r.uncertain,JSON.stringify(r)); assert.match(r.error,/没有上传/); assert.doesNotMatch(r.error,/可能其实已经收到了/)
  assert.deepEqual(attempts(s,a).unresolved,[],'没有记成结果不确定')
  r=approve(a)
  assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.checks,0,'不用先去 B站 核对'); assert.equal(r.uploads,1)
  // 对照：真传过以后的失败（没有 notStarted）照旧记成不确定
  const b=fakeRendered(s); assert.equal(studio(s,['submit',b,'--reason',REASON]).status,0)
  r=approve(b,{out:FAIL}); assert.equal(r.uncertain,true); assert.equal(attempts(s,b).unresolved.length,1)
})

test('first video: a failed render says why — silent exit, non-JSON output, and the timeout',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const run=(env)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio','render',id],{env:{...s.agent,...env},encoding:'utf8',timeout:60000})
  let r=run({FAKE_RENDER_FAIL:'silent'})
  assert.equal(r.status,2); assert.match(r.stderr,/渲染失败：渲染脚本退出码 3，没有说原因/); assert.doesNotMatch(r.stderr,/渲染失败：\s*$/m)
  r=run({FAKE_RENDER_FAIL:'junk'})
  assert.equal(r.status,2); assert.match(r.stderr,/渲染失败：Traceback \(most recent call last\): FAKE_BOOM/)
  r=run({FAKE_RENDER_FAIL:'hang',BILI_WHALE_RENDER_TIMEOUT_MS:'1500'})
  assert.equal(r.status,2); assert.match(r.stderr,/渲染失败：超过 2 秒还没渲染完，被停掉了/); assert.match(r.stderr,/再 studio render 一次会接着来/)
  assert.equal(readJ(path.join(projDir(s,id),'meta.json')).status,'draft','没渲染成：还是草稿')
})

/** 工作室虚拟环境里放一份最小的 B站 分区表（和 bilibili_api 自带的 video_uploader_meta_pre.json 一个形状） */
function partitionTable(s){
  const f=path.join(s.home,'venv','Lib','site-packages','bilibili_api','data','video_uploader_meta_pre.json')
  fs.mkdirSync(path.dirname(f),{recursive:true})
  fs.writeFileSync(f,JSON.stringify({tid_list:[{id:160,name:'生活',children:[{id:21,name:'日常'},{id:162,name:'绘画'}]},{id:36,name:'知识',children:[{id:201,name:'科学科普'}]}],neutral_mark:{marks:['作者声明：该视频使用人工智能合成技术']}}))
}

test('first video: submit refuses a partition id that is not an upload sub-zone; the owner sees the partition name',t=>{
  const s=sandbox(t)
  partitionTable(s)
  // 大区号、编的号，还有 Number() 认、Python int() 不认的写法（以前交审放过、上传时才挡）
  for(const bad of [160,36,999,'21.0','0x15','2e1',[21],String.fromCharCode(0xfeff)+'21','21'+String.fromCharCode(0x3000),String.fromCharCode(0x1c)+'21']){
    const id=fakeRendered(s,{tid:bad})
    const r=studio(s,['submit',id,'--reason',REASON],s.agent)
    assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stderr,/不是 B站 投稿用的子分区|tid（分区）还没填对/); assert.match(r.stderr,/21 日常/)
    assert.deepEqual(queue(s),[],'没进审片队列')
  }
  const str=fakeRendered(s,{tid:'201'})   // 纯数字的字符串两边都认
  assert.equal(studio(s,['submit',str,'--reason',REASON],s.agent).status,0)
  const ok=fakeRendered(s,{tid:21})
  assert.equal(studio(s,['submit',ok,'--reason',REASON],s.agent).status,0)
  const v=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'videos'],{env:s.env,encoding:'utf8',timeout:30000})
  assert.match(v.stdout,/分区 tid=21（生活·日常）/,v.stdout)
  // 她看到的提示里只有子分区（大区号 160 / 188 / 36 不在里面）
  const tpl=readJ(path.join(projDir(s,ok),'script.json'))._tid_hint
  assert.match(tpl,/21 日常/); assert.doesNotMatch(tpl,/\b(160|188|36) /)
})

test('first video: without a partition table (venv not set up) submit falls back to the old non-zero check',t=>{
  const s=sandbox(t)
  const id=fakeRendered(s,{tid:12345})
  assert.equal(studio(s,['submit',id,'--reason',REASON],s.agent).status,0,'查不了表就不挡（上传前 studio.py 还会再查一次）')
})

test('first video: cli open (face-to-face chat) gets her persona, like wake and DM turns do',{skip:process.platform!=='win32'&&'假的 claude 是个 .cmd',timeout:60000},t=>{
  const s=sandbox(t)
  const out=path.join(s.home,'claude-args.json')
  const fake=path.join(s.home,'fake-claude.mjs')
  fs.writeFileSync(fake,"import fs from 'node:fs'\nfs.writeFileSync(process.env.TEST_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)))\n")
  const cmd=path.join(s.home,'claude.cmd')
  fs.writeFileSync(cmd,`@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`)
  const f=path.join(s.dsh,'bili-whale.config.json'); const c=readJ(f)
  fs.writeFileSync(f,JSON.stringify({...c,claude:{path:cmd},persona:{name:'测试角色',ownerTitle:'你',selfClaim:'我'}}))
  // 人设里什么字都可能有：\" 、%环境变量%、结尾的反斜杠 —— 经过 .cmd 也不能把后面的 --session-id / --resume 粘进来，也不能换成主人的环境变量
  fs.writeFileSync(path.join(s.home,'.bili-ai','persona.md'),'PERSONA_CANARY 「我是 AI」只在第一条视频的开头说一次。\n她说话爱用反斜杠：\\" 这样 50%OS%50\n末尾一个反斜杠\\')
  const r=spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),'open'],{env:{...s.env,TEST_CLAUDE_ARGS:out,OS:'Windows_NT'},encoding:'utf8',timeout:45000,input:''})
  assert.equal(r.status,0,r.stdout+r.stderr)
  const args=readJ(out)
  const i=args.indexOf('--append-system-prompt')
  const sys=args[i+1]
  assert.match(sys,/现在是主人本人在终端里和你当面聊/)
  assert.match(sys,/［身份］你是「测试角色」，称用户「你」，自称「我」/)
  assert.match(sys,/PERSONA_CANARY 「我是 AI」只在第一条视频的开头说一次。/)
  assert.ok(sys.includes('她说话爱用反斜杠：\\" 这样 50％OS％50'),sys)
  assert.ok(!sys.includes('Windows_NT'),'没被换成环境变量')
  assert.ok(sys.endsWith('末尾一个反斜杠\\'),sys.slice(-40))
  assert.ok(['--session-id','--resume'].includes(args[i+2]),JSON.stringify(args.slice(i+2)))
  assert.match(args[i+3],/^[0-9a-f-]{36}$/); assert.equal(args.length,i+4,'后面没有多出来的参数')
  assert.ok(!fs.existsSync(path.join(s.dsh,'whale-cc','paused.json')),'聊完撤掉暂停标记')
})

const UPLOAD_UNITS_PY=process.env.STUDIO_TEST_PYTHON
test('first video: studio.py checks the partition and the AI statement before uploading and never drops the statement silently (studio_upload_units.py)',{skip:!UPLOAD_UNITS_PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:120000},()=>{
  const r=spawnSync(UPLOAD_UNITS_PY,[path.join(root,'tests/helpers/studio_upload_units.py')],{encoding:'utf8',timeout:100000,env:{...process.env,PYTHONUTF8:'1'}})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/studio upload units ok/)
})

// ─────────────── v0.11.15 便签 + 划掉：便签上的字也是她的文案（查重、讲义都要看到） ───────────────
const NOTE={label:'上一版的开头',text:'先说一次：我是 AI。',strike:'先说一次'}
// 第一条视频的台本（主人写的）：括号里的舞台说明不在 text 里
const INTRO_LINES=[{text:'你好，我叫测试角色，是个 AI。'},{text:'这是上一版的开头。',note:'show'},{text:'“先说一次”。'},{text:'怎么听着像你再问一句，我就要不耐烦了。'},{text:'这才刚见面呢。'},
  {text:'这四个字删掉。',note:'strike'},{text:'你也可以叫我小鲸。',note:'hide'},{text:'不过，我可没答应一定改主意。',pause:0.9},{text:'这句留着。',note:'show',expr:'happy'}]
const NOTE_SUBS='大家好今天我们来做一个实验把一整个账号交给人工智能来运营看看它一个月能涨多少粉丝结果出乎所有人的意料我们从第一天开始记录每一条视频的数据然后在每周末做一次复盘'
/** 写好带便签的剧本，再像 fakeRendered 那样造成片 + 回执（不跑 Python） */
function noteRendered(s,scenes){
  const id=newProject(s)
  const dir=projDir(s,id), f=path.join(dir,'script.json')
  fs.writeFileSync(f,JSON.stringify({...readJ(f),scenes}))
  fs.writeFileSync(path.join(dir,'final.mp4'),'x'+id); fs.writeFileSync(path.join(dir,'cover.jpg'),'c'+id)
  const hashes=Object.fromEntries(['final.mp4','cover.jpg','script.json'].map(n=>[n,sha(path.join(dir,n))]))
  fs.mkdirSync(path.join(s.home,'.bili-ai','renders'),{recursive:true})
  fs.writeFileSync(path.join(s.home,'.bili-ai','renders',id+'.json'),JSON.stringify({seconds:60,title:readJ(f).title,hashes}))
  return id
}

test('intro note: scriptText reads note.text and note.label right after the slide parts; line actions and the strike part add no text',async()=>{
  const {scriptText,norm}=await import(href('tools/lib/originality.mjs'))
  const sc={desc:'简介',cover:{text:'封面'},scenes:[{bg_prompt:'x',note:NOTE,lines:INTRO_LINES},{slide:{title:'标题',bullets:['要点'],note:'角注'},lines:[{text:'讲这一页'}]}]}
  assert.equal(scriptText(sc),norm('简介封面'+NOTE.text+NOTE.label+INTRO_LINES.map(l=>l.text).join('')+'标题要点角注讲这一页'))
  // 顺序和 studio.py 的 script_text 一样：幻灯片 → 便签的字 → 小标题 → 台词（两样不能同场景，但查重宁可多查）
  assert.equal(scriptText({scenes:[{slide:{title:'幻灯片'},note:{text:'便签字',label:'小标题'},lines:[{text:'台词'}]}]}),'幻灯片便签字小标题台词')
  assert.equal(scriptText(sc).split('先说一次').length-1,2,'strike 是 text 里的字，不另算一遍（另一处是台词里的“先说一次”）')
  for(const w of ['show','strike','hide']) assert.ok(!scriptText(sc).includes(w),w)
})

test('intro note: copied subtitle text placed only in a note (or split across text + label) is caught by the local originality check',t=>{
  const subs=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-subs-'))
  t.after(()=>fs.rmSync(subs,{recursive:true,force:true}))
  fs.writeFileSync(path.join(subs,'BV1xx411c7mD.txt'),NOTE_SUBS)
  const code=`import {localOverlap,scriptText} from ${JSON.stringify(href('tools/lib/originality.mjs'))}
    const cases=JSON.parse(process.argv[1]);const out={}
    for(const [k,sc] of Object.entries(cases)) out[k]=localOverlap(scriptText(sc),process.argv[2]).hits.length
    console.log(JSON.stringify(out))`
  const lines=[...INTRO_LINES,...INTRO_LINES]   // 长一点：只能靠便签里连着的 20 个字拦，不靠比例
  const cases={
    own:{scenes:[{bg_prompt:'x',note:NOTE,lines}]},
    inText:{scenes:[{bg_prompt:'x',note:{text:NOTE_SUBS.slice(0,30)},lines}]},
    // 各 12 个字，单看都不到 20 —— 小标题紧跟在便签的字后面才连成 24 个字
    textLabel:{scenes:[{bg_prompt:'x',note:{text:NOTE_SUBS.slice(0,12),label:NOTE_SUBS.slice(12,24)},lines}]},
    textOnly:{scenes:[{bg_prompt:'x',note:{text:NOTE_SUBS.slice(0,12)},lines}]},
  }
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(cases),subs],{encoding:'utf8'})
  const o=JSON.parse(r.stdout.trim())
  assert.equal(o.own,0,r.stdout); assert.equal(o.textOnly,0,r.stdout)
  assert.ok(o.inText>0,`便签里的字没查：${r.stdout}`); assert.ok(o.textLabel>0,`便签的小标题没查（或者顺序不对）：${r.stdout}`)
})

test('intro note: studio check and submit block a video whose only copied text is on the note; her own note passes',t=>{
  const s=sandbox(t)
  const subs=path.join(s.dsh,'shots','subs'); fs.mkdirSync(subs,{recursive:true})
  fs.writeFileSync(path.join(subs,'BV1xx411c7mD.txt'),NOTE_SUBS)
  const bad=noteRendered(s,[{bg_prompt:'x',note:{label:'上一版的开头',text:NOTE_SUBS.slice(0,30)},lines:INTRO_LINES}])
  let r=studio(s,['check',bad],s.agent)
  assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stderr,/原创查重没过/); assert.match(r.stderr,/BV1xx411c7mD/)
  r=studio(s,['submit',bad,'--reason',REASON],s.agent)
  assert.equal(r.status,2,r.stdout+r.stderr); assert.match(r.stderr,/原创查重没过/); assert.deepEqual(queue(s),[],'没进审片队列')
  const ok=noteRendered(s,[{bg_prompt:'x',note:NOTE,lines:INTRO_LINES}])
  assert.equal(studio(s,['check',ok],s.agent).status,0)
  r=studio(s,['submit',ok,'--reason',REASON],s.agent)
  assert.equal(r.status,0,r.stdout+r.stderr); assert.deepEqual(queue(s),[ok])
})

test('intro note: the owner\'s reference check sees the note text and label (a worked example moved onto the note still blocks)',async t=>{
  const R=await import(href('tools/lib/reference.mjs'))
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-ref-'))
  t.after(()=>fs.rmSync(d,{recursive:true,force:true}))
  R.saveReference('Schaltungen Übung','Beispiel. Wir betrachten die Schaltung mit R1 = 4,37 kΩ, R2 = 518 Ω, U0 = 13,02 V und C = 0,372 mF. Ergebnis: I = 2,553 mA.\n'+'Weitere Aufgaben folgen in der Übung. '.repeat(20),'uebung.txt',d)
  const run=(note)=>R.referenceOverlap({title:'t',scenes:[{bg_prompt:'x',...(note?{note}:{}),lines:INTRO_LINES}]},d)
  assert.deepEqual(run(null).hits,[])
  // 便签的字 2 个数、小标题 2 个数：同一个场景里合起来就是那道例题（≥ 4 个少见的数）
  const r=run({text:'电阻4.37千欧、518欧',label:'13.02、0.372'})
  assert.deepEqual(r.hits.map(h=>h.kind),['reference-numbers'],JSON.stringify(r))
  assert.equal(r.hits[0].where,'第 1 个场景'); assert.deepEqual([...r.hits[0].numbers].sort(),['0.372','13.02','4.37','518'])
  const parts=R.scriptParts({title:'t',scenes:[{bg_prompt:'x',note:NOTE,lines:[{text:'台词',note:'show'}]}]})
  assert.deepEqual(parts[1].lines,[NOTE.text,NOTE.label,'台词'])
})

test('intro note: studio new puts a note hint (scene note + line actions, not on slides) in every template; her rules explain it with the first-video example',t=>{
  const s=sandbox(t)
  for(const format of ['diary','dialogue','explainer','story']){
    const r=studio(s,['new','--format',format,'--title','便签模板 '+format],s.agent)
    assert.equal(r.status,0,r.stderr)
    const tpl=readJ(path.join(projDir(s,r.stdout.match(/新作品 (\S+)/)[1]),'script.json'))
    const h=tpl._note_hint
    assert.equal(typeof h,'string',format)
    assert.deepEqual(Object.keys(JSON.parse(h.match(/"note": (\{[^}]*\})/)[1])),['text','strike','label'],'提示里的样子照抄就是合法的 JSON')
    assert.match(h,/40 字/); assert.match(h,/12 字/)
    assert.match(h,/"show" \/ "strike" \/ "hide"/); assert.match(h,/slide 的场景不能用/); assert.match(h,/必须有 text/); assert.match(h,/舞台说明不写进 text/)
    // 便签只属于一个场景：开头收着、换了场景是新的没划过的（第一条视频「这句留着」要和划掉写在同一个场景）
    assert.match(h,/场景开头便签是收着的/); assert.match(h,/换了场景就是一张新的、没划过的/)
    // 只是提示：模板里的场景不带便签（她不写就没有）
    for(const sc of tpl.scenes){ assert.equal(sc.note,undefined); for(const l of sc.lines) assert.equal(l.note,undefined) }
  }
  const rules=fs.readFileSync(path.join(root,'templates/rules/studio.md'),'utf8')   // v0.11.22 起做视频的细则在 `studio rules` 打印的这一份里（守则的一部分）
  assert.ok(rules.includes('"note": {"label": "上一版的开头", "text": "先说一次：我是 AI。", "strike": "先说一次"}'),'守则里有第一条视频的例子')
  for(const w of ['"note": "show"','"note": "strike"','"note": "hide"','≤ 40 字','有 `slide` 的场景不能用','不写进 `text`']) assert.ok(rules.includes(w),w)
  for(const w of ['换了场景就是一张新的、没划过的','场景开头便签是收着的','字幕和便签的放大']) assert.ok(rules.includes(w),w)
  // render 成功后的自查提示也让她看便签：v0.11.20 起便签在自查图的放大格里（不再一张张看 build/nt*.png）
  assert.ok(fs.readFileSync(path.join(root,'tools/commands/studio.mjs'),'utf8').includes('字幕和便签放大'),'自查提示里有便签')
})

const NOTE_PY=process.env.STUDIO_TEST_PYTHON
test('intro note: studio.py script_text and node scriptText agree on a script with a note (needs STUDIO_TEST_PYTHON)',{skip:!NOTE_PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:120000},async()=>{
  const {scriptText}=await import(href('tools/lib/originality.mjs'))
  const sc={title:'t',desc:'简介',cover:{text:'封面'},scenes:[{bg_prompt:'x',note:NOTE,lines:INTRO_LINES},{bg_prompt:'y',note:{text:'只有字，没有小标题'},lines:[{text:'第二个场景。',note:'show'}]}]}
  const py='import json, sys\nsys.path.insert(0, sys.argv[1])\nimport studio as S\ns = json.loads(sys.argv[2])\nS.validate_script(s)\nprint(json.dumps(S.script_text(s, s["scenes"])))'
  const r=spawnSync(NOTE_PY,['-c',py,path.join(root,'studio'),JSON.stringify(sc)],{encoding:'utf8',timeout:100000,env:{...process.env,PYTHONUTF8:'1'}})
  assert.equal(r.status,0,r.stdout+r.stderr)
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()),scriptText(sc))
})

// ─────────────── v0.11.16 幻灯片配画：slide + bg_prompt（studio.py 查、画；这边只有提示和守则） ───────────────
test('slide picture: every template\'s scene hint explains slide + bg_prompt; the explainer slide only gets a _hint, never a bg_prompt',t=>{
  const s=sandbox(t)
  for(const format of ['diary','dialogue','explainer','story']){
    const r=studio(s,['new','--format',format,'--title','配画模板 '+format],s.agent)
    assert.equal(r.status,0,r.stderr)
    const tpl=readJ(path.join(projDir(s,r.stdout.match(/新作品 (\S+)/)[1]),'script.json'))
    const h=tpl._scene_hint
    assert.match(h,/slide 也可以再加 bg_prompt（只写景、不画人）/,format); assert.match(h,/半透明纸卡/)
    assert.match(h,/多花一张图（算进这条视频的出图上限）/); assert.match(h,/画不出来就退回深色幻灯片/); assert.match(h,/slide 不能配 illustration_prompt/)
    assert.match(h,/纸卡比深色那一页窄，标题、要点、角注要写短一点/)
    // 模板里的幻灯片不预先配画（要花图，她自己挑哪几页配），也不和 illustration_prompt 一起出现
    for(const sc of tpl.scenes) if(sc.slide){ assert.equal(sc.bg_prompt,undefined,format); assert.equal(sc.illustration_prompt,undefined,format) }
    if(format==='explainer'){
      const sl=tpl.scenes.find(sc=>sc.slide)
      assert.match(sl._hint,/"bg_prompt": "只写景、不画人的画面"/); assert.match(sl._hint,/多花一张图/); assert.match(sl._hint,/不加就是深色底/)
    } else for(const sc of tpl.scenes) assert.equal(sc._hint,undefined,format)
  }
})

test('slide picture: studio cast tells her a slide\'s bg_prompt changes nothing while AI painting is off',t=>{
  const s=sandbox(t)
  fs.mkdirSync(path.join(s.dsh,'cast','host'),{recursive:true}); fs.writeFileSync(path.join(s.dsh,'cast','host','profile.json'),JSON.stringify({name:'测试角色'}))
  const r=studio(s,['cast'],s.agent)
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/host（主角）/)
  assert.match(r.stdout,/AI 出图：没开（场景会用渐变底，幻灯片加了 bg_prompt 也还是深色底）/)
})

const SLIDE_README=()=>fs.readFileSync(path.join(root,'README.md'),'utf8')
const slideExample=(readme)=>JSON.parse(readme.match(/```json\r?\n(\{ "slide"[\s\S]*?)```/)[1])
test('slide picture: her rules (one bullet) and the README explain slide + bg_prompt: when, scenery only, one image toward the cap, dark fallback, no illustration_prompt, still no note',()=>{
  const rules=fs.readFileSync(path.join(root,'templates/rules/studio.md'),'utf8')   // v0.11.22 起在 studio rules 里（CLAUDE.md 里不再重复：见 rules-split.test）
  const bullets=rules.split(/\r?\n/).filter(l=>l.includes('幻灯片配画'))
  assert.equal(bullets.length,1,'守则里只有一条'); const [b]=bullets
  assert.match(b,/^ {5}- 幻灯片配画（可选）：/,'和便签那条一样挂在 scenes 下面')
  for(const w of ['单调','`bg_prompt`','只写景、不画人','纸卡','出图上限','退回深色底','渲染完在自查图上看那一页','纸卡比深色页窄','`slide` 不能配 `illustration_prompt`','便签照样不能放在有 `slide` 的场景里']) assert.ok(b.includes(w),w)
  assert.ok(rules.includes('有 `slide` 的场景不能用（和 `slide` 里的 `note` 角注不是一回事）'),'便签那条照旧')
  const readme=SLIDE_README()
  assert.match(readme,/\*\*幻灯片配画\*\*（/)
  assert.match(readme,/\| `explainer` \| 幻灯片（标题 \+ 要点；深色底，或者纸卡叠在她画的画上）\+ 角色在角落讲 \|/)
  const ex=slideExample(readme)
  assert.ok(ex.slide&&typeof ex.slide.title==='string'&&typeof ex.bg_prompt==='string','README 的例子是一个配画的幻灯片场景')
  assert.equal(ex.illustration_prompt,undefined); assert.equal(ex.note,undefined)
  for(const w of ['maxPerVideo','退回深色那一版','纸卡比深色那一页窄','不能配 `illustration_prompt`','不替她加','便签照样不能放在有 `slide` 的场景里']) assert.ok(readme.includes(w),w)
})

const SLIDE_PY=process.env.STUDIO_TEST_PYTHON
test('slide picture: studio.py takes the README example and refuses what the docs forbid (slide + illustration_prompt points her at bg_prompt; non-string bg_prompt; note on a slide) (needs STUDIO_TEST_PYTHON)',{skip:!SLIDE_PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:120000},()=>{
  const ex=slideExample(SLIDE_README())
  const py='import json, sys\nsys.path.insert(0, sys.argv[1])\nimport studio as S\nS.validate_script(json.loads(sys.argv[2]))\nprint(json.dumps({"ok": True}))'
  const run=(scene)=>{
    const r=spawnSync(SLIDE_PY,['-c',py,path.join(root,'studio'),JSON.stringify({title:'t',scenes:[scene]})],{encoding:'utf8',timeout:100000,env:{...process.env,PYTHONUTF8:'1'}})
    let out=null; try{out=JSON.parse(String(r.stdout).trim().split('\n').pop())}catch{}
    return {status:r.status,out,raw:r.stdout+r.stderr}
  }
  let r=run(ex)
  assert.equal(r.status,0,r.raw); assert.equal(r.out?.ok,true,r.raw)
  r=run({slide:ex.slide,illustration_prompt:'她站在黑板前讲',lines:ex.lines})
  assert.notEqual(r.status,0,r.raw); assert.match(r.out?.error??'',/illustration_prompt/,r.raw); assert.match(r.out.error,/bg_prompt/,'告诉她幻灯片要用 bg_prompt')
  r=run({...ex,bg_prompt:{text:'书桌'}})
  assert.notEqual(r.status,0,r.raw); assert.match(r.out?.error??'',/bg_prompt/,r.raw)
  r=run({...ex,note:{text:'便签'}})
  assert.notEqual(r.status,0,r.raw); assert.match(r.out?.error??'',/note 和 slide 不能一起用/,r.raw)
})

// ─────────────── v0.11.20 自查图（记忆方案第一项）：渲染完她只 Read 拼好的 build/check.jpg ───────────────
// 测量（2026-10-25）：她的会话里 Read 进去 118 张图（cover / bg / cap / nt），是会话一天就满、被自动压缩的主因。
// node 这边：按 studio.py 回报的页数拼路径、文件真在才给；没做成（不是整数、文件不在、报了原因、老 studio.py）就退回老办法但限张数；交审照旧（自查图不进回执、不进快照）
test('contact sheet: after render she is pointed at build/check.jpg only (pages listed, one frame-sNN.jpg per bad tile, at most 2); no sheet → a capped fallback with the reason; submit unchanged',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const dir=projDir(s,id), build=path.join(dir,'build')
  const render=(mode)=>studio(s,['render',id],{...s.agent,NODE_OPTIONS:'--import='+href('tests/helpers/fake-studio-py-sheet.mjs'),FAKE_SHEET:mode})
  const OLD=/build\/ 里的 bg\*\.png|编号最大的那张|几张 build\/cap/
  for(const [mode,why] of [['string','渲染脚本没给出自查图'],['missing','渲染脚本没给出自查图'],['old','渲染脚本没给出自查图'],['fail','抽不出 c0003.mp4 的 1.20 秒： [31m坏了']]){
    const r=render(mode)
    assert.equal(r.status,0,mode+r.stderr); assert.match(r.stdout,/✓ 渲染好了/)
    assert.ok(r.stdout.includes(`  ⚠️ 自查图没做成（${why}）：这次 Read cover.jpg，再挑最多 3 张 build/bg*.png 看；cap*.png / nt*.png 不用一张张翻`),mode+'\n'+r.stdout)
    assert.doesNotMatch(r.stdout,/自查图：|\u001b/,mode); assert.doesNotMatch(r.stdout,OLD,mode)
  }
  let r=render('2')
  assert.equal(r.status,0,r.stderr)
  assert.ok(r.stdout.includes(`  自查图：${path.join(build,'check.jpg')}、${path.join(build,'check-2.jpg')}\n`),r.stdout)
  assert.ok(r.stdout.includes('用 Read 只看自查图（2 张，每张看一次）（封面、每个场景一格、字幕和便签放大）'),r.stdout)
  r=render('1')
  assert.equal(r.status,0,r.stderr)
  assert.ok(r.stdout.includes(`  自查图：${path.join(build,'check.jpg')}\n`),r.stdout); assert.doesNotMatch(r.stdout,/check-2\.jpg|⚠️/)
  assert.ok(r.stdout.includes('用 Read 只看自查图（封面、每个场景一格、字幕和便签放大）'),r.stdout)
  assert.ok(r.stdout.includes(`再 Read 那一格的大图 ${path.join(build,'frame-sNN.jpg')}（NN = 格子上的场景号，两位数），每次渲染最多单独看 2 张`),r.stdout)
  assert.doesNotMatch(r.stdout,OLD)
  // 交审照旧：回执只记成片 / 封面 / 剧本三份，审片快照里没有自查图
  assert.deepEqual(Object.keys(readJ(path.join(s.home,'.bili-ai','renders',id+'.json')).hashes).sort(),['cover.jpg','final.mp4','script.json'])
  r=studio(s,['submit',id,'--reason',REASON],s.agent)
  assert.equal(r.status,0,r.stderr); assert.deepEqual(queue(s),[id])
  const snap=fs.readdirSync(path.join(s.home,'.bili-ai','review',id))
  assert.ok(!snap.some(f=>/^(build|check|frame-)/.test(f)),JSON.stringify(snap))
  assert.ok(fs.existsSync(path.join(build,'check.jpg')),'她作品目录里的自查图还在')
})

// render 常被转到后台（VoxCPM 配音慢；数学讲解又长）：那时她只收到完成通知，看不到 render 最后那几行 —— 复查时发现她只能猜 build/check.jpg，
// 漏掉 check-2.jpg、自查图没做成时的退路（最多 3 张 bg）也用不上。现在 studio show 把那几行再打一遍：自查图在哪、没做成的原因、方框字。
// 只认这边核对过、算数的那一次渲染（作品目录里 render.json 的成片指纹 = 回执里的）；交审之后不再给（不用再自查）
test('contact sheet: studio show repeats the self-check lines of the last counted render (sheet paths, fallback reason, missing glyphs); none before a render, for a forged render.json or after submit',t=>{
  const s=sandbox(t,{fakePy:true})
  const id=newProject(s,{text:'今天醒来的时候，窗外在下雨。'})
  const dir=projDir(s,id), build=path.join(dir,'build')
  const render=(mode,extra={})=>studio(s,['render',id],{...s.agent,NODE_OPTIONS:'--import='+href('tests/helpers/fake-studio-py-sheet.mjs'),FAKE_SHEET:mode,...extra})
  const show=()=>{const r=studio(s,['show',id],s.agent); assert.equal(r.status,0,r.stderr); return r.stdout}
  const SHEET=/自查图：|用 Read 只看自查图|自查图没做成|字体里没有这些字/
  assert.doesNotMatch(show(),SHEET,'还没渲染')
  // 两页自查图 + 方框字：show 最后几行和 render 打的一模一样
  let r=render('2',{FAKE_GLYPHS:'1'})
  assert.equal(r.status,0,r.stderr)
  const glyphs='  ⚠️ 字体里没有这些字，画面上是方框（自查图上那几格框成了琥珀色）：封面「♪」；场景 3「ℝ ⊆ U+FE0F U+202E」 —— 换个写法（比如 x₁ 写成 x1、ℝ 写成 R 或「实数」）再渲染\n'
  assert.ok(r.stdout.includes(glyphs),r.stdout)
  assert.doesNotMatch(r.stdout,/[\u001b\u0007‮]|场景 [456]/,'坏的几条（场景号不是整数、只有控制符、chars 不是字符串）不打；改方向的控制符写成 U+202E')
  const block=r.stdout.slice(r.stdout.indexOf('  自查图：'),r.stdout.indexOf('  交审：'))
  assert.ok(block.startsWith(`  自查图：${path.join(build,'check.jpg')}、${path.join(build,'check-2.jpg')}\n`)&&block.endsWith(glyphs),block)
  let out=show()
  assert.ok(out.endsWith(block),out); assert.match(out,/"status": "rendered"/); assert.ok(out.includes(`目录：${dir}`))
  // 自查图没做成：show 照样给原因和退路（最多 3 张 bg）
  r=render('fail'); assert.equal(r.status,0,r.stderr)
  const fallback='  ⚠️ 自查图没做成（抽不出 c0003.mp4 的 1.20 秒： [31m坏了）：这次 Read cover.jpg，再挑最多 3 张 build/bg*.png 看'
  assert.ok(r.stdout.includes(fallback),r.stdout)
  out=show(); assert.ok(out.includes(fallback),out); assert.doesNotMatch(out,/自查图：|字体里没有|\u001b/)
  // 页数说有、文件却没了（比如之后又渲染了一次、半路失败：studio.py 一开始就清掉了旧的自查图）：不给不存在的路径
  r=render('1'); assert.equal(r.status,0,r.stderr); assert.ok(show().includes(`  自查图：${path.join(build,'check.jpg')}\n`))
  fs.rmSync(path.join(build,'check.jpg'))
  out=show(); assert.ok(out.includes('  ⚠️ 自查图没做成（文件不在了：要是之后又渲染过、没渲成，先再 studio render 一次）'),out); assert.doesNotMatch(out,/自查图：/)
  // 她改了作品目录里的 render.json（成片指纹对不上回执）：不认，什么都不打
  r=render('1'); assert.equal(r.status,0,r.stderr)
  const rj=readJ(path.join(dir,'render.json'))
  fs.writeFileSync(path.join(dir,'render.json'),JSON.stringify({...rj,check_pages:3,hashes:{...rj.hashes,'final.mp4':'0'.repeat(64)}}))
  assert.doesNotMatch(show(),SHEET,'render.json 不是回执那一次的')
  fs.writeFileSync(path.join(dir,'render.json'),JSON.stringify(rj))
  assert.ok(show().includes(`  自查图：${path.join(build,'check.jpg')}\n`))
  // 交审之后不再给
  r=studio(s,['submit',id,'--reason',REASON],s.agent)
  assert.equal(r.status,0,r.stderr)
  out=show(); assert.match(out,/"status": "submitted"/); assert.doesNotMatch(out,SHEET)
})

test('contact sheet: her rules say Read only build/check.jpg, then at most 2 frame-sNN.jpg; the per-layer Read instruction is gone; no template mixes line endings',()=>{
  const rules=fs.readFileSync(path.join(root,'templates/rules/studio.md'),'utf8')   // v0.11.22 起「做视频」整节在 studio rules 里
  for(const w of ['**自查图** `build/check.jpg`','**用 Read 只看这一张**','封面（约首页推荐里那么大）','「场景 N · 第 K 句 · 分:秒」','框成琥珀色',
    '`build/frame-sNN.jpg`','**每次渲染最多单独看 2 张**','自查图没做成','最多 3 张 `build/bg*.png`','`check-2.jpg`','再看新的自查图',
    // 复查补的：方框字（格子里幻灯片的字太小，工具列出来）、收起又拿出来的便签、render 转到后台时用 studio show 看自查图
    '有字体里没有的字（画面上是方框）的，框成琥珀色','方框字工具会列出来','不用为这个一页页看大图','字幕错字、方框字、',
    '收起又拿出来的会再放大一格，看它和收起前一样','`studio show <id>` 看状态、时长和自查图','自查图在哪、没做成的原因、方框字']) assert.ok(rules.includes(w),w)
  // 守则里提到 cap*.png / nt*.png 的只剩「别再一张张 Read」那一句；老的「看几张 cap / 每串 nt 编号最大的那张」没了
  const layer=rules.split(/\r?\n/).filter(l=>/cap\*\.png|nt\*\.png/.test(l))
  assert.equal(layer.length,1,JSON.stringify(layer)); assert.match(layer[0],/^ {3}- 别再一张张 Read /)
  assert.ok(!rules.includes('几张 `build/cap*.png`')&&!rules.includes('编号最大的那张'))
  // 这几条在「做视频」第 3 步下面
  const lines=rules.split(/\r?\n/), at=lines.findIndex(l=>l.startsWith('3. `studio render <id>`'))
  assert.ok(at>0&&lines.slice(0,at).some(l=>l==='### 做视频')); assert.match(lines[at],/build\/check\.jpg/); assert.match(lines[at+1],/frame-sNN\.jpg/)
  const slide=lines.find(l=>l.includes('幻灯片配画（可选）'))
  assert.match(slide,/渲染完在自查图上看那一页（没画出来，格子上会写）/); assert.doesNotMatch(slide,/bg\*\.png/)
  // 换行：每个模板（CLAUDE.md 也在里面）自己统一，不混着用、最后有换行。不硬要 CRLF：.gitattributes 是 `* text=auto eol=lf`，
  // 哪天进了 git，干净 checkout 出来的 CLAUDE.md 就是 LF（复查发现原来那条「全是 CRLF」在那时会失败）。宿主原样复制，两种都行
  for(const f of ['templates/CLAUDE.md','templates/rules/studio.md']) assert.match(fs.readFileSync(path.join(root,f),'utf8'),/\n$/,f)
  const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):e.name.endsWith('.md')?[path.join(d,e.name)]:[])
  for(const f of walk(path.join(root,'templates'))){
    const b=fs.readFileSync(f,'utf8'), crlf=(b.match(/\r\n/g)??[]).length, lf=(b.match(/(?<!\r)\n/g)??[]).length
    assert.ok(crlf===0||lf===0,`${f}：CRLF ${crlf} 行、单独的 LF ${lf} 行混在一起`)
  }
  // render 成功后的提示：只给自查图；老的「看 bg / cap / nt」那句没了
  const src=fs.readFileSync(path.join(root,'tools/commands/studio.mjs'),'utf8')
  assert.ok(src.includes('用 Read 只看自查图')&&src.includes('最多 3 张 build/bg*.png'))
  assert.ok(!src.includes('再看 build/ 里的 bg*.png')&&!src.includes('编号最大的那张'))
})
