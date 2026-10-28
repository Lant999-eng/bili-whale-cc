// 第 13 版：Codex 审第 12 版之后，按同一类问题在全仓库找出来、确认过的几条（2026-10-24）。
// 都在临时沙盒里跑：不联网（fetch 换成假的）、不碰真凭据、不碰正在跑的宿主
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const COUNT_FETCH = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/count-fetch.mjs')).href

function sandbox(t, cfg = {}, cred = { sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'buvid-test' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-r13-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfgFile = path.join(dsh, 'bili-whale.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '111' }, notify: { type: 'file' }, ...cfg }))
  if (cred) fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify(cred))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile }
  delete env.BILI_WHALE_AGENT; delete env.WHALE_NOTIFY_BUDGET_MS; delete env.BILI_NO_CACHE
  return { home, dsh, env, cfgFile }
}
const node = (s, args, extra = {}, timeout = 30_000) => spawnSync(process.execPath, args, { env: { ...s.env, ...extra }, encoding: 'utf8', timeout })
/** 跑一段脚本（写进沙盒里的文件），返回 spawnSync 的结果 */
function script(s, name, code, extra = {}) {
  const f = path.join(s.home, name)
  fs.writeFileSync(f, code)
  return node(s, [f], extra, 60_000)
}
const url = (rel) => JSON.stringify(pathToFileURL(path.join(root, rel)).href)

test('review 13: a cookie value with CR/LF/control characters stops her tools before Node can print the whole cookie; notify still works', (t) => {
  const s = sandbox(t, {}, { sessdata: 'FAKESESS_R13_0123456789\r\n', bili_jct: 'fedcba9876543210fedcba9876543210', buvid3: 'b3' })
  for (const args of [['feed', '--n', '1'], ['dynamic', 'list'], ['search', 'test'], ['session']]) {
    const r = node(s, [path.join(root, 'tools/bili.mjs'), ...args], { NODE_OPTIONS: COUNT_FETCH })
    assert.equal(r.status, 3, args.join(' ') + r.stdout + r.stderr)
    assert.match(r.stderr, /cookie 带了换行或控制字符.*cookie --qr/)
    assert.ok(!(r.stdout + r.stderr).includes('FAKESESS_R13'), '不能把 cookie 打出来')
    assert.doesNotMatch(r.stderr, /FETCH/, '根本没去请求')
  }
  const n = node(s, [path.join(root, 'tools/bili.mjs'), 'notify', '凭据坏了也能报备'])
  assert.equal(n.status, 0, n.stdout + n.stderr)
  assert.match(fs.readFileSync(path.join(s.dsh, 'whale-notify.log'), 'utf8'), /凭据坏了也能报备/)
  // 干净的凭据照常放行（这里只看不被拦；fetch 是假的）
  const ok = sandbox(t)
  const r = node(ok, [path.join(root, 'tools/bili.mjs'), 'session'], { NODE_OPTIONS: COUNT_FETCH })
  assert.doesNotMatch(r.stderr, /cookie 带了换行/)
})

test('review 13 (her own --interval): comment-await never polls faster than every 60 s, whatever the interval says', async (t) => {
  const s = sandbox(t)
  for (const [iv, want] of [['x', 300], ['Infinity', 300], ['NaN', 300], ['5', 60], ['1e9', 86400], ['7200', 7200], ['120', 120]]) {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(root, 'tools/bili.mjs'), 'comment-await', '--interval', iv, '--minutes', '5'], { env: { ...s.env, NODE_OPTIONS: COUNT_FETCH, BILI_WHALE_AGENT: '1' } })
      let out = '', err = ''
      c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
      setTimeout(() => c.kill(), 2500)
      c.on('close', () => resolve({ out, err }))
    })
    assert.match(r.out, new RegExp(`每 ${want} 秒看一次`), `--interval ${iv}: ${r.out}${r.err}`)
    const fetches = (r.err.match(/^FETCH/gm) ?? []).length
    assert.ok(fetches <= 6, `--interval ${iv}：2.5 秒里请求了 ${fetches} 次（以前 NaN 时是几百次）`)
  }
})

test('review 13: quota caps that are not numbers fail closed (autoDaily refuses, shareDaily falls back to 3) and config set refuses them', (t) => {
  const today = new Date().toISOString()
  const s = sandbox(t, { quota: { autoDaily: '5条', shareDaily: '3条' } })
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'quota.json'), JSON.stringify({ log: Array.from({ length: 3 }, (_, i) => ({ at: today, type: 'comment', share: true, target: 'BV' + i })) }))
  let r = node(s, [path.join(root, 'tools/commands/quota.mjs'), 'check', '--type', 'comment'], { BILI_WHALE_AGENT: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /quota\.autoDaily 不是数字/)
  r = node(s, [path.join(root, 'tools/commands/quota.mjs'), 'check', '--type', 'comment', '--share', '--target', 'BVnew'], { BILI_WHALE_AGENT: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /分享额度已用完/, '「3条」按默认 3 算，不是不限')
  const s2 = sandbox(t)
  const set = (k, v) => node(s2, [path.join(root, 'host/cli.mjs'), 'config', 'set', k, v])
  for (const [k, v, why] of [['quota.autoDaily', '5条', /quota\.autoDaily 只能是/], ['listen.commentIntervalSec', '5分钟', /listen\.commentIntervalSec 只能是秒数/]]) {
    const x = set(k, v); assert.equal(x.status, 1, `${k}=${v} ${x.stdout}`); assert.match(x.stdout + x.stderr, why)
  }
  const cfg = () => JSON.parse(fs.readFileSync(s2.cfgFile, 'utf8'))
  assert.equal(set('quota.autoDaily', '-1').status, 0); assert.equal(cfg().quota.autoDaily, 0, '负数（旧版本的「不限」）按 0 存')
  assert.equal(set('listen.commentIntervalSec', '30').status, 0); assert.equal(cfg().listen.commentIntervalSec, 60, '最少 60 秒')
  assert.equal(set('listen.commentIntervalSec', '7200').status, 0); assert.equal(cfg().listen.commentIntervalSec, 7200, '一天以内都照存')
  assert.equal(set('quota.autoDaily', '4').status, 0); assert.equal(cfg().quota.autoDaily, 4)
})

test('review 13: odd values left by old versions or hand edits never block an unrelated config set (they are normalized, or only warned about)', (t) => {
  const s = sandbox(t, { quota: { autoDaily: '5条', shareDaily: 3 }, listen: { commentIntervalSec: 0 } })
  const set = (k, v) => node(s, [path.join(root, 'host/cli.mjs'), 'config', 'set', k, v])
  let r = set('notify.type', 'file')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /quota\.autoDaily 不是数字（5条）/)
  let c = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  assert.equal(c.listen.commentIntervalSec, 60, '旧版本存的 0 收拾成最小值'); assert.equal(c.quota.autoDaily, '5条', '收拾不了的不乱改，只提醒')
  r = set('quota.autoDaily', '0')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  c = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8')); assert.equal(c.quota.autoDaily, 0)
  // 旧版本存的 -1：她照常能发（-1 一直是「不限」的意思）
  fs.writeFileSync(s.cfgFile, JSON.stringify({ owner: { mid: '222' }, notify: { type: 'file' }, quota: { autoDaily: -1 } }))
  const q = node(s, [path.join(root, 'tools/commands/quota.mjs'), 'check', '--type', 'comment'], { BILI_WHALE_AGENT: '1' })
  assert.equal(q.status, 0, q.stdout + q.stderr)
})

test('review 13: risk-control breaker records are written atomically and a new hit never shortens a longer ban another process just set', (t) => {
  const s = sandbox(t)
  const ban = path.join(s.home, '.bili-ai', 'api-ban.json')
  const until = Date.now() + 25 * 60_000
  fs.writeFileSync(ban, JSON.stringify({ until, why: 'old', streak: 1, endpoint: '/x/a' }))
  const r = script(s, 'ban.mjs', `
    import { noteWriteResult, writeBlocked } from ${url('tools/lib/bili-api.mjs')}
    noteWriteResult(412, 0, '/x/b')
    console.log(writeBlocked() ? 'blocked' : 'open')
  `)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /blocked/)
  const j = JSON.parse(fs.readFileSync(ban, 'utf8'))
  assert.ok(j.until >= until, '更长的那次熔断没被改短'); assert.equal(j.streak, 2); assert.equal(j.endpoint, '/x/b')
  assert.deepEqual(fs.readdirSync(path.dirname(ban)).filter((f) => f.endsWith('.tmp')), [], '不留临时文件')
})

test('review 13 (host queue): enqueueing from the daemon and `cli wake` at the same time loses nothing; a finished turn that reappears is not run again', async (t) => {
  const s = sandbox(t)
  const worker = path.join(s.home, 'enq.mjs')
  fs.writeFileSync(worker, `
    import path from 'node:path'
    import { ClaudeSessionController } from ${url('host/claude.mjs')}
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), runner: async () => ({ ok: true }) })
    c.stopped = true   // 和 cli wake 一样只入队，不跑
    for (let i = 0; i < 40; i++) await c.prompt({ requestId: process.argv[2] + '-' + i, content: [{ type: 'text', text: 'x' }] })
  `)
  const runOne = (tag) => new Promise((resolve) => {
    const c = spawn(process.execPath, [worker, tag], { env: s.env })
    let err = ''; c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, err }))
  })
  const rs = await Promise.all([runOne('a'), runOne('b'), runOne('c')])
  assert.ok(rs.every((r) => r.code === 0), rs.map((r) => r.err).join('\n'))
  const q = JSON.parse(fs.readFileSync(path.join(s.dsh, 'whale-cc', 'queue.json'), 'utf8'))
  assert.equal(q.length, 120, '三个进程同时入队，一个都不少（以前各读各写会互相冲掉）')
  assert.equal(new Set(q.map((x) => x.id)).size, 120)
  // 已经处理过的回合又出现在队列里：拿掉，不再跑
  fs.writeFileSync(path.join(s.dsh, 'whale-cc', 'queue.json'), JSON.stringify([{ id: 'turn-done-1', text: '跑过了', at: new Date().toISOString() }, { id: 'turn-new-1', text: '新的', at: new Date().toISOString() }]))
  fs.writeFileSync(path.join(s.dsh, 'whale-cc', 'turns-done.json'), JSON.stringify([{ id: 'turn-done-1', at: new Date().toISOString() }]))
  const r = script(s, 'kick.mjs', `
    import path from 'node:path'
    import { ClaudeSessionController } from ${url('host/claude.mjs')}
    const calls = []
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), runner: async ({ text }) => { calls.push(text); return { ok: true } } })
    c.kick()
    for (let i = 0; i < 200 && c.isBusy(); i++) await new Promise((r) => setTimeout(r, 20))
    console.log(JSON.stringify(calls))
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['新的'])
})

test('review 13 (host queue): when the queue lock is stuck as a turn finishes, the turn is still not run a second time and the host is not frozen for long', async (t) => {
  const s = sandbox(t)
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'])
  t.after(() => sleeper.kill())
  const r = script(s, 'stuck.mjs', `
    import fs from 'node:fs'
    import path from 'node:path'
    import { ClaudeSessionController } from ${url('host/claude.mjs')}
    const lock = path.join(process.env.DSH_HOME, 'whale-cc', 'queue.json.lock')
    const calls = []
    let maxGap = 0, last = Date.now()
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n }, 20)
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), log: () => {}, runner: async ({ text }) => {
      calls.push(text)
      // 回合跑着的时候，队列的锁被一个还活着的进程占住了（比如持锁的进程被结束、进程号又被别的程序用上）
      fs.writeFileSync(lock, JSON.stringify({ pid: Number(process.env.SLEEPER), at: Date.now(), token: 'stuck' }))
      return { ok: true }
    } })
    await c.prompt({ requestId: 'bili-whale-dm-stuck', self: '', content: [{ type: 'text', text: '主人的一批私信' }] })
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 1500)); c.kick() }   // 宿主平时每 5 秒踢一次
    clearInterval(tick)
    console.log(JSON.stringify({ calls, maxGap }))
  `, { SLEEPER: String(sleeper.pid) })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.deepEqual(j.calls, ['主人的一批私信'], '只跑了一次')
  assert.ok(j.maxGap < 4000, `宿主最多被卡 ${j.maxGap} ms（以前每次 10 秒）`)
})

test('review 13 (second round): the host\'s comment and live-room listeners skip a cookie with a line break inside instead of logging it', (t) => {
  const s = sandbox(t, { listen: { comment: true, allDay: true, live: true, liveRoom: '12345', dm: false } }, { sessdata: 'FAKESESS_R13_AAA\nBBB', bili_jct: 'FAKEJCT_R13_0123456789abcdef0123', buvid3: 'b3' })
  const r = script(s, 'listen.mjs', `
    import { fileURLToPath } from 'node:url'
    const { startScheduler } = await import(${url('lib/scheduler.js')})
    const logs = []
    const sched = startScheduler({ sessionController: { create: async () => {}, prompt: async () => {} } }, { dshHome: process.env.DSH_HOME, cwd: process.env.HOME, biliMjs: fileURLToPath(${url('tools/bili.mjs')}), log: (m) => logs.push(m) })
    try { await sched.listenTick(); await sched.liveTick(); await sched.listenTick() } finally { sched.stop() }
    console.log(JSON.stringify(logs))
  `, { NODE_OPTIONS: COUNT_FETCH })
  assert.equal(r.status, 0, r.stderr)
  const logs = JSON.parse(r.stdout.trim().split('\n').pop()).join('\n')
  assert.match(logs, /评论监听先停着：凭据文件里的 cookie 带了换行/); assert.match(logs, /直播间监听先停着/)
  assert.equal((logs.match(/评论监听先停着/g) ?? []).length, 1, '只提醒一次')
  assert.ok(!/FAKESESS_R13|FAKEJCT_R13/.test(logs + r.stdout + r.stderr), logs)
  assert.doesNotMatch(r.stderr, /FETCH/, '根本没去请求')
})

test('review 13 (second round): a DM turn dropped after an account switch still tells the owner even when the queue lock is stuck', async (t) => {
  const s = sandbox(t, { self: { mid: '111' } })
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'])
  t.after(() => sleeper.kill())
  const hostDir = path.join(s.dsh, 'whale-cc')
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, 'queue.json'), JSON.stringify([{ id: 'bili-whale-dm-sw', text: '旧号收到的私信', at: new Date().toISOString(), self: '999' }]))
  fs.writeFileSync(path.join(hostDir, 'queue.json.lock'), JSON.stringify({ pid: sleeper.pid, at: Date.now(), token: 'stuck' }))
  const r = script(s, 'drop.mjs', `
    import path from 'node:path'
    import { ClaudeSessionController } from ${url('host/claude.mjs')}
    const calls = []
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), log: () => {}, runner: async ({ text }) => { calls.push(text); return { ok: true } } })
    c.kick(); c.kick()
    await new Promise((r) => setTimeout(r, 8000))   // 等推送（runBili → notify → 写通知文件）
    console.log(JSON.stringify(calls))
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [], '旧号收到的私信不交给新号回')
  const log = path.join(s.dsh, 'whale-notify.log')
  assert.ok(fs.existsSync(log), '推送发出去了'); assert.match(fs.readFileSync(log, 'utf8'), /换号了.*要紧的话再发一次/)
  assert.match(fs.readFileSync(path.join(hostDir, 'turns-done.json'), 'utf8'), /bili-whale-dm-sw/)
})

test('review 13 (third round): an orphan DM turn that was ended for running too long stays "ended" on a later pass — it is not re-run as if cut off', async (t) => {
  const s = sandbox(t)
  const hostDir = path.join(s.dsh, 'whale-cc')
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, 'queue.json'), JSON.stringify([{ id: 'bili-whale-dm-k', text: '主人的私信', at: new Date().toISOString(), self: '' }]))
  // 上一次已经因为跑太久把它结束了（进程不在了），只是那一次没处理完
  fs.writeFileSync(path.join(hostDir, 'running.json'), JSON.stringify({ pid: 999_999, id: 'bili-whale-dm-k', at: new Date().toISOString(), sessionId: 'no-such-session', killedForTimeout: true }))
  const r = script(s, 'killed.mjs', `
    import path from 'node:path'
    import { ClaudeSessionController } from ${url('host/claude.mjs')}
    const calls = []
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), log: () => {}, runner: async ({ text }) => { calls.push(text); return { ok: true } } })
    c.kick(); await new Promise((r) => setTimeout(r, 300)); c.kick()
    await new Promise((r) => setTimeout(r, 7000))
    console.log(JSON.stringify(calls))
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [], '没有再跑一遍')
  assert.match(fs.readFileSync(path.join(s.dsh, 'whale-notify.log'), 'utf8'), /跑太久被结束/)
})

test('review 13 (third round): quota.autoDaily is read the same way when saving and when checking (true / [] / blanks pause her, they are not a cap of 1 or "unlimited")', (t) => {
  for (const v of [true, false, [], '  ', '0x10', '5条']) {
    const s = sandbox(t, { quota: { autoDaily: v } })
    const set = node(s, [path.join(root, 'host/cli.mjs'), 'config', 'set', 'owner.name', 'Owner2'])
    assert.equal(set.status, 0, set.stdout + set.stderr); assert.match(set.stdout, /quota\.autoDaily 不是数字.*先停着/, JSON.stringify(v))
    const q = node(s, [path.join(root, 'tools/commands/quota.mjs'), 'check', '--type', 'comment'], { BILI_WHALE_AGENT: '1' })
    assert.equal(q.status, 2, JSON.stringify(v) + q.stdout); assert.match(q.stdout, /quota\.autoDaily 不是数字/, '检查时一样是「先不发」')
  }
})

test('review 13: a plain non-zero exit with nothing on stderr keeps err empty, so callers still show the reason from stdout', (t) => {
  const s = sandbox(t, { quota: { autoDaily: '5条' } })
  const r = script(s, 'fail.mjs', `
    import { runBili } from ${url('host/core.mjs')}
    console.log(JSON.stringify(await runBili(['quota', 'check', '--type', 'comment'], { timeout: 30000, env: { BILI_WHALE_AGENT: '1' } })))
  `)
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(j.ok, false); assert.equal(j.err, '', '不是「Command failed: 整条命令行」'); assert.match(j.out, /quota\.autoDaily 不是数字/)
})

test('review 13: when the host times out a tool, the log says so (runBili keeps the reason instead of an empty error)', async (t) => {
  const srv = http.createServer(() => {})   // 连上了就是不回
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  const s = sandbox(t, { notify: { type: 'webhook', url: `http://127.0.0.1:${srv.address().port}/hang`, fallback: '' } })
  const f = path.join(s.home, 'rb.mjs')
  fs.writeFileSync(f, `
    import { runBili } from ${url('host/core.mjs')}
    const r = await runBili(['notify', 'x'], { timeout: 3000, env: { WHALE_NOTIFY_BUDGET_MS: '60000' } })
    console.log(JSON.stringify(r))
  `)
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [f], { env: s.env })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, out, err }))
  })
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out.trim().split('\n').pop())
  assert.equal(j.ok, false); assert.equal(j.timedOut, true); assert.match(j.err, /超过 3 秒没跑完，已结束/)
})
