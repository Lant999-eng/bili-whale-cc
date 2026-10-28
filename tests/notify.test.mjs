// 推送分发（tools/commands/notify.mjs）：Codex 审第 12 版的 #5 / #6，和按同一类问题找出来的几条（2026-10-24）。
// 不弹真的桌面通知（桌面只在 --dry 里看走没走到），不联网：webhook 打到这个进程里的假服务器
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))

function sandbox(t, { notify = { type: 'none' }, extra = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-notify-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfgFile = path.join(dsh, 'bili-whale.config.json')
  const write = (n) => fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, notify: n, ...extra }))
  write(notify)
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile }
  delete env.BILI_WHALE_AGENT; delete env.WHALE_NOTIFY_BUDGET_MS
  return { home, dsh, env, cfgFile, write, notifyLog: path.join(dsh, 'whale-notify.log') }
}

/** 子进程异步跑（假服务器在这个进程里） */
function run(file, args, env) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const c = spawn(process.execPath, [path.join(root, file), ...args], { env })
    let stdout = '', stderr = ''
    c.stdout.on('data', (d) => { stdout += d }); c.stderr.on('data', (d) => { stderr += d })
    c.stdin.end()
    c.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr, secs: (Date.now() - t0) / 1000 }))
  })
}
const notify = (s, args, extra = {}) => run('tools/commands/notify.mjs', args, { ...s.env, ...extra })
const cli = (s, args) => run('host/cli.mjs', args, s.env)

/** 假 webhook：路径决定怎么回。/hang 连上了就是不回 */
async function fakeHook(t) {
  const hits = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      hits.push({ url: req.url, body })
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)) }
      const p = req.url.split('?')[0]
      if (p === '/hang') return
      if (p === '/ok') return send(200, { errcode: 0, errmsg: 'ok' })
      if (p === '/ding') return send(200, { errcode: 310000, errmsg: 'keywords not in content' })
      if (p === '/wecom') return send(200, { errcode: 45009, errmsg: 'api freq out of limit' })
      if (p === '/feishu') return send(200, { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' })
      if (p === '/generic200') return send(200, { code: 200, msg: 'success' })
      if (p.startsWith('/hook/')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(`Cannot POST ${p}`) }
      send(500, 'boom')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  return { hits, base: `http://127.0.0.1:${srv.address().port}` }
}

test('notify (Codex v12 #5): a missing custom command uses the configured fallback; nothing configured → desktop; none → no retry', async (t) => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-bili-whale', 'missing-notifier.exe')
  const s = sandbox(t)
  s.write({ type: 'command', cmd: missing, fallback: 'file' })
  let r = await notify(s, ['命令不在了', '--dry'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /推送命令不存在/); assert.match(r.all, /改用备用方式「file」/)
  assert.match(r.all, /\[dry\] 通知文件/); assert.doesNotMatch(r.all, /桌面通知/, '配了 file 就不能再走写死的桌面通知')
  s.write({ type: 'command', cmd: missing, fallback: '' })
  r = await notify(s, ['命令不在了', '--dry'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /改用备用方式「desktop」（自定义命令没配备用方式时默认用桌面通知）/); assert.match(r.all, /\[dry\] 桌面通知/)
  s.write({ type: 'command', cmd: missing, fallback: 'none' })
  r = await notify(s, ['命令不在了', '--dry'])
  assert.equal(r.status, 1, r.all); assert.doesNotMatch(r.all, /改用备用方式/); assert.doesNotMatch(r.all, /桌面通知/)
  s.write({ type: 'command', cmd: missing, fallback: 'stdout' })
  r = await notify(s, ['真的走备用方式'])
  assert.equal(r.status, 0, r.all); assert.match(r.stdout, /\[通知\] 通知\n真的走备用方式/)
  // $MSG：预演也要看得出真发会失败（以前 --dry 先返回、说「✓」）
  s.write({ type: 'command', cmd: 'notifier $MSG', fallback: 'none' })
  r = await notify(s, ['x', '--dry'])
  assert.equal(r.status, 1, r.all); assert.match(r.all, /\$MSG 已弃用/)
})

test('notify (Codex v12 #6): a webhook that accepts the connection but never answers gives up within the budget, leaving time for the fallback', async (t) => {
  const hook = await fakeHook(t)
  const s = sandbox(t, { notify: { type: 'webhook', url: `${hook.base}/hang`, fallback: 'file' } })
  let r = await notify(s, ['卡住时的报备'], { WHALE_NOTIFY_BUDGET_MS: '5000' })
  assert.equal(r.status, 0, r.all); assert.ok(r.secs < 8, `${r.secs} 秒`)
  assert.match(r.all, /webhook \d+ 秒没回/); assert.match(fs.readFileSync(s.notifyLog, 'utf8'), /卡住时的报备/)
  s.write({ type: 'webhook', url: `${hook.base}/hang`, fallback: '' })
  r = await notify(s, ['没有备用方式'], { WHALE_NOTIFY_BUDGET_MS: '5000' })
  assert.equal(r.status, 1, r.all); assert.ok(r.secs < 8, `${r.secs} 秒`)
  // 卡住的自定义命令也一样（以前命令自己最多等 60 秒，和宿主等 notify 的时间一样长）
  s.write({ type: 'command', cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], fallback: 'file' })
  r = await notify(s, ['命令卡住'], { WHALE_NOTIFY_BUDGET_MS: '5000' })
  assert.equal(r.status, 0, r.all); assert.ok(r.secs < 8, `${r.secs} 秒`); assert.match(fs.readFileSync(s.notifyLog, 'utf8'), /命令卡住/)
})

test('notify (review 13): DingTalk / WeCom / Feishu refusals that come back as HTTP 200 count as failures and use the fallback; a generic code=200 is still success', async (t) => {
  const hook = await fakeHook(t)
  const s = sandbox(t)
  for (const [p, vendor, why] of [['/ding', 'oapi.dingtalk.com', /errcode=310000/], ['/wecom', 'qyapi.weixin.qq.com', /errcode=45009/], ['/feishu', 'open.feishu.cn', /code=19021/]]) {
    fs.rmSync(s.notifyLog, { force: true })
    s.write({ type: 'webhook', url: `${hook.base}${p}?via=${vendor}&access_token=KEY_VENDOR_123456`, fallback: 'file' })
    const r = await notify(s, ['被拒收的报备'])
    assert.equal(r.status, 0, r.all); assert.match(r.all, /对方说没收/); assert.match(r.all, why)
    assert.match(fs.readFileSync(s.notifyLog, 'utf8'), /被拒收的报备/, `${vendor}：备用方式要用上`)
    assert.ok(!r.all.includes('KEY_VENDOR_123456'), r.all)
  }
  s.write({ type: 'webhook', url: `${hook.base}/ok?via=oapi.dingtalk.com`, fallback: 'file' })
  let r = await notify(s, ['正常'])
  assert.equal(r.status, 0); assert.match(r.all, /webhook 200 ✓/)
  s.write({ type: 'webhook', url: `${hook.base}/generic200`, fallback: 'none' })
  r = await notify(s, ['通用服务'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /webhook 200 ✓/)
})

test('notify (review 13): the webhook address and its key never show up in errors, even when the server echoes the path or the address cannot be parsed', async (t) => {
  const hook = await fakeHook(t)
  const s = sandbox(t)
  s.write({ type: 'webhook', url: `${hook.base}/hook/SECRETKEY_abcdef123`, fallback: 'file' })
  let r = await notify(s, ['x'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /webhook HTTP 404/); assert.ok(!r.all.includes('SECRETKEY_abcdef123'), r.all)
  // 手改配置留下的没写 https:// 的地址：fetch 的报错会带着整个地址
  s.write({ type: 'webhook', url: 'oapi.dingtalk.com/robot/send?access_token=KEY_PLAIN_99887766', fallback: 'file' })
  r = await notify(s, ['x'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /通知失败（webhook）/); assert.ok(!r.all.includes('KEY_PLAIN_99887766'), r.all)
  // config set 根本存不进这种地址（报错也不回显）
  for (const [url, why] of [['oapi.dingtalk.com/robot/send?access_token=KEY_A_445566', /要写完整的地址/], ['https://bot:PASS_B_778899@example.invalid/hook', /不要带账号密码/], ['ftp://example.invalid/x', /要写完整的地址/]]) {
    const c = await cli(s, ['config', 'set', 'notify.url', url])
    assert.equal(c.status, 1, c.all); assert.match(c.all, why); assert.ok(!/KEY_A_445566|PASS_B_778899/.test(c.all), c.all)
  }
  const ok = await cli(s, ['config', 'set', 'notify.url', 'https://oapi.dingtalk.com/robot/send?access_token=abc'])
  assert.equal(ok.status, 0, ok.all)
})

test('notify (review 13): B站 DM pushes are cut to 300 characters instead of failing, --dry shows it, and a missing owner.mid fails before anything runs', async (t) => {
  const s = sandbox(t, { notify: { type: 'dm' } })
  let r = await notify(s, ['长'.repeat(400), '--dry'])
  assert.equal(r.status, 0, r.all); assert.match(r.all, /\[dry\] B站私信（不发送）/); assert.match(r.all, /原文 400 字，超过 300 字会截短/)
  fs.writeFileSync(s.cfgFile, JSON.stringify({ owner: { mid: '' }, notify: { type: 'dm', fallback: 'file' } }))
  r = await notify(s, ['x', '--dry'])
  assert.match(r.all, /owner\.mid 为空/); assert.match(r.all, /改用备用方式「file」/)
})

test('notify (review 13): a long B站 DM keeps its last line (where the approve command is) when it is cut to 300 characters', async (t) => {
  const s = sandbox(t, { notify: { type: 'dm' } })
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))
  const sent = path.join(s.home, 'dm-sent.jsonl')
  const preload = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/dm-send-fetch.mjs')).href
  const body = ['【等你审核 1 条回复】→ 某人（mid 1234）', 'TA 在 B站 上说：' + '很长的评论'.repeat(40), '你要回：' + '她的回复'.repeat(20), '发：node host/cli.mjs pending approve d-0362dabc    不发：node host/cli.mjs pending reject d-0362dabc 理由'].join('\n')
  const r = await notify(s, [body], { NODE_OPTIONS: preload, TEST_DM_SENT: sent })
  assert.equal(r.status, 0, r.all)
  const got = JSON.parse(fs.readFileSync(sent, 'utf8').trim()).content
  assert.ok(got.length <= 300, String(got.length))
  assert.ok(got.startsWith('【等你审核 1 条回复】'), got)
  assert.match(got, /pending approve d-0362dabc/, '最后一行（批准命令）保住了')
  assert.match(got, /…（太长，中间省略了）\n发：/)
})

test('notify (review 13): with B站 DM as the push and a cookie that has a line break inside, the whole cookie is never printed and the fallback runs', async (t) => {
  const preload = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/dm-send-fetch.mjs')).href
  for (const n of [{ type: 'dm', fallback: 'file' }, { type: 'qq', fallback: 'dm' }]) {   // 第二种：QQ 没配 → 失败 → 改用私信
    const s = sandbox(t, { notify: n })
    fs.writeFileSync(path.join(s.home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'FAKESESS_R13_AAA\nBBB', bili_jct: 'FAKEJCT_R13_0123456789abcdef0123', buvid3: 'b3' }))
    const r = await notify(s, ['凭据坏了'], { NODE_OPTIONS: preload })
    assert.ok(!/FAKESESS_R13|FAKEJCT_R13/.test(r.all), JSON.stringify(n) + '\n' + r.all)
    assert.match(r.all, /私信发不了：凭据文件里的 cookie 带了换行或控制字符/)
    if (n.fallback === 'file') { assert.equal(r.status, 0, r.all); assert.match(fs.readFileSync(s.notifyLog, 'utf8'), /凭据坏了/) }
  }
  // 她平常用的 reply-draft（会起 notify）也一样
  const s = sandbox(t, { notify: { type: 'dm' } })
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'FAKESESS_R13_AAA\nBBB', bili_jct: 'FAKEJCT_R13_0123456789abcdef0123', buvid3: 'b3' }))
  const dm = await run('tools/bili.mjs', ['dm', '--msg', 'hi', '--go'], { ...s.env, NODE_OPTIONS: preload, BILI_WHALE_AGENT: '1' })
  assert.equal(dm.status, 3); assert.ok(!/FAKESESS_R13|FAKEJCT_R13/.test(dm.all), dm.all)
})

test('notify (review 13): scrubbing the webhook address leaves ordinary words (webhook, cgi-bin, send) readable but still hides the key', async (t) => {
  const hook = await fakeHook(t)
  const s = sandbox(t, { notify: { type: 'webhook', url: `${hook.base}/cgi-bin/webhook/send?key=KEY_WECOM_778899&via=qyapi.weixin.qq.com`, fallback: '' } })
  const r = await notify(s, ['x'])
  assert.equal(r.status, 1, r.all)
  assert.match(r.all, /通知失败（webhook）：webhook HTTP 500/, '报错的主语还在')
  assert.ok(!r.all.includes('KEY_WECOM_778899'), r.all)
})

test('notify: the budget defaults to 45 s and an out-of-range WHALE_NOTIFY_BUDGET_MS is clamped (5 s at least)', async (t) => {
  const hook = await fakeHook(t)
  const s = sandbox(t, { notify: { type: 'webhook', url: `${hook.base}/hang`, fallback: '' } })
  const r = await notify(s, ['x'], { WHALE_NOTIFY_BUDGET_MS: '10' })   // 太小：按 5 秒算，不会一启动就放弃
  assert.equal(r.status, 1); assert.ok(r.secs >= 3.5 && r.secs < 8, `${r.secs} 秒`); assert.match(r.all, /webhook 4 秒没回/)
})
