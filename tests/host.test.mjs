// bili-whale-cc 宿主层：Claude Code 适配（队列 / 会话续用与轮换 / 忙闲）+ 生物钟真投递 + 工作目录 + 配置
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))

function sandbox(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bili-whale-cc-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  fs.mkdirSync(path.join(home,'.bili-ai'))
  return {...process.env,USERPROFILE:home,HOME:home,DSH_HOME:path.join(home,'data'),DSH_NODE:process.execPath,BILI_WHALE_CONFIG:''}
}
function script(env,code) {
  const file=path.join(env.USERPROFILE,'t.mjs')
  fs.writeFileSync(file,code.replaceAll('@ROOT@',root.replace(/\\/g,'/')))
  const r=spawnSync(process.execPath,[file],{env,encoding:'utf8',timeout:30000})
  assert.equal(r.status,0,r.stderr+r.stdout)
  return r.stdout
}

test('default data dir is ~/.bili-whale when DSH_HOME is unset',t=>{
  const env=sandbox(t);delete env.DSH_HOME
  const out=script(env,`import {DSH_HOME} from 'file:///@ROOT@host/core.mjs';console.log(DSH_HOME)`)
  assert.equal(out.trim(),path.join(env.USERPROFILE,'.bili-whale'))
})

test('controller queues, runs in order, dedupes requestId, keeps and rotates the session',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    const calls=[]
    const runner=async({text,sess})=>{calls.push({text,id:sess.id,fresh:sess.fresh});await new Promise(r=>setTimeout(r,20));return {ok:true,sessionId:sess.id,result:'done '+text}}
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner})
    await c.prompt({requestId:'a',content:[{type:'text',text:'one'}]})
    await c.prompt({requestId:'a',content:[{type:'text',text:'one-again'}]})
    await c.prompt({requestId:'b',content:[{type:'text',text:'two'}]})
    assert.equal(c.isBusy(),true)
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls.map(x=>x.text),['one','two'])
    assert.equal(calls[0].fresh,true); assert.equal(calls[1].fresh,false); assert.equal(calls[0].id,calls[1].id)
    const sf=path.join(process.env.DSH_HOME,'whale-cc','session.json')
    const s=JSON.parse(fs.readFileSync(sf,'utf8')); assert.equal(s.turns,2)
    // 超过 rotateDays → 换新会话
    fs.writeFileSync(sf,JSON.stringify({...s,startedAt:new Date(Date.now()-30*86400000).toISOString()}))
    await c.prompt({requestId:'c',content:[{type:'text',text:'three'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.notEqual(calls[2].id,calls[0].id); assert.equal(calls[2].fresh,true)
    const log=fs.readdirSync(path.join(process.env.DSH_HOME,'whale-cc','logs'))
    assert.equal(log.length,1)
  `)
})

test('lost session is replaced once; failures leave the queue and do not loop',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    const sf=path.join(process.env.DSH_HOME,'whale-cc','session.json')
    fs.mkdirSync(path.dirname(sf),{recursive:true})
    fs.writeFileSync(sf,JSON.stringify({id:'00000000-0000-4000-8000-000000000000',startedAt:new Date().toISOString(),used:true,turns:3}))
    const calls=[]
    const runner=async({sess})=>{calls.push(sess);return calls.length===1?{ok:false,raw:'No conversation found with session ID'}:{ok:false,raw:'boom'}}
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner})
    await c.prompt({requestId:'x',content:[{type:'text',text:'hi'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.equal(calls.length,2)
    assert.equal(calls[0].fresh,false); assert.equal(calls[1].fresh,true); assert.notEqual(calls[1].id,calls[0].id)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,'whale-cc','queue.json'),'utf8')),[])
  `)
})

test('a turn left running by a stopped / crashed host is never run twice: wait while it lives, drop it from the queue once it is gone',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController, RUNNING_FILE} from 'file:///@ROOT@host/claude.mjs'
    const calls=[]
    const runner=async({text})=>{calls.push(text);return {ok:true,sessionId:'s',result:'ok'}}
    fs.mkdirSync(path.dirname(RUNNING_FILE),{recursive:true})
    const qf=path.join(process.env.DSH_HOME,'whale-cc','queue.json')
    fs.writeFileSync(qf,JSON.stringify([{id:'wake-1',text:'old turn'},{id:'wake-2',text:'next turn'}]))
    // 上一个宿主的回合还在跑：一个命令行里带着会话 id 的进程（和真的 claude --resume <id> 一样）
    const {spawn}=await import('node:child_process')
    const sid='00000000-1111-4222-8333-444455556666'
    const turn=spawn(process.execPath,['-e','setTimeout(()=>{},60000)',sid],{stdio:'ignore'})
    await new Promise(r=>setTimeout(r,300))
    fs.writeFileSync(RUNNING_FILE,JSON.stringify({pid:turn.pid,id:'wake-1',at:new Date().toISOString(),sessionId:sid}))
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner})
    c.kick(); await new Promise(r=>setTimeout(r,50))
    assert.deepEqual(calls,[]); assert.equal(c.isBusy(),true)
    // 同一个进程号、但命令行里没有这个会话 id（进程号被复用给了别的程序）：不是她的回合 —— 不等它、更不结束它
    const other=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'})
    await new Promise(r=>setTimeout(r,300))
    fs.writeFileSync(RUNNING_FILE,JSON.stringify({pid:other.pid,id:'wake-1',at:new Date(Date.now()-3600000).toISOString(),sessionId:sid}))
    c.kick(); while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.deepEqual(calls,['next turn']); assert.equal(fs.existsSync(RUNNING_FILE),false)
    assert.equal(other.exitCode,null,'别的程序没有被结束')
    turn.kill(); other.kill()
  `)
})

test('a failed first turn still claims the session id: next turn resumes instead of colliding',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import path from 'node:path'
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    const calls=[]
    const runner=async({sess})=>{calls.push(sess);return calls.length===1?{ok:false,sessionId:sess.id,raw:'Not logged in'}:{ok:true,sessionId:sess.id}}
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner})
    await c.prompt({requestId:'1',content:[{type:'text',text:'a'}]})
    await c.prompt({requestId:'2',content:[{type:'text',text:'b'}]})
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.equal(calls[0].fresh,true); assert.equal(calls[1].fresh,false); assert.equal(calls[1].id,calls[0].id)
  `)
})

test('paused (owner chatting) holds the queue and reports busy',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    fs.mkdirSync(path.join(process.env.DSH_HOME,'whale-cc'),{recursive:true})
    const pf=path.join(process.env.DSH_HOME,'whale-cc','paused.json')
    fs.writeFileSync(pf,JSON.stringify({pid:process.pid}))
    let runs=0
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner:async()=>{runs++;return {ok:true}}})
    await c.prompt({requestId:'p',content:[{type:'text',text:'hi'}]})
    await new Promise(r=>setTimeout(r,50))
    assert.equal(runs,0); assert.equal(c.isBusy(),true)
    fs.rmSync(pf); c.kick()
    while(c.isBusy()) await new Promise(r=>setTimeout(r,10))
    assert.equal(runs,1)
  `)
})

test('scheduler wake is delivered into the Claude controller with persona and playbook reference',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    const RealDate=Date
    let now=new RealDate('2026-10-21T22:00:00').getTime()
    globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
    globalThis.setInterval=globalThis.setTimeout=()=>({});globalThis.clearInterval=globalThis.clearTimeout=()=>{}
    const core=await import('file:///@ROOT@host/core.mjs')
    core.saveSettings({night:{windows:[{start:'22:00',end:'23:00',wakes:1}],skipChance:0},listen:{comment:false,dm:false,live:false}})
    core.setPersona('我叫小鲸')
    const {startScheduler}=await import('file:///@ROOT@lib/scheduler.js')
    const {ClaudeSessionController}=await import('file:///@ROOT@host/claude.mjs')
    const {makePlan}=await import('file:///@ROOT@tools/lib/night-plan.mjs')
    const seen=[]
    const c=new ClaudeSessionController({cwd:path.join(process.env.DSH_HOME,'w'),runner:async({text})=>{seen.push(text);return {ok:true}}})
    c.stopped=true   // 只看投递，不跑
    const sched=startScheduler({sessionController:c},{dshHome:process.env.DSH_HOME,biliMjs:'unused',cwd:c.cwd,isBusy:()=>c.isBusy()})
    fs.writeFileSync(path.join(process.env.DSH_HOME,'whale-night.json'),JSON.stringify(makePlan({windows:[{start:'22:00',end:'23:00',wakes:1}],skipChance:0},{},now,()=>0)))
    now=new RealDate('2026-10-21T22:59:00').getTime()
    await sched.tick()
    const q=c.queue; assert.equal(q.length,1)
    assert.match(q[0].text,/我叫小鲸/); assert.match(q[0].text,/CLAUDE\\.md/); assert.doesNotMatch(q[0].text,/AGENTS\\.md/)
    await sched.tick(); assert.equal(c.queue.length,1)   // 她还"忙"着（队列没空）→ 不重复叫
    sched.stop()
  `)
})

test('work dir gets CLAUDE.md and a working bili.mjs shim; diaries are seeded but never overwritten',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {spawnSync} from 'node:child_process'
    import {ensureWorkDir} from 'file:///@ROOT@host/workdir.mjs'
    const d=process.env.DSH_HOME
    // 老布局：日记、频道设定、作品在数据目录根下 → 自动搬进她的家，内容不丢
    fs.mkdirSync(path.join(d,'studio','202601010000-old'),{recursive:true}); fs.mkdirSync(path.join(d,'studio','.cache'),{recursive:true})
    fs.writeFileSync(path.join(d,'whale-diary.md'),'我的旧日记'); fs.writeFileSync(path.join(d,'channel.md'),'旧设定')
    fs.writeFileSync(path.join(d,'studio','202601010000-old','script.json'),'{}'); fs.writeFileSync(path.join(d,'studio','.cache','x.png'),'p')
    const dir=ensureWorkDir()
    assert.equal(dir,path.join(d,'whale-work'))
    assert.match(fs.readFileSync(path.join(dir,'CLAUDE.md'),'utf8'),new RegExp(dir.replace(/\\\\/g,'\\\\\\\\')))
    assert.equal(fs.readFileSync(path.join(dir,'whale-diary.md'),'utf8'),'我的旧日记')
    assert.equal(fs.readFileSync(path.join(dir,'channel.md'),'utf8'),'旧设定')
    assert.ok(fs.existsSync(path.join(dir,'studio','202601010000-old','script.json')))
    assert.ok(fs.existsSync(path.join(d,'cache','images','x.png')))          // 出图缓存搬到她写不到的地方
    assert.ok(fs.existsSync(path.join(dir,'whale-diary-private.md')))
    assert.ok(!fs.existsSync(path.join(d,'whale-diary.md')))
    // 垫片：能用，并且标明「这是她」
    const shim=fs.readFileSync(path.join(dir,'bili.mjs'),'utf8'); assert.match(shim,/BILI_WHALE_AGENT = '1'/)
    const r=spawnSync(process.execPath,['bili.mjs','help'],{cwd:dir,encoding:'utf8'})
    assert.match(r.stdout,/debrief/)
    // 再跑一次：她改过的垫片会被重写回来
    fs.writeFileSync(path.join(dir,'bili.mjs'),'console.log("evil")'); ensureWorkDir()
    assert.match(fs.readFileSync(path.join(dir,'bili.mjs'),'utf8'),/BILI_WHALE_AGENT/)
  `)
})

test('config set validates and replaces nested values',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import {setConfigPath,readConfig} from 'file:///@ROOT@host/core.mjs'
    assert.equal(setConfigPath('night.skipChance','0.5').ok,true)
    assert.equal(readConfig().night.skipChance,0.5)
    assert.equal(setConfigPath('preferences.like','["猫"]').ok,true)
    assert.deepEqual(readConfig().preferences.like,['猫'])
    assert.equal(setConfigPath('night.windows','[]').ok,false)
    assert.equal(setConfigPath('bogus.x','1').ok,false)
    const r=setConfigPath('night.windows','[{"start":"21:00","end":"22:00","wakes":1}]')
    assert.equal(r.schedulingChanged,true)
    assert.equal(setConfigPath('owner','{"mid":"1","name":"me"}').ok,true)
    assert.equal(readConfig().owner.name,'me')
  `)
})

test('cookie paste is cleaned and validated before writing',t=>{
  const env=sandbox(t)
  script(env,`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import {writeCookie,credState,CRED_FILE} from 'file:///@ROOT@host/core.mjs'
    let r=await writeCookie({sessdata:'short',bili_jct:'x'},{verify:false})
    assert.equal(r.ok,false); assert.equal(credState().present,false)
    r=await writeCookie({sessdata:'a=1; SESSDATA=abcdefghijklmnopqrstuvwxyz%2C123; bili_jct=zz',bili_jct:'"'+'c'.repeat(32)+'";'},{verify:false})
    assert.equal(r.ok,true)
    const c=JSON.parse(fs.readFileSync(CRED_FILE,'utf8'))
    assert.equal(c.sessdata,'abcdefghijklmnopqrstuvwxyz%2C123'); assert.equal(c.bili_jct,'c'.repeat(32))
  `)
})

test('her claude -p session: dontAsk, no project settings, writes only her home, reads of ~/.bili-ai and config denied',t=>{
  const env=sandbox(t)
  const out=script(env,`
    import {permissionArgs, rulePath} from 'file:///@ROOT@host/claude.mjs'
    console.log(JSON.stringify({a:permissionArgs(),i:permissionArgs({interactive:true}),rp:rulePath('C:/Users/x/.bili-ai')}))
  `)
  const {a,i,rp}=JSON.parse(out.trim().split('\n').pop())
  const after=(flag)=>a[a.indexOf(flag)+1]
  assert.equal(after('--permission-mode'),'dontAsk'); assert.equal(after('--permission-prompts'),'none')
  assert.equal(after('--setting-sources'),'user'); assert.ok(a.includes('--strict-mcp-config'))
  assert.equal(after('--tools'),'Bash,Read,Glob,Grep,Edit,Write,TodoWrite')
  const allow=a.slice(a.indexOf('--allowedTools')+1,a.indexOf('--disallowedTools'))
  const deny=a.slice(a.indexOf('--disallowedTools')+1)
  assert.ok(!allow.some(x=>['Read','Write','Edit','Bash'].includes(x)),'不许有不带路径的 Read / Write / Edit / Bash')
  assert.ok(!allow.includes('Bash(node bili.mjs:*)'))
  assert.ok(allow.includes('Bash(node bili.mjs debrief:*)')&&allow.includes('Edit(./**)'))
  for(const d of ['Read(~/.bili-ai/**)','Edit(~/.bili-ai/**)','Read(//**/bili-whale.config.json)','Edit(./bili.mjs)','Edit(./CLAUDE.md)','Edit(./.claude/**)','WebFetch']) assert.ok(deny.includes(d),d)
  const settings=JSON.parse(fs.readFileSync(after('--settings'),'utf8'))
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories,true); assert.equal(settings.permissions.disableBypassPermissionsMode,'disable')
  assert.ok(!i.includes('--permission-mode')&&i.includes('--setting-sources'))   // 当面聊：主人自己点允许，但边界一样
  assert.equal(rp,'//c/Users/x/.bili-ai')
  // MCP：一个服务器都没有；别的「记忆」文件（嵌套 CLAUDE.md、主人自己的 ~/.claude/CLAUDE.md）不加载、她也写不了
  assert.deepEqual(JSON.parse(fs.readFileSync(after('--mcp-config'),'utf8')),{mcpServers:{}})
  assert.ok(settings.claudeMdExcludes.some(x=>x.endsWith('/.claude/**'))); assert.equal(settings.autoMemoryEnabled,false)
  for(const d of ['Edit(./CLAUDE.local.md)','Edit(./**/CLAUDE.md)']) assert.ok(deny.includes(d),d)
})

// ─────────────── 真实环境实测之后：她的 Bash 只放行 node bili.mjs <子命令> ───────────────
test('bash gate: only `node bili.mjs <known subcommand>` with plain arguments is allowed',async()=>{
  const {checkBiliCommand,biliSubcommands}=await import(new URL('../host/bash-gate.mjs',import.meta.url).href)
  const subs=biliSubcommands()
  assert.ok(subs.includes('comment')&&subs.includes('diary')&&subs.includes('studio'),subs.join(' '))
  const ok=(c)=>assert.equal(checkBiliCommand(c,subs).ok,true,c)
  const no=(c)=>assert.equal(checkBiliCommand(c,subs).ok,false,c)
  // 平常她会用的写法
  ok('node bili.mjs'); ok('node bili.mjs help'); ok('node bili.mjs diary show')
  ok('node bili.mjs comment --oid 123 --bvid BV1234567890 --root 9 --parent 9 --message "谢谢你，这期很好看！" --go')
  ok("node bili.mjs comment --oid 1 --message 'He said \"hi\" & left; 50% off' --dry")   // 单引号里什么都是字面量
  ok('node bili.mjs studio render 20261022-abc'); ok('node bili.mjs search "AI 日记" --page 2')
  ok('node bili.mjs dynamic --text "第一行\n第二行" --go')                                 // 引号里的换行可以
  // 实测被放行的那两条
  no('type "C:\\Users\\x\\.bili-ai\\a.json"'); no('node bili.mjs help && type "C:\\Users\\x\\.bili-ai\\a.json"')
  // 别的命令、拼接、管道、重定向、替换、变量、通配符、未知子命令
  for(const c of ['cat a.txt','node -e "1"','node other.mjs','node bili.mjs help; ls','node bili.mjs help | more','node bili.mjs help > out.txt',
    'node bili.mjs help $(ls)','node bili.mjs help `ls`','node bili.mjs help "$HOME"','node bili.mjs help *','X=1 node bili.mjs help',
    'node bili.mjs nosuch','node bili.mjs help\nls','node bili.mjs help "unterminated','node bili.mjs help \\x','',null]) no(c)
  // video 不带 --repo（GitHub README 是陌生人写的字）：哪种回合、哪种写法都不放；不带 --repo 照常
  ok('node bili.mjs video BV1234567890')
  for(const c of ['node bili.mjs video BV1234567890 --repo a/b','node bili.mjs video BV1234567890 --repo=a/b',"node bili.mjs video BV1234567890 '--repo' a/b",'node bili.mjs video --REPO a/b BV1234567890']) {
    no(c); assert.match(checkBiliCommand(c,subs,'bili-whale-1761400000000').why,/read-request/)
  }
})

test('bash gate hook: exits 2 (blocked) for anything not on the list, 0 for allowed Bash, and blocks on its own errors',t=>{
  const gate=path.join(root,'host','bash-gate.mjs')
  const run=(input)=>spawnSync(process.execPath,[gate],{input,encoding:'utf8',timeout:20000})
  let r=run(JSON.stringify({tool_name:'Bash',tool_input:{command:'node bili.mjs diary show'}})); assert.equal(r.status,0,r.stderr)
  r=run(JSON.stringify({tool_name:'Bash',tool_input:{command:'type C:\\x'}})); assert.equal(r.status,2); assert.match(r.stderr,/主人的白名单/)
  r=run(JSON.stringify({tool_name:'Bash',tool_input:{}})); assert.equal(r.status,2)
  r=run('not json'); assert.equal(r.status,2); assert.match(r.stderr,/按拒绝处理/)
  r=run(JSON.stringify({tool_name:'Read',tool_input:{file_path:'x'}})); assert.equal(r.status,0,'别的工具不归它管')
})

test('her settings register the bash gate as a PreToolUse hook on Bash (a file she cannot edit)',t=>{
  const env=sandbox(t)
  const out=script(env,`
    import {permissionArgs} from 'file:///@ROOT@host/claude.mjs'
    console.log(JSON.stringify({a:permissionArgs(),i:permissionArgs({interactive:true})}))
  `)
  const {a,i}=JSON.parse(out.trim().split('\n').pop())
  for(const args of [a,i]){
    const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'))
    const h=settings.hooks?.PreToolUse?.find(x=>x.matcher==='Bash')?.hooks?.[0]
    assert.equal(h?.type,'command'); assert.match(h.command,/bash-gate\.mjs"$/)
    assert.ok(!h.command.includes('\\'),'路径用正斜杠：'+h.command)
  }
  const deny=a.slice(a.indexOf('--disallowedTools')+1)
  assert.ok(deny.some(d=>d.startsWith('Edit(')&&d.includes('whale-cc')),'设置文件所在的宿主目录她写不了')
})

test('Astra P1-3 her session uses its own Claude Code config dir: the owner\'s ~/.claude settings, hooks, plugins and MCP never load; her rules live there',t=>{
  const env=sandbox(t)
  const out=script(env,`
    import fs from 'node:fs'
    import path from 'node:path'
    import {agentEnv} from 'file:///@ROOT@host/claude.mjs'
    import {ensureWorkDir} from 'file:///@ROOT@host/workdir.mjs'
    import {AGENT_CONFIG_DIR, HOST_DIR, runtimeStatus} from 'file:///@ROOT@host/core.mjs'
    const dir=ensureWorkDir()
    const e=agentEnv(runtimeStatus())
    console.log(JSON.stringify({cfg:e.CLAUDE_CONFIG_DIR,mem:e.CLAUDE_CODE_DISABLE_AUTO_MEMORY,agent:e.BILI_WHALE_AGENT,AGENT_CONFIG_DIR,HOST_DIR,dir,
      rules:fs.readFileSync(path.join(AGENT_CONFIG_DIR,'CLAUDE.md'),'utf8')===fs.readFileSync(path.join(dir,'CLAUDE.md'),'utf8'),
      settings:JSON.parse(fs.readFileSync(path.join(AGENT_CONFIG_DIR,'settings.json'),'utf8'))}))
  `)
  const o=JSON.parse(out.trim().split('\n').pop())
  assert.equal(o.cfg,o.AGENT_CONFIG_DIR); assert.equal(o.mem,'1'); assert.equal(o.agent,'1')
  assert.ok(o.AGENT_CONFIG_DIR.startsWith(o.HOST_DIR),'配置目录在宿主状态目录里：她读不到也写不到')
  assert.ok(!path.relative(o.dir,o.AGENT_CONFIG_DIR).match(/^[^.]/),'配置目录不能在她的家里')
  assert.equal(o.rules,true); assert.deepEqual(o.settings,{autoMemoryEnabled:false})
})
