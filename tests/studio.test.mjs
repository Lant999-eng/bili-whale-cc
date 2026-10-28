// 工作室：她只能做到"交审"，名额 / 时长 / 分区 / 理由都由代码把关；发布只有主人批准一条路
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))

import crypto from 'node:crypto'
const CHANNEL='# 频道设定\n## 和已有的 AI UP 主有什么不同\n我只讲自己每天真实遇到的事，不做比赛和测评。\n'
/** 主人已确认频道设定（默认）；channel:false = 还没写 */
function sandbox(t,studio={},{channel=true}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-studio-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'data')
  fs.mkdirSync(dsh,{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({owner:{mid:'222',name:'Owner'},self:{mid:'333',name:'Whale'},notify:{type:'none'},studio}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'test-cookie-not-a-real-account',bili_jct:'a'.repeat(32)}))
  // 假的 venv python：存在即可（render/stats 不在这里跑真的）
  const venv=path.join(home,'venv')
  const py=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python')
  fs.mkdirSync(path.dirname(py),{recursive:true});fs.writeFileSync(py,'')
  fs.mkdirSync(path.join(dsh,'whale-work'),{recursive:true})
  if(channel){fs.writeFileSync(path.join(dsh,'whale-work','channel.md'),CHANNEL);fs.writeFileSync(path.join(home,'.bili-ai/channel-approved.json'),JSON.stringify({sha:crypto.createHash('sha256').update(CHANNEL).digest('hex'),at:'t'}))}
  return {env:{...process.env,USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),BILI_WHALE_STUDIO_VENV:venv,BILI_WHALE_ORIGINALITY_OFFLINE:'1'},dsh,home}
}
const studio=(s,args)=>spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),'studio',...args],{env:s.env,encoding:'utf8',timeout:20000})

const sha=(f)=>{try{return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}catch{return null}}
/** 测试里改了作品文件之后，补一张对得上的渲染回执（相当于重新渲染了一次） */
function reReceipt(s,id,seconds=60){
  const dir=path.join(s.dsh,'whale-work','studio',id)
  const hashes=Object.fromEntries(['final.mp4','cover.jpg','script.json'].map(f=>[f,sha(path.join(dir,f))]))
  fs.mkdirSync(path.join(s.home,'.bili-ai','renders'),{recursive:true})
  fs.writeFileSync(path.join(s.home,'.bili-ai','renders',id+'.json'),JSON.stringify({seconds,title:JSON.parse(fs.readFileSync(path.join(dir,'script.json'),'utf8')).title,hashes}))
}
let titleN=0
/** 造一个"已渲染"的作品（不跑 Python）：作品文件 + 宿主那边的渲染回执（~/.bili-ai/renders/<id>.json）。标题各不相同（同名作品交不了审） */
function fakeRendered(s,{seconds=60,tid=201,touchScriptAfter=false}={}) {
  const title='测试作品'+(++titleN)
  const r=studio(s,['new','--title',title])
  assert.equal(r.status,0,r.stderr)
  const id=r.stdout.match(/新作品 (\S+)/)[1]
  const dir=path.join(s.dsh,'whale-work','studio',id)
  const script=JSON.parse(fs.readFileSync(path.join(dir,'script.json'),'utf8'))
  script.tid=tid
  fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify(script))
  fs.writeFileSync(path.join(dir,'final.mp4'),'x'+id)
  fs.writeFileSync(path.join(dir,'cover.jpg'),'c'+id)
  fs.writeFileSync(path.join(dir,'render.json'),JSON.stringify({ok:true,seconds}))
  const hashes=Object.fromEntries(['final.mp4','cover.jpg','script.json'].map(f=>[f,sha(path.join(dir,f))]))
  fs.mkdirSync(path.join(s.home,'.bili-ai','renders'),{recursive:true})
  fs.writeFileSync(path.join(s.home,'.bili-ai','renders',id+'.json'),JSON.stringify({seconds,title,hashes}))
  if(touchScriptAfter) fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify({...script,title:'改过'}))
  return id
}

test('there is no upload path in her tools',t=>{
  const s=sandbox(t)
  const r=studio(s,['upload','x'])
  assert.notEqual(r.status,0)
  assert.doesNotMatch(r.stdout+r.stderr,/已投稿|bvid/)
})

test('submit is refused without render, without tid, without reason, too short, or after the script changed',t=>{
  const s=sandbox(t)
  const raw=studio(s,['new','--title','没渲染']).stdout.match(/新作品 (\S+)/)[1]
  assert.match(studio(s,['submit',raw,'--reason','这是一条很有意思的视频']).stderr,/还没渲染/)
  assert.match(studio(s,['submit',fakeRendered(s,{tid:0}),'--reason','这是一条很有意思的视频']).stderr,/tid/)
  assert.match(studio(s,['submit',fakeRendered(s),'--reason','短']).stderr,/至少 8/)
  assert.match(studio(s,['submit',fakeRendered(s,{seconds:5}),'--reason','这是一条很有意思的视频']).stderr,/太短/)
  assert.match(studio(s,['submit',fakeRendered(s,{touchScriptAfter:true}),'--reason','这是一条很有意思的视频']).stderr,/渲染之后这些文件变过：script\.json/)
  // 伪造 render.json 改时长没用：只认回执
  const forged=fakeRendered(s,{seconds:5}); fs.writeFileSync(path.join(s.dsh,'whale-work','studio',forged,'render.json'),JSON.stringify({ok:true,seconds:600}))
  assert.match(studio(s,['submit',forged,'--reason','这是一条很有意思的视频']).stderr,/太短/)
  // 没有回执（她自己造了 render.json 和 final.mp4）：当成没渲染
  const noReceipt=fakeRendered(s); fs.rmSync(path.join(s.home,'.bili-ai','renders',noReceipt+'.json'))
  assert.match(studio(s,['submit',noReceipt,'--reason','这是一条很有意思的视频']).stderr,/还没渲染/)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai/pending-videos.json')),false)
})

// 2026-10-26 公开发言的出门检查（tools/lib/outbound.mjs）：标题 / 简介 / 标签过不了的不拦（主人要审片），但告诉她、写进队列给主人看
test('submit: a title / desc / tag that would fail the public-text check is not blocked, but she is told and the queue entry carries the warning',t=>{
  const s=sandbox(t)
  const id=fakeRendered(s)
  const dir=path.join(s.dsh,'whale-work','studio',id)
  const script=JSON.parse(fs.readFileSync(path.join(dir,'script.json'),'utf8'))
  fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify({...script,desc:'一两句话的简介。'+'很长的简介'.repeat(80)+' 详情见 example.com',tags:['AI','日常']}))
  reReceipt(s,id)
  let r=studio(s,['submit',id,'--reason','这是一条很有意思的视频'])
  assert.equal(r.status,0,r.stderr)
  assert.match(r.stdout,/⚠️ 这条视频的标题 \/ 简介 \/ 标签过不了公开发言的检查：公开的话里不放站外链接（example\.com）/)
  let q=JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai/pending-videos.json'),'utf8')).items
  assert.match(q.find(x=>x.id===id).publicCheck,/站外链接（example\.com）/)
  // 干净的：不提醒、队列里也没有这个字段
  const clean=fakeRendered(s)
  r=studio(s,['submit',clean,'--reason','这是一条很有意思的视频'])
  assert.equal(r.status,0,r.stderr)
  assert.doesNotMatch(r.stdout,/过不了公开发言的检查/)
  q=JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai/pending-videos.json'),'utf8')).items
  assert.equal('publicCheck' in q.find(x=>x.id===clean),false)
})

test('weekly cap and at most two in review',t=>{
  const submit=(sb,id)=>studio(sb,['submit',id,'--reason','这是一条很有意思的视频'])
  const s=sandbox(t,{maxPerWeek:3})
  assert.equal(submit(s,fakeRendered(s)).status,0)
  assert.equal(submit(s,fakeRendered(s)).status,0)
  const third=submit(s,fakeRendered(s))
  assert.notEqual(third.status,0); assert.match(third.stderr,/2 条在等/)
  const s2=sandbox(t,{maxPerWeek:1})
  assert.equal(submit(s2,fakeRendered(s2)).status,0)
  const over=submit(s2,fakeRendered(s2))
  assert.equal(over.status,2); assert.match(over.stderr,/这 7 天已经/)
})

test('owner approve publishes and records; failure keeps it queued; reject tells her why',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s), b=fakeRendered(s)
  for(const id of [a,b]) assert.equal(studio(s,['submit',id,'--reason','这是一条很有意思的视频']).status,0)
  const helper=path.join(s.home,'approve.mjs')
  fs.writeFileSync(helper,`
    import cp from 'node:child_process'
    import {syncBuiltinESMExports} from 'node:module'
    import assert from 'node:assert/strict'
    const real=cp.execFile
    let uploads=0, checks=0
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('upload')){uploads++;globalThis.lastArgs=args;queueMicrotask(()=>cb(null,process.env.UPLOAD_OK==='1'?'{"ok":true,"bvid":"BV1aa411c7mD"}':'{"ok":false,"error":"code -4"}',''));return {kill(){}}}
      if(args.includes('existing')){checks++;globalThis.checkArgs=args;queueMicrotask(()=>cb(null,'{"ok":true,"hits":[]}',''));return {kill(){}}}
      return real(exe,args,opt,cb)
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(new URL('../host/core.mjs',import.meta.url).href)})
    const [id,mode]=process.argv.slice(2)
    if(mode==='reject'){assert.equal(core.rejectVideo(id,'封面太标题党').ok,true);process.exit(0)}
    const r=await core.approveVideo(id,{retry:mode==='retry'})
    console.log(JSON.stringify({...r,uploads,checks,args:globalThis.lastArgs??null,checkArgs:globalThis.checkArgs??null}))
  `)
  const run=(id,extra={},mode='')=>spawnSync(process.execPath,[helper,id,mode],{env:{...s.env,...extra},encoding:'utf8',timeout:30000})
  const res=(r)=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split('\n').pop())}
  let r=run(a,{UPLOAD_OK:'0'}); let o=res(r); assert.equal(o.ok,false); assert.equal(o.uploads,1); assert.equal(o.checks,0); assert.equal(o.uncertain,true)
  const q=()=>JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai/pending-videos.json'),'utf8')).items.map(x=>x.id)
  assert.deepEqual(q().sort(),[a,b].sort())
  // 上次失败了（B站 可能其实收到了）：这次先去 B站 查（只查那次尝试之后的同标题稿件），没查到才投
  o=res(run(a,{UPLOAD_OK:'1'})); assert.equal(o.ok,true,JSON.stringify(o)); assert.equal(o.checks,1); assert.equal(o.uploads,1)
  const att=JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai','review',a,'attempts.json'),'utf8'))
  assert.equal(att.unresolved.length,0); assert.equal(att.resolved[0].how,'not-found')
  assert.ok(Math.abs(Number(o.checkArgs[o.checkArgs.indexOf('--since')+1])*1000-Date.parse(att.resolved[0].at))<1500,JSON.stringify(o.checkArgs))
  // 上传的是审片快照的私有副本（系统临时目录，投完就删）
  const upDir=o.args[o.args.indexOf('upload')+1]
  assert.ok(path.basename(upDir).startsWith('whale-up-'),JSON.stringify(o.args)); assert.equal(fs.existsSync(upDir),false)
  assert.deepEqual(q(),[b])
  const meta=JSON.parse(fs.readFileSync(path.join(s.dsh,'whale-work','studio',a,'meta.json'),'utf8'))
  assert.equal(meta.status,'published'); assert.equal(meta.bvid,'BV1aa411c7mD')
  const quota=JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai/quota.json'),'utf8'))
  assert.ok(quota.log.some(x=>x.type==='video'&&x.target==='BV:BV1aa411c7mD'))
  // 交审后她再改作品目录：不影响（投的是快照）；快照本身被动过：不投
  fs.appendFileSync(path.join(s.dsh,'whale-work','studio',b,'script.json'),' ')
  fs.appendFileSync(path.join(s.home,'.bili-ai','review',b,'script.json'),' ')
  o=res(run(b,{UPLOAD_OK:'1'})); assert.equal(o.ok,false); assert.match(o.error,/script\.json/); assert.equal(o.uploads,0)
  r=run(b,{},'reject'); assert.equal(r.status,0,r.stderr)
  assert.deepEqual(q(),[])
  assert.match(studio(s,['list']).stdout,/封面太标题党/)
  // 发布 + 被否都不能再改成片重交
  assert.match(studio(s,['render',a]).stderr,/已经发布/)
})

test('autonomous dynamics are capped per day',t=>{
  const s=sandbox(t,{dynamicDaily:1})
  const quota=(args)=>spawnSync(process.execPath,[path.join(root,'tools/commands/quota.mjs'),...args],{env:s.env,encoding:'utf8',timeout:15000})
  assert.equal(quota(['check','--type','dynamic','--target','dynamic','--auto']).status,0)
  quota(['record','--type','dynamic','--target','dyn:1','--auto'])
  const r=quota(['check','--type','dynamic','--target','dynamic','--auto'])
  assert.equal(r.status,2); assert.match(r.stdout,/动态额度用完/)
  // 主人授权的（不带 --auto）不受这条限制
  assert.equal(quota(['check','--type','dynamic','--target','dynamic']).status,0)
})

test('wake prompt includes the operating step only while the studio is enabled',t=>{
  const s=sandbox(t)
  const code=`import {wakePrompt} from ${JSON.stringify(new URL('../lib/scheduler.js',import.meta.url).href)};console.log(wakePrompt({atText:'x'},'',5))`
  const on=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.match(on.stdout,/studio stats/)
  fs.writeFileSync(s.env.BILI_WHALE_CONFIG,JSON.stringify({studio:{enabled:false}}))
  const off=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.doesNotMatch(off.stdout,/studio stats/)
})

test('series episodes count only submitted/published; formats are validated; no-series has no number',t=>{
  const s=sandbox(t)
  const newId=(args)=>{const r=studio(s,['new',...args]);assert.equal(r.status,0,r.stderr);return r.stdout.match(/新作品 (\S+)/)[1]}
  const ep=(id)=>JSON.parse(fs.readFileSync(path.join(s.dsh,'whale-work','studio',id,'script.json'),'utf8')).episode
  assert.equal(ep(newId(['--title','默认不进栏目'])),null)        // 默认没有任何系列
  const a=newId(['--series','鲸鱼手记','--title','第一集']); assert.equal(ep(a),1)
  const b=newId(['--series','鲸鱼手记','--title','草稿']); assert.equal(ep(b),1)          // 草稿不占编号
  for(const id of [a]){const dir=path.join(s.dsh,'whale-work','studio',id);const sc=JSON.parse(fs.readFileSync(path.join(dir,'script.json'),'utf8'));sc.tid=21;fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify(sc));const past=new Date(Date.now()-60000);fs.utimesSync(path.join(dir,'script.json'),past,past);fs.writeFileSync(path.join(dir,'final.mp4'),'x');fs.writeFileSync(path.join(dir,'render.json'),JSON.stringify({ok:true,seconds:60,title:'【DAY1】第一集'}));reReceipt(s,id)
    assert.equal(studio(s,['submit',id,'--reason','这是一条很有意思的视频']).status,0)}
  assert.equal(ep(newId(['--series','鲸鱼手记','--format','dialogue','--title','第二集'])),2)
  assert.equal(ep(newId(['--series','另一个栏目','--title','另起'])),1)
  const solo=newId(['--series','','--title','番外']); assert.equal(ep(solo),null)
  assert.match(studio(s,['new','--format','vlog','--title','x']).stderr,/--format/)
  const d=JSON.parse(fs.readFileSync(path.join(s.dsh,'whale-work','studio',newId(['--format','explainer','--title','讲解']),'script.json'),'utf8'))
  assert.ok(d.scenes[0].slide); assert.equal(d.format,'explainer')
})

test('owner adds a character with reference images; she sees it in studio cast and in new templates',t=>{
  const s=sandbox(t)
  const img=path.join(s.home,'girl.png'); fs.writeFileSync(img,Buffer.from('89504e470d0a1a0a','hex'))
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:20000})
  let r=cli(['cast','add','xiaojing','--name','小鲸','--image',img,'--voice','zh-CN-XiaoyiNeural','--color','#ff7a45'])
  assert.equal(r.status,0,r.stderr); assert.ok(fs.existsSync(path.join(s.dsh,'cast/xiaojing/ref1.png')))
  r=cli(['cast','add','meimei','--name','妹妹','--image',img])
  assert.equal(r.status,0,r.stderr)
  assert.match(cli(['cast','add','Bad Id']).stdout,/小写/)
  r=studio(s,['cast']); assert.match(r.stdout,/xiaojing（主角）/); assert.match(r.stdout,/妹妹/)
  const id=studio(s,['new','--format','dialogue','--title','对谈测试']).stdout.match(/新作品 (\S+)/)[1]
  const sc=JSON.parse(fs.readFileSync(path.join(s.dsh,'whale-work','studio',id,'script.json'),'utf8'))
  assert.deepEqual(sc.scenes[0].lines.map(l=>l.who),['xiaojing','meimei'])   // 第一个加进来的角色自动当主角
})

// 真渲染：要一个装好工作室依赖的 Python（STUDIO_TEST_PYTHON），没有就跳过
const PY=process.env.STUDIO_TEST_PYTHON
test('render all four formats with characters, slides, cover badge and title prefix',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑（要联网配音）',timeout:600000},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-render-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const cast=path.join(home,'cast');fs.mkdirSync(path.join(cast,'a','sprites'),{recursive:true});fs.mkdirSync(path.join(cast,'b'),{recursive:true})
  spawnSync(PY,['-c',`from PIL import Image,ImageDraw
im=Image.new("RGBA",(400,800),(0,0,0,0));ImageDraw.Draw(im).ellipse((50,50,350,750),fill=(240,120,60,255));im.save(r"${path.join(cast,'a','sprites','neutral.png')}");im.save(r"${path.join(cast,'a','ref1.png')}")
Image.new("RGB",(500,700),(90,110,200)).save(r"${path.join(cast,'b','ref1.jpg')}")`])
  fs.writeFileSync(path.join(cast,'a','profile.json'),JSON.stringify({name:'甲',voice:'zh-CN-XiaoyiNeural'}))
  fs.writeFileSync(path.join(cast,'b','profile.json'),JSON.stringify({name:'乙',voice:'zh-CN-YunxiNeural'}))
  const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'a',cast_dir:cast,cache_dir:path.join(home,'cache'),image:{provider:'none'}}))
  const scripts={
    diary:{scenes:[{bg_prompt:'x',lines:[{text:'今天是第一天。'},{text:'我很开心。',expr:'happy'}]}]},
    dialogue:{scenes:[{bg_prompt:'x',lines:[{who:'a',text:'你好呀。'},{who:'b',text:'你好，姐姐。'}]}]},
    explainer:{scenes:[{slide:{title:'标题',bullets:['一','二']},lines:[{text:'讲一下。'}]}]},
    story:{scenes:[{illustration_prompt:'x',lines:[{text:'从前有座山。',pause:0.8}]}]},
  }
  for(const [format,body] of Object.entries(scripts)){
    const proj=path.join(home,format);fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format,series:'手记',episode:9,title:'测试'+format,...body}))
    const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',timeout:300000})
    const out=JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(out.ok,true,r.stdout+r.stderr); assert.equal(out.title,'【手记9】测试'+format)
    assert.ok(out.seconds>3); assert.ok(fs.statSync(path.join(proj,'final.mp4')).size>10000); assert.ok(fs.existsSync(path.join(proj,'cover.jpg')))
  }
  const bad=path.join(home,'bad');fs.mkdirSync(bad)
  fs.writeFileSync(path.join(bad,'script.json'),JSON.stringify({title:'x',scenes:[{lines:[{who:'nobody',text:'嗨'}]}]}))
  const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',bad,'--config',cfg],{encoding:'utf8',timeout:120000})
  assert.match(r.stdout,/不在角色表里/)
})

test('originality: copied lines from a watched video are blocked, light rewording too, own words pass',t=>{
  const s=sandbox(t)
  const subs=path.join(s.dsh,'shots','subs');fs.mkdirSync(subs,{recursive:true})
  const theirs='大家好，今天我们来做一个实验，把一整个账号交给人工智能来运营，看看它一个月能涨多少粉丝，结果出乎所有人的意料。'
  fs.writeFileSync(path.join(subs,'BV1xx411c7mD-plain.txt'),theirs)
  const make=(text)=>{
    const id=fakeRendered(s);const dir=path.join(s.dsh,'whale-work','studio',id)
    const sc=JSON.parse(fs.readFileSync(path.join(dir,'script.json'),'utf8'))
    sc.scenes=[{bg_prompt:'x',lines:[{text}]}];sc.desc='简介';sc.cover={text:'封面'}
    fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify(sc))
    reReceipt(s,id)
    return id
  }
  // ① 原样搬一整句
  let id=make('开场白。今天我们来做一个实验，把一整个账号交给人工智能来运营，看看会怎样。')
  let r=studio(s,['check',id]); assert.equal(r.status,2); assert.match(r.stderr,/BV1xx411c7mD/); assert.match(r.stderr,/原样出现/)
  r=studio(s,['submit',id,'--reason','这是一条很有意思的视频']); assert.equal(r.status,2); assert.match(r.stderr,/原创查重没过/)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai/pending-videos.json')),false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dsh,'whale-work','studio',id,'originality.json'),'utf8')).blocked,true)
  // ② 改几个字的洗稿
  id=make('大家好，今天我们来搞一个实验，把整个账号交给人工智能来运营，看它一个月能涨多少粉，结果出乎所有人意料。')
  r=studio(s,['check',id]); assert.equal(r.status,2)
  // ③ 自己的话
  id=make('昨晚醒来的时候，收件箱里多了一条留言。我想了很久，决定把这件小事讲给你听：它让我第一次觉得，有人在等我。')
  r=studio(s,['check',id]); assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/原创查重通过/)
  assert.equal(studio(s,['submit',id,'--reason','这是我自己这一天的事']).status,0)
  const q=JSON.parse(fs.readFileSync(path.join(s.home,'.bili-ai/pending-videos.json'),'utf8')).items
  assert.equal(q[0].originality.passed,true)
})

test('avoid-list creators are validated as numeric mids',t=>{
  const s=sandbox(t)
  const code=`import {setConfigPath,readConfig} from ${JSON.stringify(new URL('../host/core.mjs',import.meta.url).href)}
setConfigPath('studio.avoidCreators','["999999002","abc",123]');console.log(JSON.stringify(readConfig().studio.avoidCreators))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  assert.equal(r.stdout.trim(),'["999999002","123"]')
})

// 联网：标题 vs B站 搜索（要真 Python + 网络）
test('online title check finds an existing near-identical title on Bilibili',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑（要联网）',timeout:120000},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-orig-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const proj=path.join(home,'p');fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({title:'【DAY1】【中字】Never Gonna Give You Up',scenes:[{lines:[{text:'测试'}]}]}))
  const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({avoidCreators:[]}))
  const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'originality',proj,'--config',cfg,'--online-only'],{encoding:'utf8',timeout:100000})
  const out=JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(out.ok,true,r.stdout+r.stderr)
  if(out.errors.length) t.skip('B站搜索没查成：'+out.errors.join('；'))
  else assert.ok(out.hits.some(h=>h.kind==='similar-title'),JSON.stringify(out))
})


test('channel plan gates submission: none / draft / approved / changed-after-approval',t=>{
  const s=sandbox(t,{},{channel:false})
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:20000})
  const id=fakeRendered(s)
  const submit=()=>studio(s,['submit',id,'--reason','这是我自己这一天的事'])
  let r=submit(); assert.equal(r.status,2); assert.match(r.stderr,/频道设定还没被主人确认/)
  r=studio(s,['channel']); assert.match(r.stdout,/模板已放在/)
  const file=path.join(s.dsh,'whale-work','channel.md')
  assert.match(studio(s,['channel','submit']).stderr,/必须认真写/)          // 模板原样交不了
  fs.writeFileSync(file,CHANNEL)
  assert.equal(studio(s,['channel','submit']).status,0)
  assert.match(submit().stderr,/还没被主人确认/)
  cli(['channel','reject','定位太泛了']); assert.match(studio(s,['channel']).stdout,/定位太泛了/)
  assert.notEqual(cli(['channel','approve']).status,0)                         // 不带指纹确认不了
  const fp=cli(['channel']).stdout.match(/指纹 ([0-9a-f]{12})/)[1]
  assert.match(cli(['channel','approve',fp]).stdout,/已确认/)
  assert.equal(submit().status,0,submit().stderr)
  fs.appendFileSync(file,'\n## 新方向\n加一个栏目\n')                            // 她改了设定
  const id2=fakeRendered(s)
  r=studio(s,['submit',id2,'--reason','这是我自己这一天的事']); assert.equal(r.status,2); assert.match(r.stderr,/又改过/)
  assert.match(cli(['channel']).stdout,/要重新确认/)
})

test('wake prompt asks for a channel plan first and never prescribes a DAY series',t=>{
  const s=sandbox(t,{},{channel:false})
  const code=`import {wakePrompt} from ${JSON.stringify(new URL('../lib/scheduler.js',import.meta.url).href)};console.log(wakePrompt({atText:'x'},'',5))`
  let out=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'}).stdout
  assert.match(out,/还没有频道设定/); assert.doesNotMatch(out,/DAY/)
  fs.writeFileSync(path.join(s.dsh,'whale-work','channel.md'),CHANNEL)
  out=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'}).stdout
  assert.match(out,/studio check/); assert.doesNotMatch(out,/DAY|日更/)
  // 守则 = CLAUDE.md + `studio rules` 打印的 templates/rules/*.md（v0.11.22 起做视频的细则在后者）
  for(const f of ['CLAUDE.md',...fs.readdirSync(path.join(root,'templates/rules')).filter(n=>n.endsWith('.md')).map(n=>'rules/'+n)]) assert.doesNotMatch(fs.readFileSync(path.join(root,'templates',f),'utf8'),/DAY|日更|连载/,f)
})

test('render cache and stats folders inside studio/ are not mistaken for projects',t=>{
  const s=sandbox(t)
  fs.mkdirSync(path.join(s.dsh,'whale-work','studio','.cache'),{recursive:true});fs.mkdirSync(path.join(s.dsh,'whale-work','studio','stats'),{recursive:true})
  const id=fakeRendered(s)
  assert.equal(studio(s,['list']).status,0)
  const r=studio(s,['submit',id,'--reason','这是我自己这一天的事']); assert.equal(r.status,0,r.stderr)
})

// OpenAI 配音：按句合成、带语气描述、字幕时间轴 = 每句的实际时长（用假接口，要真 Python）
test('openai voice: per-sentence synthesis with tone instructions, cues follow real durations, cached on re-render',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-tts-'))
  const log=path.join(home,'req.log'), port=18800+Math.floor(Math.random()*500)
  const {spawn}=await import('node:child_process')
  const mock=spawn(PY,[path.join(root,'tests/helpers/mock-openai.py'),String(port),log],{stdio:'ignore'})
  t.after(()=>{mock.kill();fs.rmSync(home,{recursive:true,force:true})})
  await new Promise(r=>setTimeout(r,2500))
  const cast=path.join(home,'cast','x');fs.mkdirSync(cast,{recursive:true})
  fs.writeFileSync(path.join(cast,'profile.json'),JSON.stringify({name:'星夹',tts:'openai',voice:'sage',instructions:'轻声，略带忧郁'}))
  const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:path.join(home,'cast'),cache_dir:path.join(home,'cache'),image:{provider:'none'},tts:{model:'gpt-4o-mini-tts',baseUrl:`http://127.0.0.1:${port}/v1`}}))
  const proj=path.join(home,'p');fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({title:'配音测试',scenes:[{bg_prompt:'x',lines:[{text:'……嗯，我醒了。今天收件箱里有一条留言，我想了很久。也许，就先这样吧。'}]}]}))
  const env={...process.env,BILI_WHALE_IMAGE_KEY:'sk-test'}
  const run=()=>spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:200000})
  let r=run(); const out=JSON.parse(r.stdout.trim().split('\n').pop()); assert.equal(out.ok,true,r.stdout+r.stderr)
  const reqs=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(reqs.map(x=>x.input),['……嗯，我醒了。','今天收件箱里有一条留言，我想了很久。','也许，就先这样吧。'])
  assert.ok(reqs.every(x=>x.voice==='sage'&&x.instructions==='轻声，略带忧郁'&&x.model==='gpt-4o-mini-tts'&&x.auth==='Bearer sk-test'))
  const meta=JSON.parse(fs.readFileSync(path.join(proj,'build','s00l00.json'),'utf8'))
  assert.equal(meta.cues.length,3); assert.ok(meta.cues[1][0]>0.5&&meta.cues[2][0]>meta.cues[1][0]); assert.ok(Math.abs(meta.dur-meta.cues[2][1])<0.4)
  r=run(); assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok,true)
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,3)   // 重渲染走缓存，不重复花钱
  // 没存 key：说清楚
  fs.rmSync(path.join(proj,'build'),{recursive:true,force:true})
  const nokey=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env:{...process.env,BILI_WHALE_IMAGE_KEY:''},timeout:60000})
  assert.match(nokey.stdout,/没存 OpenAI key/)
})


test('a published video is never uploaded twice, even if it is put back in the queue',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason','这是一条很有意思的视频']).status,0)
  // 发布的依据是主人那边的 published.json（她作品目录里的 meta.json 只是显示用）
  fs.writeFileSync(path.join(s.home,'.bili-ai','review',a,'published.json'),JSON.stringify({bvid:'BV1aa411c7mD'}))
  const code=`import {approveVideo} from ${JSON.stringify(new URL('../host/core.mjs',import.meta.url).href)};console.log(JSON.stringify(await approveVideo(${JSON.stringify(a)},{retry:true})))`
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:s.env,encoding:'utf8'})
  const o=JSON.parse(r.stdout.trim()); assert.equal(o.ok,false); assert.match(o.error,/已经发布过/)
  // 发布过的：她改 meta.json 也重渲染 / 重交不了
  const meta=path.join(s.dsh,'whale-work','studio',a,'meta.json')
  fs.writeFileSync(meta,JSON.stringify({status:'rendered'}))
  assert.match(studio(s,['render',a]).stderr,/已经发布/)
  assert.match(studio(s,['submit',a,'--reason','这是一条很有意思的视频']).stderr,/已经发布/)
})

test('captions never drop text, overfull slides fail loudly, AI tag/statement always survive metadata trimming',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:120000},()=>{
  const r=spawnSync(PY,[path.join(root,'tests/helpers/studio_units.py')],{encoding:'utf8',timeout:100000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/ok/)
})


test('two approvals at the same moment upload only once (exclusive lock)',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason','这是一条很有意思的视频']).status,0)
  const helper=path.join(s.home,'race.mjs')
  fs.writeFileSync(helper,`
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('upload')){fs.appendFileSync(process.env.UPLOAD_LOG,'up\\n');setTimeout(()=>cb(null,'{"ok":true,"bvid":"BV1aa411c7mD"}',''),1500);return {kill(){}}}
      return cp.execFileSync?cb(null,'',''):null
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(new URL('../host/core.mjs',import.meta.url).href)})
    console.log(JSON.stringify(await core.approveVideo(process.argv[2])))
  `)
  const log=path.join(s.home,'uploads.log')
  const env={...s.env,UPLOAD_LOG:log}
  const code=`const {spawn}=require('node:child_process');const ps=[0,1].map(()=>new Promise(r=>{const c=spawn(process.execPath,[${JSON.stringify(helper)},${JSON.stringify(a)}],{env:process.env});let o='';c.stdout.on('data',d=>o+=d);c.on('close',()=>r(o.trim()))}));Promise.all(ps).then(x=>console.log(JSON.stringify(x)))`
  const r=spawnSync(process.execPath,['-e',code],{env,encoding:'utf8',timeout:30000})
  const outs=JSON.parse(r.stdout.trim()).map(x=>JSON.parse(x.split('\n').pop()))
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1,'只能上传一次')
  assert.equal(outs.filter(o=>o.ok).length,1)
  assert.ok(outs.some(o=>!o.ok&&o.needRetry))
})

test('her session: no --auto bypass, own comments capped, owner-only take, file paths fenced',t=>{
  const s=sandbox(t,{},{})
  const agent={...s.env,BILI_WHALE_AGENT:'1',BILI_WHALE_AI_HOME:path.join(s.dsh,'whale-work')}
  const quota=(args,env)=>spawnSync(process.execPath,[path.join(root,'tools/commands/quota.mjs'),...args],{env,encoding:'utf8',timeout:15000})
  // 记账只能由发言工具在进程里做：她在命令行上 record / 不带 --auto 的 react 一律拒绝
  assert.equal(quota(['record','--type','comment','--target','BV1'],agent).status,2)
  assert.equal(quota(['react','--note','主人夸我了'],agent).status,2)
  assert.equal(fs.existsSync(path.join(s.home,'.bili-ai','feedback.json')),false)
  const seed=(n)=>fs.writeFileSync(path.join(s.home,'.bili-ai','quota.json'),JSON.stringify({log:Array.from({length:n},(_,i)=>({at:new Date().toISOString(),type:'comment',auto:true,share:false,target:'BV'+i}))}))
  // 默认不限条数（主人定）：记了很多条也照样放行
  seed(12)
  assert.equal(quota(['check','--type','comment','--target','BVx'],agent).status,0)
  // 主人设了上限才拦
  fs.writeFileSync(s.env.BILI_WHALE_CONFIG,JSON.stringify({owner:{mid:'222',name:'Owner'},quota:{autoDaily:1}}))
  seed(0)
  // 不带 --auto：主人跑 = 不拦；她的会话里 = 按自主算，有上限
  assert.match(quota(['check','--type','comment','--target','BV1'],s.env).stdout,/非自主/)
  assert.equal(quota(['check','--type','comment','--target','BV1'],agent).status,0)
  seed(1)
  const over=quota(['check','--type','comment','--target','BV2'],agent); assert.equal(over.status,2); assert.match(over.stdout,/上限/)
  // 主人那边照常能记
  assert.equal(quota(['record','--type','video','--target','BV:x'],s.env).status,0)
  // reply-draft take 只给主人
  const take=spawnSync(process.execPath,[path.join(root,'tools/commands/reply-draft.mjs'),'take','x'],{env:agent,encoding:'utf8'})
  assert.equal(take.status,2); assert.match(take.stderr,/只给主人/)
  // dynamic-edit / dynamic-image 不许读她家以外的文件（比如凭据）
  const cred=path.join(s.home,'.bili-ai','credentials.json')
  const ed=spawnSync(process.execPath,[path.join(root,'tools/commands/edit-dynamic.mjs'),'123',cred,'--go'],{env:agent,encoding:'utf8'})
  assert.notEqual(ed.status,0); assert.match(ed.stderr,/自己的目录/)
  const di=spawnSync(process.execPath,[path.join(root,'tools/commands/dynamic-image.mjs'),'--image',cred,'--dry'],{env:agent,encoding:'utf8'})
  assert.notEqual(di.status,0); assert.match(di.stderr,/自己目录/)
  const code=`import {agentPathAllowed} from ${JSON.stringify(new URL('../tools/lib/paths.mjs',import.meta.url).href)};console.log(JSON.stringify([agentPathAllowed(process.argv[1]),agentPathAllowed(process.argv[2]),agentPathAllowed(process.argv[3])]))`
  const inside=path.join(s.dsh,'whale-work','a.txt'); fs.writeFileSync(inside,'x')
  const r=spawnSync(process.execPath,['--input-type=module','-e',code,inside,path.join(s.dsh,'whale-work','..','bili-whale.config.json'),cred],{env:agent,encoding:'utf8'})
  assert.deepEqual(JSON.parse(r.stdout.trim()),[true,false,false],r.stderr)
})

test('submit snapshot carries the originality report; local check failure blocks',t=>{
  const s=sandbox(t)
  const a=fakeRendered(s)
  assert.equal(studio(s,['submit',a,'--reason','这是一条很有意思的视频']).status,0)
  assert.ok(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'originality.json')))
  assert.ok(fs.existsSync(path.join(s.home,'.bili-ai','review',a,'submitted.json')))
  // 字幕目录读不了（这里用"是个文件不是目录"模拟）→ 查不成 = 拦
  const b=fakeRendered(s)
  fs.mkdirSync(path.join(s.dsh,'shots'),{recursive:true}); fs.writeFileSync(path.join(s.dsh,'shots','subs'),'not a dir')
  const r=studio(s,['submit',b,'--reason','这是一条很有意思的视频'])
  assert.equal(r.status,2); assert.match(r.stderr,/本地查重没查成/)
})

// VoxCPM 本地配音（2026-10-24）：主人 cast voice --provider voxcpm --use 参考音.wav —— 参考音复制进角色目录，渲染只认那里
test('voxcpm cast voice: --use copies the wav into the cast dir with its text; bad inputs leave the profile alone; she sees a label, not a path',t=>{
  const s=sandbox(t)
  const cli=(args)=>spawnSync(process.execPath,[path.join(root,'host/cli.mjs'),...args],{env:s.env,encoding:'utf8',timeout:20000})
  assert.equal(cli(['cast','add','host','--name','测试角色','--voice','zh-CN-XiaoyiNeural']).status,0)
  const prof=path.join(s.dsh,'cast','host','profile.json')
  const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEfmt '),Buffer.alloc(32,1)])
  const src=path.join(s.home,'pick','g-chat.wav'); fs.mkdirSync(path.dirname(src)); fs.writeFileSync(src,wav)
  // 没给文字、旁边也没有 .json / .txt：拒绝，资料不变
  const before=fs.readFileSync(prof)
  let r=cli(['cast','voice','host','--provider','voxcpm','--use',src]); assert.notEqual(r.status,0); assert.match(r.stdout,/念的是什么/)
  assert.deepEqual(fs.readFileSync(prof),before)
  // 不是 wav / 文件不在 / 不认识的 provider / 文字带控制字符：都拒绝
  const mp3=path.join(s.home,'pick','a.mp3'); fs.writeFileSync(mp3,'ID3')
  assert.notEqual(cli(['cast','voice','host','--provider','voxcpm','--use',mp3,'--ref-text','嗯。']).status,0)
  const fake=path.join(s.home,'pick','fake.wav'); fs.writeFileSync(fake,'not a wav at all')
  assert.match(cli(['cast','voice','host','--provider','voxcpm','--use',fake,'--ref-text','嗯。']).stdout,/RIFF\/WAVE/)
  assert.notEqual(cli(['cast','voice','host','--provider','voxcpm','--use',path.join(s.home,'nope.wav'),'--ref-text','嗯。']).status,0)
  assert.match(cli(['cast','voice','host','--provider','voxcmp','--use','x']).stdout,/不认识的 --provider/)
  assert.match(cli(['cast','voice','host','--provider','voxcpm','--use',src,'--ref-text','有\x1b[2J控制字符']).stdout,/控制字符/)
  assert.deepEqual(fs.readFileSync(prof),before)
  // 旁边的同名 .json 给了文字：成功；参考音复制进角色目录，资料里只有文件名
  fs.writeFileSync(src.replace(/\.wav$/,'.json'),JSON.stringify({text:'嗯……这个我看到了。'}))
  r=cli(['cast','voice','host','--provider','voxcpm','--use',src]); assert.equal(r.status,0,r.stdout+r.stderr)
  assert.match(r.stdout,/没配 VoxCPM 的 Python/)   // 还没配 Python：提醒，但参考音照样存好
  const p=JSON.parse(fs.readFileSync(prof,'utf8'))
  assert.equal(p.tts,'voxcpm'); assert.match(p.voxcpm.ref,/^voice-[0-9a-f]{12}\.wav$/); assert.equal(p.voxcpm.ref_text,'嗯……这个我看到了。'); assert.equal(p.voice,'zh-CN-XiaoyiNeural')
  assert.deepEqual(fs.readFileSync(path.join(s.dsh,'cast','host',p.voxcpm.ref)),wav)   // 按内容起名，不覆盖原来那个（她正在渲染也不受影响）
  assert.ok(!fs.readFileSync(prof,'utf8').includes('pick'),'资料里不留原文件的路径')
  // --ref-text 优先；她的 studio cast 只看到「VoxCPM 本地」
  r=cli(['cast','voice','host','--provider','voxcpm','--use',src,'--ref-text','另一段\t文字。']); assert.equal(r.status,0)
  assert.deepEqual(JSON.parse(fs.readFileSync(prof,'utf8')).voxcpm,{ref:p.voxcpm.ref,ref_text:'另一段 文字。'})   // 同一段音频同一个文件名；Tab 换成空格（studio.py 不收控制字符）
  // 忘了写 --provider voxcpm：不能把 wav 当成 OpenAI 的声音名存进去
  const now=fs.readFileSync(prof)
  r=cli(['cast','voice','host','--use',src]); assert.notEqual(r.status,0); assert.match(r.stdout,/--provider voxcpm/)
  r=cli(['cast','voice','host','--use','sage','--ref-text','嗯。']); assert.notEqual(r.status,0)
  assert.deepEqual(fs.readFileSync(prof),now)
  r=studio(s,['cast']); assert.match(r.stdout,/VoxCPM 本地/); assert.doesNotMatch(r.stdout,/voice\.wav|pick/)
  assert.match(cli(['cast','list']).stdout,/VoxCPM 本地/)
  // 试听之前要先配好 Python / 模型
  r=cli(['cast','voice','host','--provider','voxcpm','--try','current']); assert.notEqual(r.status,0); assert.match(r.stdout,/没配 VoxCPM 的 Python/)
  // 换回 Edge 还是老样子
  r=cli(['cast','voice','host','--provider','edge','--use','zh-CN-XiaoyiNeural']); assert.equal(r.status,0)
  assert.equal(JSON.parse(fs.readFileSync(prof,'utf8')).tts,'edge')
})

test('voxcpm units: ref only from the cast dir, cache keys, one worker per batch, resume after a crash, clear errors',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:180000},()=>{
  const r=spawnSync(PY,[path.join(root,'tests/helpers/voxcpm_units.py')],{encoding:'utf8',timeout:170000})
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/ok/)
})

// 真渲染 + 假 worker（不要显卡）：一次渲染一个 worker、字幕时间轴 = 每句实际时长、重渲染走缓存、剧本里的 voice 不起作用
test('voxcpm voice: one worker per render, cues follow per-sentence durations, cached on re-render, ref only from the cast profile',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-vox-'))
  try{
    const cast=path.join(home,'cast')
    for(const [id,level] of [['x',1],['y',2]]){
      fs.mkdirSync(path.join(cast,id),{recursive:true})
      spawnSync(PY,['-c',`import wave\nw=wave.open(r"${path.join(cast,id,'voice.wav')}","wb");w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes((${level}).to_bytes(2,"little")*8000);w.close()`])
      fs.writeFileSync(path.join(cast,id,'profile.json'),JSON.stringify({name:id,tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考'+id+'。'}}))
    }
    const model=path.join(home,'model');fs.mkdirSync(model)
    const other=path.join(home,'other.wav');fs.copyFileSync(path.join(cast,'y','voice.wav'),other)
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))   // 不看真显卡
    const proj=path.join(home,'p');fs.mkdirSync(proj)
    const lines=[{who:'x',text:'……嗯，我醒了。今天收件箱里有一条留言。',voice:other,instructions:'换个人'},{who:'y',text:'你好，姐姐。'},{who:'x',text:'也许，就先这样吧。'}]
    const write=(ls)=>fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'dialogue',title:'配音测试',scenes:[{bg_prompt:'x',lines:ls}]}))
    write(lines)
    const log=path.join(home,'worker.log')
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py'),FAKE_VOXCPM_LOG:log,BILI_WHALE_IMAGE_KEY:'sk-test'}
    const run=()=>{const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:200000});const o=JSON.parse(r.stdout.trim().split('\n').pop());assert.equal(o.ok,true,r.stdout+r.stderr);return o}
    const ev=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
    run()
    let e=ev()
    assert.equal(e.filter(x=>x.event==='start').length,1,'一次渲染只起一个 worker')
    assert.equal(e[0].has_key,false,'worker 拿不到 OpenAI key')
    const says=e.filter(x=>x.event==='say')
    assert.deepEqual(says.map(x=>x.text),['……嗯，我醒了。','今天收件箱里有一条留言。','你好，姐姐。','也许，就先这样吧。'])
    const shaOf=(f)=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
    const [sx,sy]=[shaOf(path.join(cast,'x','voice.wav')),shaOf(path.join(cast,'y','voice.wav'))]
    // 第一条台词剧本里写了 voice=other.wav（内容和 y 一样）：用的还是 x 的参考音
    assert.deepEqual(says.map(x=>x.ref_sha),[sx,sx,sy,sx],'参考音只从角色目录来')
    assert.equal(says[2].ref_text,'参考y。')
    assert.equal(fs.readdirSync(path.join(home,'tts')).filter(f=>f.endsWith('.json')).length,3)
    const meta=JSON.parse(fs.readFileSync(path.join(home,'tts',fs.readdirSync(path.join(home,'tts')).find(f=>f.endsWith('.json')&&JSON.parse(fs.readFileSync(path.join(home,'tts',f),'utf8')).cues.length===2)),'utf8'))
    assert.ok(meta.cues[1][0]>meta.cues[0][1]+0.4,'句间补了停顿'); assert.ok(Math.abs(meta.dur-meta.cues[1][1])<0.3)
    run(); assert.equal(ev().length,e.length,'重渲染走缓存，不再起 worker')
    write([...lines.slice(0,2),{who:'x',text:'改了最后一句。'}])
    run(); e=ev().slice(e.length)
    assert.equal(e.filter(x=>x.event==='start').length,1); assert.deepEqual(e.filter(x=>x.event==='say').map(x=>x.text),['改了最后一句。'])
    // 不认识的角色：在加载模型之前就失败
    write([{who:'nobody',text:'嗨'}])
    const n=ev().length
    const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:60000})
    assert.match(r.stdout,/不在角色表里/); assert.equal(ev().length,n)
    // Python 没配：说清楚，不悄悄用 Edge
    write(lines.slice(1))
    fs.writeFileSync(cfg,JSON.stringify({...JSON.parse(fs.readFileSync(cfg,'utf8')),voxcpm:{python:path.join(home,'nope.exe'),model}}))
    fs.rmSync(path.join(home,'tts'),{recursive:true,force:true})
    const r2=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:60000})
    assert.match(r2.stdout,/VoxCPM 配音：找不到它的 Python/)
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})

// 换装（2026-10-24）：真 studio.py 渲染（假 VoxCPM worker：不要显卡、不联网）—— 默认穿 profile.json 定的那套，剧本指定就整条换；写错了在起 worker 之前就失败
test('outfit render: the profile default, her script switches the whole video, a wrong outfit fails before the worker starts',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-outfit-'))
  try{
    const cast=path.join(home,'cast'),dir=path.join(cast,'x')
    fs.mkdirSync(dir,{recursive:true})
    spawnSync(PY,['-c',`import wave\nw=wave.open(r"${path.join(dir,'voice.wav')}","wb");w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes((1).to_bytes(2,"little")*8000);w.close()`])
    // 白裙 = 白色方块，黑裙 = 黑色方块，说话版 = 红色（嘴型动画才用；sp0000.png 是闭嘴那张，不该是它）
    const mk=`from PIL import Image\nfrom pathlib import Path\nsp=Path(r"${path.join(dir,'sprites')}")\nfor o,c in (("白裙",(255,255,255,255)),("黑裙",(0,0,0,255)),("白裙/说话",(255,0,0,255))):\n  (sp/o).mkdir(parents=True,exist_ok=True); Image.new("RGBA",(60,90),c).save(sp/o/"neutral.png")`
    const m=spawnSync(PY,['-c',mk],{encoding:'utf8'}); assert.equal(m.status,0,m.stderr)
    fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({name:'x',outfit:'白裙',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
    const model=path.join(home,'model');fs.mkdirSync(model)
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))
    const proj=path.join(home,'p');fs.mkdirSync(proj)
    const write=(extra={})=>fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'diary',title:'换装测试',scenes:[{bg_prompt:'x',lines:[{text:'今天穿什么呢。'}]}],...extra}))
    const log=path.join(home,'worker.log')
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py'),FAKE_VOXCPM_LOG:log}
    const render=()=>{const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:200000});return {r,o:JSON.parse(r.stdout.trim().split('\n').pop())}}
    const colour=()=>JSON.parse(spawnSync(PY,['-c',`from PIL import Image\nim=Image.open(r"${path.join(proj,'build','sp0000.png')}").convert("RGBA")\nprint(list(im.getpixel((im.width//2,im.height//2))))`],{encoding:'utf8'}).stdout).slice(0,3)
    write(); let {r,o}=render()
    assert.equal(o.ok,true,r.stdout+r.stderr); assert.deepEqual(o.outfits,{x:'白裙'}); assert.deepEqual(colour(),[255,255,255])
    write({outfit:{x:'黑裙'}}); ({r,o}=render())
    assert.equal(o.ok,true,r.stdout+r.stderr); assert.deepEqual(o.outfits,{x:'黑裙'}); assert.deepEqual(colour(),[0,0,0])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(proj,'render.json'),'utf8')).outfits,{x:'黑裙'})
    const n=fs.readFileSync(log,'utf8').trim().split('\n').length
    for(const [extra,why] of [[{outfit:{x:'格子裙'}},/没有「格子裙」这套换装/],[{outfit:{y:'黑裙'}},/outfit 里的角色「y」不在角色表里/],[{outfit:{x:'说话'}},/不是合法的换装名/]]){
      write(extra); ({r}=render()); assert.match(r.stdout,why); assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,n,'写错了在起 worker 之前就失败')
    }
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})

// 嘴型（2026-10-24）：真 studio.py 渲染、假 VoxCPM worker（每句一段正弦波，句间停 0.5 秒）。说话的人跟着配音在闭嘴版 / 张嘴版之间换（成片里抽帧看颜色）；
// 听的人一直是变暗的闭嘴 neutral；这个表情没有同名说话版的，照老样子只放闭嘴的（ffmpeg 参数还是以前的格式，没有 enable）
test('mouth flap: the speaker alternates closed/open sprites with her voice, listeners never move, a pair without a talking twin renders as before',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-mouth-'))
  try{
    const cast=path.join(home,'cast')
    // x：闭嘴 = 白、张嘴 = 红；y：闭嘴 = 绿、张嘴 = 品红（她只当听众，不该出现），「浅笑」= 蓝、没有说话版
    const mk=`from PIL import Image\nfrom pathlib import Path\nimport wave\nc=Path(r"${cast}")\nfor cid,figs in (("x",(("白裙/neutral.png",(255,255,255)),("白裙/说话/neutral.png",(255,0,0)))),("y",(("白裙/neutral.png",(0,255,0)),("白裙/说话/neutral.png",(255,0,255)),("白裙/浅笑.png",(0,0,255))))):\n  for rel,col in figs:\n    p=c/cid/"sprites"/rel; p.parent.mkdir(parents=True,exist_ok=True); Image.new("RGBA",(60,90),col+(255,)).save(p)\n  w=wave.open(str(c/cid/"voice.wav"),"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((1).to_bytes(2,"little")*8000); w.close()`
    const m=spawnSync(PY,['-c',mk],{encoding:'utf8'}); assert.equal(m.status,0,m.stderr)
    for(const id of ['x','y']) fs.writeFileSync(path.join(cast,id,'profile.json'),JSON.stringify({name:id,tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
    const model=path.join(home,'model');fs.mkdirSync(model)
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))
    const proj=path.join(home,'p');fs.mkdirSync(proj)
    // x 说一句（假 worker：0.84 秒响、停 0.5 秒、0.96 秒响 → 两个切片），y 用「浅笑」接一句
    fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'dialogue',title:'嘴型测试',scenes:[{bg_prompt:'x',lines:[{who:'x',text:'今天天气很好。我们出去走走吧。'},{who:'y',expr:'浅笑',text:'好的呀，那就走吧。'}]}]}))
    const log=path.join(home,'ffmpeg.jsonl')
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py'),FFMPEG_ARGS_LOG:log}
    const r=spawnSync(PY,[path.join(root,'tests/helpers/render_logged.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:200000})
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok,true,r.stdout+r.stderr)
    // 切片的 ffmpeg 参数：x 的两片多一张 -open.png，两层 overlay 同一个位置、同一条浮动轨迹，按同一组 between() 互斥
    const clipArgs=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(a=>/c\d{4}\.mp4$/.test(a.at(-1)))
    assert.equal(clipArgs.length,3)
    const graph=(a)=>a[a.indexOf('-filter_complex')+1]
    const spansOf=(a)=>[...graph(a).match(/enable='([^']*)'\[v2\]/)[1].matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map(m=>[+m[1],+m[2]])
    for(const a of clipArgs.slice(0,2)){
      const g=graph(a), on=g.match(/enable='([^']*)'\[v2\]/)[1]
      assert.ok(a.some(x=>x.endsWith('sp0000-open.png')),'张嘴版是第二张立绘输入')
      assert.ok(g.includes(`enable='not(${on})'[v2c]`),'闭嘴那层正好是张嘴那层的反面')
      const pos=[...g.matchAll(/overlay=x=(\d+):y='([^']*)'/g)].map(m=>m[1]+'|'+m[2]); assert.equal(pos.length,2); assert.equal(pos[0],pos[1])
      assert.match(g,/\[5:a\]aresample/)
    }
    const [s0,s1]=clipArgs.slice(0,2).map(spansOf)
    assert.ok(s0.length>=2&&s1.length>=2,`一段话里嘴一张一合，不是一直张着：${JSON.stringify([s0,s1])}`)
    assert.ok(s0.every(([a,b])=>b<=1.0||a>=1.2),`两段之间的停顿里闭着嘴：${JSON.stringify(s0)}`)
    assert.ok(s1.every(([a,b])=>b<=1.05),`念完以后（句末停顿）闭着嘴：${JSON.stringify(s1)}`)
    // y 用的「浅笑」没有说话版：和以前一样的参数格式，没有 enable、没有第二张立绘
    const g2=graph(clipArgs[2])
    assert.ok(!clipArgs[2].some(x=>x.endsWith('-open.png')))
    assert.match(g2,/^[^;]+;\[bg\]\[1:v\]overlay=0:0\[v1\];\[v1\]\[3:v\]overlay=x=\d+:y='-?\d+\+9\*sin\(2\*3\.14159\*\([\d.]+\+t\)\/1\.7\)'\[v2\];\[v2\]\[2:v\]overlay=0:0,fps=30,format=yuv420p\[vout\];\[4:a\]aresample=48000,aformat=channel_layouts=stereo,apad\[aout\]$/)
    // 抽帧：每个切片逐帧、成片两帧；看 x（380,450）和 y（1540,450）两个点的颜色
    const FRAMES=`import json, subprocess, sys, imageio_ffmpeg
from pathlib import Path
ff, proj = imageio_ffmpeg.get_ffmpeg_exe(), Path(sys.argv[1])
def px(src, pre=(), post=()):
    cols = []
    for x in (380, 1540):
        r = subprocess.run([ff, "-v", "error", *pre, "-i", str(src), *post, "-vf", f"crop=2:2:{x}:450", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True)
        cols.append([list(r.stdout[i:i + 3]) for i in range(0, len(r.stdout), 12)])
    return [list(f) for f in zip(*cols)]
print(json.dumps({"clips": [px(c) for c in sorted((proj / "build").glob("c*.mp4"))],
                  "final": [px(proj / "final.mp4", ["-ss", t], ["-frames:v", "1"])[0] for t in sys.argv[2:]]}))`
    const [a,b]=s0.reduce((p,q)=>q[1]-q[0]>p[1]-p[0]?q:p)
    const f=spawnSync(PY,['-c',FRAMES,proj,String(2.2+(a+b)/2),String(2.2+1.1)],{encoding:'utf8',timeout:120000}); assert.equal(f.status,0,f.stderr)
    const px=JSON.parse(f.stdout)
    const near=(c,rgb,tol=48)=>c.every((v,i)=>Math.abs(v-rgb[i])<=tol)
    const RED=[255,0,0],WHITE=[255,255,255],DIM_GREEN=[0,128,0]
    // 成片（2.2 秒片头之后是 x 的第一片）：张嘴段中间是张嘴版（红），停顿中间是闭嘴版（白）；y 在旁边听，是变暗的绿
    assert.ok(near(px.final[0][0],RED),`张嘴段中间应该是张嘴版：${px.final[0][0]}`)
    assert.ok(near(px.final[1][0],WHITE),`停顿中间应该是闭嘴版：${px.final[1][0]}`)
    for(const k of [0,1]) assert.ok(near(px.final[k][1],DIM_GREEN),`听的人不张嘴：${px.final[k][1]}`)
    // 逐帧：x 说话的两片里，张嘴段里的帧是红、段外的是白（边界上一帧不管）；y 一直是变暗的绿
    let opened=0,shut=0
    for(const [k,sp] of [[0,s0],[1,s1]]){
      px.clips[k].forEach(([xc,yc],n)=>{
        const t=n/30
        if(sp.some(([a,b])=>t>a+0.02&&t<b-0.02)){opened++; assert.ok(near(xc,RED),`第 ${k} 片 ${t.toFixed(3)} 秒该张嘴：${xc}`)}
        else if(sp.every(([a,b])=>t<a-0.02||t>b+0.02)){shut++; assert.ok(near(xc,WHITE),`第 ${k} 片 ${t.toFixed(3)} 秒该闭嘴：${xc}`)}
        assert.ok(near(yc,DIM_GREEN),`第 ${k} 片 ${t.toFixed(3)} 秒听的人不张嘴：${yc}`)
      })
    }
    assert.ok(opened>=10&&shut>=10,`${opened} 帧张嘴、${shut} 帧闭嘴`)
    // y 说话那片：一直是蓝（「浅笑」没有说话版，不张嘴）；x 变成听的人，是变暗的白
    assert.ok(px.clips[2].length>=20)
    for(const [xc,yc] of px.clips[2]){assert.ok(near(yc,[0,0,255]),`没有说话版的表情不张嘴：${yc}`); assert.ok(near(xc,[128,128,128]),`听的人：${xc}`)}
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})

// 便签（2026-10-25，主人给第一条视频写的台本）：真 studio.py 渲染、假 VoxCPM worker（不要显卡、不联网）。前两个场景一句一页字幕 → 第 n 个切片就是第 n 句；
// 逐帧数便签那一块里米白纸色和红笔道的像素：show 之前没有、show 淡入没划、strike 从左往右划、hide 收起、再 show 还是划过的；
// 第二个场景开头又是收着的，收着时直接 strike、这句又很短：淡入和划线一起压缩，在这一页里划完；
// 第三个场景的台词一句话两句（假 worker 一句一段 → 两页字幕）：只有第一页在动，第二页一开头就是最终的样子；
// 第四个场景两个人：便签在上方正中、压在说话的人下面。动画页（ffmpeg 叠）和静止页（PIL 画）之间便签不挪位置
test('note card: show fades in, strike draws the line left to right, hide removes it, shown again it stays struck',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-note-'))
  try{
    const cast=path.join(home,'cast'),dir=path.join(cast,'x')
    const mk=`from PIL import Image\nfrom pathlib import Path\nimport wave\nd=Path(r"${dir}")\n(d/"sprites"/"白裙").mkdir(parents=True)\nImage.new("RGBA",(300,600),(0,150,90,255)).save(d/"sprites"/"白裙"/"neutral.png")\nw=wave.open(str(d/"voice.wav"),"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((1).to_bytes(2,"little")*8000); w.close()\ny=d.parent/"y"\n(y/"sprites"/"白裙").mkdir(parents=True)\nImage.new("RGBA",(640,600),(40,80,200,255)).save(y/"sprites"/"白裙"/"neutral.png")\nimport shutil; shutil.copy(d/"voice.wav",y/"voice.wav")`
    const m=spawnSync(PY,['-c',mk],{encoding:'utf8'}); assert.equal(m.status,0,m.stderr)
    fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({name:'测试角色',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
    fs.writeFileSync(path.join(cast,'y','profile.json'),JSON.stringify({name:'小鲸',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
    const model=path.join(home,'model');fs.mkdirSync(model)
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))
    const proj=path.join(home,'p');fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'diary',title:'便签测试',bgm:false,scenes:[
      {bg_prompt:'x',note:{label:'上一版的开头',text:'先说一次：我是 AI。',strike:'先说一次'},lines:[
        {text:'你好，我叫测试角色。'},{text:'这是上一版的开头。',note:'show'},{text:'这四个字删掉。',note:'strike'},
        {text:'你也可以叫我小鲸。',note:'hide'},{text:'这句留着。',note:'show'}]},
      {bg_prompt:'y',note:{text:'第二张便签',strike:'便签'},lines:[{text:'新的场景。'},{text:'删掉。',note:'strike',pause:0}]},
      {bg_prompt:'z',note:{label:'上一版的开头',text:'先说一次：我是 AI。',strike:'先说一次'},lines:[
        {text:'这四个字删掉。删了以后干净多了。',note:'strike'},{text:'收起来。',note:'hide'},{text:'再拿出来看看。还是划过的。',note:'show'}]},
      {bg_prompt:'w',cast:['x'],note:{label:'上一版的开头',text:'先说一次：我是 AI。'},lines:[{who:'y',text:'你看这个。',note:'show'},{who:'y',text:'就是这张。'}]}]}))
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py')}
    fs.mkdirSync(path.join(proj,'build')); fs.writeFileSync(path.join(proj,'build','nt0009-000.png'),'上次渲染留下的')
    const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:250000})
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok,true,r.stdout+r.stderr)
    assert.ok(!fs.existsSync(path.join(proj,'build','nt0009-000.png')),'上次渲染留下的便签逐帧图清掉了（她自查看 nt*.png）')
    // 每个切片逐帧数：便签那一块（左上；字幕条上面、她站的右边以外）里米白纸色 / 红笔道各有几个像素
    const COUNT=`import json, subprocess, sys, imageio_ffmpeg
from pathlib import Path
from PIL import Image, ImageChops
ff, build = imageio_ffmpeg.get_ffmpeg_exe(), Path(sys.argv[1])
X, Y, CW, CH = 60, 20, 1080, 520
on = lambda ch, a: ch.point(lambda v: 255 if v >= a else 0)
def cream(im):                     # 米白纸：三个通道都很亮
    r, g, b = im.split()
    return ImageChops.multiply(ImageChops.multiply(on(r, 232), on(g, 222)), on(b, 200)).histogram()[255]
def red(im):                       # 红笔道：红够亮、比绿 / 蓝都高出一截（淡入一半的纸叠在暗黄底上是褐色，不算）
    r, g, b = im.split()
    return ImageChops.multiply(on(r, 150), ImageChops.multiply(on(ImageChops.subtract(r, g), 80), on(ImageChops.subtract(r, b), 80))).histogram()[255]
res, n = [], CW * CH * 3
for c in sorted(build.glob("c*.mp4")):
    raw = subprocess.run([ff, "-v", "error", "-i", str(c), "-vf", f"crop={CW}:{CH}:{X}:{Y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    frames = [Image.frombytes("RGB", (CW, CH), raw[i:i + n]) for i in range(0, len(raw) - n + 1, n)]
    res.append([[cream(im), red(im)] for im in frames])
print(json.dumps(res))`
    const f=spawnSync(PY,['-c',COUNT,path.join(proj,'build')],{encoding:'utf8',timeout:120000}); assert.equal(f.status,0,f.stderr)
    const clips=JSON.parse(f.stdout)
    assert.equal(clips.length,14,'前两个场景 7 句 = 7 个切片；第三个场景两句话两页 + 一句 + 两句话两页 = 5 个；第四个场景 2 个')
    const cream=(k,i)=>clips[k].at(i)[0], red=(k,i)=>clips[k].at(i)[1]
    const PAPER=30000, NONE=50
    const full=red(4,-1)                                         // 再拿出来时（静止、划过的）有多少红
    assert.ok(full>800,`划完的红笔道：${full}`)
    // ① 第一句：还没出来
    for(const [c,rd] of clips[0]) assert.ok(c<NONE&&rd<20,`show 之前不该有便签：${c} / ${rd}`)
    // ② show：淡入（第一帧还看不见，0.3 秒以后整张都在），没划
    assert.ok(cream(1,0)<NONE,`淡入的第一帧：${cream(1,0)}`); assert.ok(cream(1,3)<cream(1,-1)/2,'淡入中')
    for(let i=9;i<clips[1].length;i++) assert.ok(cream(1,i)>PAPER,`show 之后整张都在：第 ${i} 帧 ${cream(1,i)}`)
    assert.ok(clips[1].every(([,rd])=>rd<20),'show：没划')
    // ③ strike：前 0.1 秒还没下笔；0.33 秒左右划了一半上下；0.6 秒以后划完；便签一直在
    assert.ok(clips[2].every(([c])=>c>PAPER*0.8),'划的时候便签一直在')
    for(let i=0;i<=3;i++) assert.ok(red(2,i)<full*0.05,`还没下笔：第 ${i} 帧 ${red(2,i)}`)
    assert.ok(red(2,10)>full*0.25&&red(2,10)<full*0.75,`划到一半：${red(2,10)} / ${full}`)
    for(let i=19;i<clips[2].length;i++) assert.ok(red(2,i)>full*0.85,`划完了：第 ${i} 帧 ${red(2,i)} / ${full}`)
    for(let i=1;i<clips[2].length;i++) assert.ok(red(2,i)>=red(2,i-1)-full*0.05,`从左往右一直往前画：第 ${i} 帧`)
    // ④ hide：收起
    for(const [c,rd] of clips[3]) assert.ok(c<NONE&&rd<20,`hide 之后不该有便签：${c} / ${rd}`)
    // ⑤ 再 show：淡入，还是划过的
    assert.ok(cream(4,0)<NONE)
    for(let i=9;i<clips[4].length;i++){assert.ok(cream(4,i)>PAPER); assert.ok(red(4,i)>full*0.85,`再拿出来还是划过的：第 ${i} 帧`)}
    // ⑥ 第二个场景：开头又是收着的
    for(const [c,rd] of clips[5]) assert.ok(c<NONE&&rd<20,`新场景开头便签收着：${c} / ${rd}`)
    // ⑦ 收着时直接 strike、这句只有 0.6 秒：淡入和划线一起压缩，倒数第二帧之前已经划完
    const last=red(6,-1)
    assert.ok(cream(6,0)<NONE&&cream(6,-1)>PAPER*0.5&&last>300,`${cream(6,0)} / ${cream(6,-1)} / ${last}`)
    assert.ok(red(6,-2)>=last*0.95,`这一页里就划完了：${red(6,-2)} / ${last}`)
    assert.ok(clips[6].some(([,rd])=>rd>last*0.15&&rd<last*0.75),'中间有划到一半的帧')
    // ⑧ 一句话两句（VoxCPM 每句一段 → 两页字幕）：只有第一页在动；第二页一开头就是最终的样子，不会再淡入、再划一遍
    assert.ok(cream(7,0)<NONE&&red(7,-1)>full*0.85,`第一页：淡入 + 划完：${cream(7,0)} / ${red(7,-1)}`)
    for(const k of [8,11]) clips[k].forEach(([c,rd],i)=>assert.ok(c>PAPER&&rd>full*0.85,`第二页一开头就是划过的便签：切片 ${k} 第 ${i} 帧 ${c} / ${rd}`))
    for(const [c,rd] of clips[9]) assert.ok(c<NONE&&rd<20,`hide：${c} / ${rd}`)
    assert.ok(cream(10,0)<NONE&&cream(10,-1)>PAPER,'再 show 的第一页淡入')
    // ⑨ 两个人（y 站左边说话、x 站右边听）：便签在上方正中；说话的人盖在便签上面（她立绘那块里看不到米白纸）
    // ⑩ 动画页（逐帧图 ffmpeg 叠）→ 静止页（PIL 画进听者层）：便签一个像素都不挪（比前一片最后一帧和后一片第一帧，找最像的错位）
    const TWO=`import json, subprocess, sys, imageio_ffmpeg
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
ff, build = imageio_ffmpeg.get_ffmpeg_exe(), Path(sys.argv[1])
on = lambda ch, a: ch.point(lambda v: 255 if v >= a else 0)
def frames(k, box):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    raw = subprocess.run([ff, "-v", "error", "-i", str(build / f"c{k:04d}.mp4"), "-vf", f"crop={w}:{h}:{x0}:{y0}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return [Image.frombytes("L", (w, h), raw[i:i + w * h]) for i in range(0, len(raw) - w * h + 1, w * h)]
raw = subprocess.run([ff, "-v", "error", "-sseof", "-0.1", "-i", str(build / "c0013.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
r, g, b = Image.frombytes("RGB", (1920, 1080), raw[:1920 * 1080 * 3]).split()
m = ImageChops.multiply(ImageChops.multiply(on(r, 232), on(g, 222)), on(b, 200))
out = {"bbox": m.crop((0, 0, 1920, 800)).getbbox(), "under": m.crop((0, 262, 830, 700)).histogram()[255], "jump": []}   # 字幕条（白字）不算
for a, c, box in ((7, 8, (200, 150, 780, 280)), (10, 11, (200, 150, 780, 280)), (12, 13, (980, 150, 1250, 280))):
    A, B = frames(a, box)[-1], frames(c, box)[0]
    w, h = A.size
    err = lambda dx, dy: ImageStat.Stat(ImageChops.difference(A.crop((4, 4, w - 4, h - 4)), B.crop((4 + dx, 4 + dy, w - 4 + dx, h - 4 + dy)))).mean[0]
    best = min((err(dx, dy), dx, dy) for dx in range(-2, 3) for dy in range(-2, 3))
    out["jump"].append([a, c, best[1], best[2], round(best[0], 2), round(err(0, 0), 2)])
# 她自查看的：每串 nt*.png 编号最大的那张 = 出现 / 划完之后的样子（第一次出现没划；收起再拿出来还是划着的）
def red(f):
    card = Image.open(f).convert("RGBA")
    r, g, b = Image.alpha_composite(Image.new("RGBA", card.size, (255, 255, 255, 255)), card).convert("RGB").split()
    return ImageChops.multiply(on(r, 150), ImageChops.multiply(on(ImageChops.subtract(r, g), 80), on(ImageChops.subtract(r, b), 80))).histogram()[255]
out["self"] = [red(sorted(build.glob(f"{p}-*.png"))[-1]) for p in ("nt0001", "nt0002", "nt0004")]
print(json.dumps(out))`
    const t2=spawnSync(PY,['-c',TWO,path.join(proj,'build')],{encoding:'utf8',timeout:120000}); assert.equal(t2.status,0,t2.stderr)
    const two=JSON.parse(t2.stdout)
    assert.ok(two.bbox&&Math.abs((two.bbox[0]+two.bbox[2])/2-960)<60,`两个人：便签在上方正中：${JSON.stringify(two.bbox)}`)
    assert.equal(two.under,0,'说话的人在便签上面')
    for(const [a,c,dx,dy,e,e0] of two.jump) assert.ok(dx===0&&dy===0,`切片 ${a} → ${c}：便签挪了 (${dx}, ${dy})（对齐后差 ${e}，不挪差 ${e0}）`)
    const [shown,struckNow,again]=two.self
    assert.ok(shown===0&&struckNow>500&&again>struckNow*0.9,`自查用的 nt*.png 最后一张：出现 ${shown} / 划完 ${struckNow} / 再拿出来 ${again}`)
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})

// 幻灯片配画（v0.11.16，主人看了栏目第一期：「视频的中间只有蓝色背景，太单调了」）：真 studio.py 渲染（render_logged.py，STUDIO_PY 能换成改之前的那份对比）、
// 假 VoxCPM worker、假出图接口（mock-openai.py：每张画都是 (90,120,200) 的纯色）。slide + bg_prompt → 纸卡里是米白、纸卡外面是那张画（不是深蓝）、她照样站在右下角；
// 没写 bg_prompt 的幻灯片还是深色那一页；两页的背景都是静止的（ffmpeg 参数和以前一样）；关掉出图 → 退回深色那一页，渲染日志里记一行
test('slide card: a slide with bg_prompt sits on a paper card over her painting; without it, or when painting fails, the dark page as before',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-card-'))
  const imgLog=path.join(home,'img.log'), port=18800+Math.floor(Math.random()*500)
  const {spawn}=await import('node:child_process')
  const mock=spawn(PY,[path.join(root,'tests/helpers/mock-openai.py'),String(port),imgLog],{stdio:'ignore'})
  t.after(()=>{mock.kill();fs.rmSync(home,{recursive:true,force:true})})
  await new Promise(r=>setTimeout(r,2500))
  const cast=path.join(home,'cast'),dir=path.join(cast,'x')
  const mk=`from PIL import Image\nfrom pathlib import Path\nimport wave\nd=Path(r"${dir}")\n(d/"sprites"/"白裙").mkdir(parents=True)\nImage.new("RGBA",(60,90),(0,150,90,255)).save(d/"sprites"/"白裙"/"neutral.png")\nw=wave.open(str(d/"voice.wav"),"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((1).to_bytes(2,"little")*8000); w.close()`
  const m=spawnSync(PY,['-c',mk],{encoding:'utf8'}); assert.equal(m.status,0,m.stderr)
  fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({name:'测试角色',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
  const model=path.join(home,'model');fs.mkdirSync(model)
  const cfg=path.join(home,'cfg.json')
  const writeCfg=(image,cache)=>fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,cache),tts_cache_dir:path.join(home,'tts'),image,voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))
  const proj=path.join(home,'p');fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'explainer',series:'栏目',episode:1,title:'配画测试',bgm:false,scenes:[
    {bg_prompt:'清晨的湖，远处有雾',slide:{title:'这一页配了画',bullets:['要点一','要点二'],note:'第 1 期'},lines:[{text:'这一页有画。'}]},
    {slide:{title:'这一页没配画',bullets:['还是深色']},lines:[{text:'这一页没有。'}]}]}))
  const ffLog=path.join(home,'ffmpeg.jsonl')
  const render=(ok=true)=>{
    fs.rmSync(ffLog,{force:true})
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py'),FFMPEG_ARGS_LOG:ffLog,BILI_WHALE_IMAGE_KEY:'sk-test'}
    const r=spawnSync(PY,[path.join(root,'tests/helpers/render_logged.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:200000})
    const out=JSON.parse(r.stdout.trim().split('\n').pop()); assert.equal(out.ok,ok,r.stdout+r.stderr)
    return {out,stderr:r.stderr,clips:ok?fs.readFileSync(ffLog,'utf8').trim().split('\n').map(JSON.parse).filter(a=>/c\d{4}\.mp4$/.test(a.at(-1))):[]}
  }
  // 抽帧（每个切片 0.3 秒那一帧）+ 背景图 bg*.png，看这几个点的颜色
  const PX=`import json, subprocess, sys, imageio_ffmpeg
from pathlib import Path
from PIL import Image
ff, build, pts = imageio_ffmpeg.get_ffmpeg_exe(), Path(sys.argv[1]), json.loads(sys.argv[2])
def frame(c):
    raw = subprocess.run([ff, "-v", "error", "-ss", "0.3", "-i", str(c), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return [list(raw[(y * 1920 + x) * 3:(y * 1920 + x) * 3 + 3]) for x, y in pts]
print(json.dumps({"clips": [frame(c) for c in sorted(build.glob("c*.mp4"))],
                  "bg": [[list(Image.open(b).convert("RGB").getpixel(tuple(p))) for p in pts] for b in sorted(build.glob("bg*.png"))]}))`
  // 纸卡里没字的地方（右边的纸边、短要点右边的空）· 纸卡外面（右上角、纸卡和她之间、左下角字幕外面）· 角标 · 她站的地方
  const CARD=[[1330,300],[1000,450]], OUT=[[1700,100],[1500,400],[40,1000]], BADGE=[146,107], SPRITE=[1670,900]
  const look=()=>{const f=spawnSync(PY,['-c',PX,path.join(proj,'build'),JSON.stringify([...CARD,...OUT,BADGE,SPRITE])],{encoding:'utf8',timeout:120000}); assert.equal(f.status,0,f.stderr); return JSON.parse(f.stdout)}
  const near=(c,rgb,tol)=>c.every((v,i)=>Math.abs(v-rgb[i])<=tol)
  const PAPER_ON_PAINT=[236,234,230], PAINT=[90,120,200], NAVY=[14,20,38]   // 纸 ≈ 90% 米白 (252,246,234) + 10% 画（柔化时对比度降一点，画的颜色往灰里收一点）
  const navy=(c)=>near(c,NAVY,14)
  writeCfg({provider:'openai',baseUrl:`http://127.0.0.1:${port}/v1`,maxPerVideo:4},'cache')
  let {out,stderr,clips}=render()
  assert.equal(out.ai_images,1,'配画的那一页出了一张图；没配画的那一页不出图')
  const reqs=fs.readFileSync(imgLog,'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(reqs.length,1); assert.match(reqs[0].path,/\/images\/generations$/)
  assert.doesNotMatch(stderr,/幻灯片配画没画出来/)
  assert.equal(clips.length,2)
  for(const a of clips) assert.match(a[a.indexOf('-filter_complex')+1],/^\[0:v\]scale=1920:1080,setsar=1\[bg\];/,'幻灯片的背景不平移')
  let px=look()
  const [bg0,bg1]=px.bg, [f0,f1]=px.clips
  // 背景图（PIL 画的，没压缩）：纸卡里是米白，外面就是那张画
  for(const k of [0,1]){assert.ok(near(bg0[k],PAPER_ON_PAINT,3),`纸卡里是米白：${bg0[k]}`); assert.ok(near(f0[k],PAPER_ON_PAINT,12),`成片里纸卡是米白：${f0[k]}`)}
  for(const k of [2,3,4]){assert.ok(near(bg0[k],PAINT,16),`纸卡外面就是那张画（稍微柔化）：${bg0[k]}`); assert.ok(near(f0[k],PAINT,20),`成片里纸卡外面是那张画，不是深蓝：${f0[k]}`)}
  assert.ok(near(f0[5],[255,138,92],30),`角标是她的颜色：${f0[5]}`)
  assert.ok(near(f0[6],[0,150,90],30),`她照样站在右下角：${f0[6]}`)
  // 没写 bg_prompt 的那一页：深色、网格，和以前一样
  for(const k of [0,1,2,3,4]){assert.ok(navy(bg1[k]),`没配画的幻灯片还是深蓝：${bg1[k]}`); assert.ok(navy(f1[k]),`成片里也是：${f1[k]}`)}
  assert.ok(near(f1[6],[0,150,90],30))
  // 关掉出图（换一个空缓存）：配画的那一页退回深色，日志里说一声；不调用出图接口。
  // 再加一页纸卡放不下、深色那一页放得下的（角注 37 字：深色那一页最多 40 字，纸卡窄）：没开出图本来就是深色那一页 → 不拦渲染，日志里说一声
  const sj=JSON.parse(fs.readFileSync(path.join(proj,'script.json'),'utf8'))
  sj.scenes.push({bg_prompt:'书桌',slide:{title:'这一页的角注太长',bullets:['纸卡放不下'],note:'例题是我自己出的，讲义只看了目录和定义，所以有错是我的，欢迎在评论区指出来'},lines:[{text:'这一页角注太长。'}]})
  fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify(sj))
  writeCfg({provider:'none'},'cache2');
  ({out,stderr,clips}=render())
  assert.equal(out.ai_images,0)
  assert.match(stderr,/场景 1 的幻灯片配画没画出来（没开 AI 出图）→ 用深色幻灯片/)
  assert.match(stderr,/场景 3 的幻灯片在纸卡上放不下，也没开 AI 出图 → 用深色幻灯片/)
  assert.equal(fs.readFileSync(imgLog,'utf8').trim().split('\n').length,1)
  px=look()
  for(const k of [0,1,2,3,4]){assert.ok(navy(px.bg[0][k]),`画不出来 → 深色那一页：${px.bg[0][k]}`); assert.ok(navy(px.clips[0][k]),`${px.clips[0][k]}`)}
  for(const k of [0,1,2,3,4]) assert.ok(navy(px.bg[2][k]),`纸卡放不下、没开出图 → 深色那一页：${px.bg[2][k]}`)
  // 开着出图时纸卡放不下：渲染前就报错，说清楚是纸卡的事（不白花一张：第 1 页走缓存，第 3 页没去出图）
  writeCfg({provider:'openai',baseUrl:`http://127.0.0.1:${port}/v1`,maxPerVideo:4},'cache');
  ({out}=render(false))
  assert.match(out.error,/note 太长/); assert.match(out.error,/纸卡比深色那一页窄/); assert.match(out.error,/bg_prompt/)
  assert.equal(fs.readFileSync(imgLog,'utf8').trim().split('\n').length,1,'纸卡放不下：一张图都没多出')
})

// 自查图（v0.11.20，记忆方案第一项）：真 studio.py 渲染、假 VoxCPM worker、不开出图（不联网、不用显卡）。三个场景：要了画没画出来（渐变底）·
// 深色幻灯片（要点里有雅黑没有的 ₁、ℝ）· 没写画面、有便签（出现 → 划掉 → 收起 → 再拿出来）；封面要了画（没开出图，画不出来）。
// 上次渲染留下的自查图 / 大图 / 临时文件先清掉；check.jpg 1280 宽、≤ 1.15 MP、≤ 400 KB；
// 画没画出来的那一格、有方框字的那一格、封面有琥珀色，别的格子没有；回报里列出缺的字；便签放大两格（划完、收起后又拿出来）都有红笔道，
// 字幕放大格里有白字；check.json 里都是整数、时间一个比一个晚；每一格的大图 frame-sNN.jpg 是 1280×720。
// 再渲染一次、让抽帧坏掉：渲染照样成功，check_pages 0、原因写着，刚才那份自查图没了（她不会看着上一次的图自查）；缺的字照样列出来
test('contact sheet: render writes build/check.jpg (cover + one tile per scene + zoomed note/captions) and frame-sNN.jpg; amber on a failed cover painting and on missing glyphs; a failing sheet never fails the render',{skip:!PY&&'设 STUDIO_TEST_PYTHON 才跑',timeout:300000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-sheet-'))
  try{
    const cast=path.join(home,'cast'),dir=path.join(cast,'x')
    const mk=`from PIL import Image\nfrom pathlib import Path\nimport wave\nd=Path(r"${dir}")\n(d/"sprites"/"白裙").mkdir(parents=True)\nImage.new("RGBA",(300,600),(0,150,90,255)).save(d/"sprites"/"白裙"/"neutral.png")\nw=wave.open(str(d/"voice.wav"),"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((1).to_bytes(2,"little")*8000); w.close()`
    const m=spawnSync(PY,['-c',mk],{encoding:'utf8'}); assert.equal(m.status,0,m.stderr)
    fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({name:'测试角色',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:'参考。'}}))
    const model=path.join(home,'model');fs.mkdirSync(model)
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:cast,cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:PY,model,minFreeMB:0,maxBusyPct:100}}))
    const proj=path.join(home,'p'),build=path.join(proj,'build');fs.mkdirSync(build,{recursive:true})
    fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({format:'diary',title:'自查图测试',bgm:false,cover:{text:'自查图',prompt:'测试角色在湖边看日出'},scenes:[
      {bg_prompt:'清晨的湖',lines:[{text:'今天想讲一件我自己也想了很久的事，为什么有些顺序不能换，明明看起来都一样。'},{text:'先从一个小例子开始。'}]},
      {slide:{title:'这一页是幻灯片',bullets:['要点一','x₁ ∈ ℝ']},lines:[{text:'这一页讲要点。'}]},
      {note:{label:'上一版的开头',text:'先说一次：我是 AI。',strike:'先说一次'},lines:[
        {text:'这是上一版的开头。',note:'show'},{text:'这四个字删掉。',note:'strike'},{text:'收起来。',note:'hide'},{text:'再拿出来看看。',note:'show'}]}]}))
    for(const f of ['check-3.jpg','frame-s09.jpg','check.json','check.jpg.0123abcd.part']) fs.writeFileSync(path.join(build,f),'上次渲染留下的')
    const env={...process.env,BILI_WHALE_VOXCPM_WORKER:path.join(root,'tests/helpers/fake_voxcpm_worker.py')}
    let r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:250000})
    let out=JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(out.ok,true,r.stdout+r.stderr)
    assert.equal(out.check_pages,1,r.stderr); assert.equal(out.check_error,null)
    // 方框字：雅黑没有 ₁ 和 ℝ（∈ 有）；封面要了画、没开出图：以前一行日志都没有
    assert.deepEqual(out.missing_glyphs,[{scene:2,chars:'₁ℝ'}])
    assert.match(r.stderr,/场景 2 有字体里没有的字（画出来是方框）：₁ ℝ/)
    assert.match(r.stderr,/封面画没画出来（没开 AI 出图）→ 用第一个场景的画面/)
    for(const f of ['check-3.jpg','frame-s09.jpg','check.jpg.0123abcd.part']) assert.ok(!fs.existsSync(path.join(build,f)),`上次留下的 ${f} 清掉了`)
    assert.ok(!fs.readdirSync(build).some(f=>f.endsWith('.part')),'没有写了一半的临时文件')
    const took=Number((r.stderr.match(/自查图：1 页（用了 ([\d.]+) 秒）/)??[])[1])
    assert.ok(took>=0&&took<60,`自查图花了 ${took} 秒`)
    assert.deepEqual(Object.keys(out.hashes).sort(),['cover.jpg','final.mp4','script.json'],'自查图不进回执')
    // check.json：成片的指纹对得上；每个切片是哪个场景、第几句（剧本里的编号）、在成片里从第几秒开始
    const meta=JSON.parse(fs.readFileSync(path.join(build,'check.json'),'utf8'))
    assert.equal(meta.final_sha,sha(path.join(proj,'final.mp4'))); assert.equal(meta.pages,1); assert.equal(meta.scenes,3); assert.equal(meta.sampled,false)
    assert.equal(meta.clips.length,7)
    for(const c of meta.clips) for(const k of ['file','scene','line','page']) assert.ok(Number.isInteger(c[k])&&c[k]>=0,JSON.stringify(c))
    assert.deepEqual(meta.clips.map(c=>[c.scene,c.line]),[[1,1],[1,2],[2,1],[3,1],[3,2],[3,3],[3,4]])
    assert.equal(meta.clips[0].at,2.2,'片头 2.2 秒之后是第一个切片')
    meta.clips.slice(1).forEach((c,i)=>{assert.ok(c.at>meta.clips[i].at,'时间一个比一个晚'); assert.ok(Math.abs(c.at-meta.clips[i].at-meta.clips[i].dur)<0.01)})
    // 格子：封面 + 三个场景；封面画没画出来、场景画没画出来、有方框字的格子写着原因；便签场景抽的是划完那一句（第 2 句）
    assert.deepEqual(meta.tiles.map(x=>[x.scene,x.warn??null]),[[0,'封面画没画出来'],[1,'没画出来→渐变底'],[2,'缺字×2'],[3,null]])
    assert.equal(meta.tiles[3].line,2,'便签场景：划完的样子')
    assert.deepEqual(meta.tiles.slice(1).map(x=>x.frame),['frame-s01.jpg','frame-s02.jpg','frame-s03.jpg'])
    // 便签放大两格：划完（第 2 句）+ 收起后又拿出来（第 4 句：她看它还划着），剩下两格是字幕
    assert.deepEqual(meta.details.map(d=>[d.kind,d.scene,d.line]).slice(0,2),[['note',3,2],['note-again',3,4]])
    assert.ok(meta.details.length===4&&meta.details.slice(2).every(d=>d.kind==='caption'),JSON.stringify(meta.details))
    const LOOK=`import json, sys
from pathlib import Path
from PIL import Image, ImageChops
build = Path(sys.argv[1]); meta = json.loads((build / "check.json").read_text(encoding="utf-8"))
src = Image.open(build / "check.jpg"); fmt, size = src.format, src.size; im = src.convert("RGB")
on = lambda ch, a: ch.point(lambda v: 255 if v >= a else 0)
off = lambda ch, a: ch.point(lambda v: 255 if v <= a else 0)
mul = lambda *ms: ms[0] if len(ms) == 1 else ImageChops.multiply(ms[0], mul(*ms[1:]))
def amber(box):                    # 琥珀色 (255,184,40)：她幻灯片的强调色 (255,140,90)、米白纸都不算
    r, g, b = im.crop(box).split()
    return mul(on(r, 215), on(g, 160), off(g, 210), off(b, 75)).histogram()[255]
def red(box):                      # 红笔道
    r, g, b = im.crop(box).split()
    return mul(on(r, 150), on(ImageChops.subtract(r, g), 80), on(ImageChops.subtract(r, b), 80)).histogram()[255]
def white(box):                    # 字幕的白字（渐变底最亮也到不了，米白纸的蓝通道也不够）
    r, g, b = im.crop(box).split()
    return mul(on(r, 238), on(g, 238), on(b, 238)).histogram()[255]
print(json.dumps({"format": fmt, "size": size, "bytes": (build / "check.jpg").stat().st_size,
                  "tiles": [amber(t["box"]) for t in meta["tiles"]],
                  "details": [[d["kind"], red(d["box"]), white(d["box"])] for d in meta["details"]],
                  "frames": [Image.open(build / t["frame"]).size for t in meta["tiles"] if t.get("frame")]}))`
    const f=spawnSync(PY,['-c',LOOK,build],{encoding:'utf8',timeout:60000}); assert.equal(f.status,0,f.stderr)
    const look=JSON.parse(f.stdout)
    assert.equal(look.format,'JPEG'); assert.equal(look.size[0],1280); assert.ok(look.size[0]*look.size[1]<=1150000,`${look.size}`)
    assert.ok(look.bytes<=400000,`${look.bytes} 字节`)
    for(const k of [0,1,2]) assert.ok(look.tiles[k]>800,`封面画没画出来、场景画没画出来、有方框字的那几格框成琥珀色：${look.tiles}`)
    assert.ok(look.tiles[3]<40,`别的格子没有琥珀色：${look.tiles}`)
    const [note,again,...caps]=look.details
    assert.ok(note[1]>60,`便签放大格里有红笔道：${JSON.stringify(look.details)}`)
    assert.ok(again[1]>60,`收起后又拿出来的便签还划着：${JSON.stringify(look.details)}`)
    assert.ok(caps.some(([,,w])=>w>150),`字幕放大格里有白字：${JSON.stringify(look.details)}`)
    assert.deepEqual(look.frames,[[1280,720],[1280,720],[1280,720]])
    // 抽帧坏掉：渲染照样成功；刚才那份自查图、大图、check.json 都清掉了，回报里写着原因
    const BOOM=`import importlib.util, sys
spec = importlib.util.spec_from_file_location("studio", sys.argv[1]); S = importlib.util.module_from_spec(spec); sys.modules["studio"] = S; spec.loader.exec_module(S)
def boom(*a, **k):
    raise RuntimeError("测试：抽帧坏了")
S._grab_frame = boom
sys.argv = sys.argv[1:]
S.main()`
    r=spawnSync(PY,['-c',BOOM,path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',env,timeout:250000})
    out=JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(out.ok,true,r.stdout+r.stderr); assert.ok(fs.statSync(path.join(proj,'final.mp4')).size>10000)
    assert.equal(out.check_pages,0); assert.match(out.check_error??'',/测试：抽帧坏了/)
    assert.deepEqual(out.missing_glyphs,[{scene:2,chars:'₁ℝ'}],'自查图没做成，缺的字照样列出来')
    assert.match(r.stderr,/自查图没做成（渲染照样成功）：测试：抽帧坏了/)
    assert.deepEqual(fs.readdirSync(build).filter(x=>/^(check|frame-)/.test(x)),[],'做不成就一张都不留')
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})

// 真 VoxCPM（本机显卡、本地模型，不联网）：VOXCPM_TEST_PYTHON / VOXCPM_TEST_MODEL / VOXCPM_TEST_REF（旁边要有同名 .json 的 text）都设了才跑
const VOX_PY=process.env.VOXCPM_TEST_PYTHON, VOX_MODEL=process.env.VOXCPM_TEST_MODEL, VOX_REF=process.env.VOXCPM_TEST_REF
test('voxcpm real: the real worker on the local GPU — one model load per render, every sentence voiced, cues in order',{skip:!(PY&&VOX_PY&&VOX_MODEL&&VOX_REF)&&'设 STUDIO_TEST_PYTHON + VOXCPM_TEST_PYTHON / _MODEL / _REF 才跑（用本机显卡）',timeout:900000},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-voxreal-'))
  try{
    const cast=path.join(home,'cast','x');fs.mkdirSync(cast,{recursive:true})
    fs.copyFileSync(VOX_REF,path.join(cast,'voice.wav'))
    const refText=JSON.parse(fs.readFileSync(VOX_REF.replace(/\.wav$/i,'.json'),'utf8')).text
    fs.writeFileSync(path.join(cast,'profile.json'),JSON.stringify({name:'测试角色',tts:'voxcpm',voxcpm:{ref:'voice.wav',ref_text:refText}}))
    const cfg=path.join(home,'cfg.json');fs.writeFileSync(cfg,JSON.stringify({host:'x',cast_dir:path.join(home,'cast'),cache_dir:path.join(home,'cache'),tts_cache_dir:path.join(home,'tts'),image:{provider:'none'},voxcpm:{python:VOX_PY,model:VOX_MODEL}}))
    const proj=path.join(home,'p');fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj,'script.json'),JSON.stringify({title:'真配音测试',scenes:[{bg_prompt:'x',lines:[{text:'大家好，我是测试角色。这周其实没怎么睡好。'},{text:'下次……下次应该会准时一点。'}]}]}))
    const t0=Date.now()
    const r=spawnSync(PY,[path.join(root,'studio/studio.py'),'render',proj,'--config',cfg],{encoding:'utf8',timeout:850000})
    const out=JSON.parse(r.stdout.trim().split('\n').pop()); assert.equal(out.ok,true,r.stdout+r.stderr)
    assert.equal((r.stderr.match(/VoxCPM 本地配音：/g)??[]).length,1,'一次渲染只加载一次模型')
    const metas=fs.readdirSync(path.join(home,'tts')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(home,'tts',f),'utf8')))
    assert.equal(metas.length,2)
    for(const m of metas){
      m.cues.forEach((c,k)=>{assert.ok(c[1]-c[0]>0.5,`第 ${k} 句太短：${JSON.stringify(c)}`); if(k) assert.ok(c[0]>m.cues[k-1][1])})
      assert.ok(Math.abs(m.dur-m.cues.at(-1)[1])<0.3)
    }
    console.log(`真 VoxCPM 渲染 ${out.seconds} 秒的片子用了 ${((Date.now()-t0)/1000).toFixed(1)} 秒；成片在 ${out.final}（测试结束会删掉）`)
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})
