// 主人私信 × 真 scheduler（对抗审查第一轮之后）：
//   ① 一批的大小和唤醒提示放得下的一样 —— 提示里一条不丢，放不下的留到下一批（确认的就是她看到的）
//   ② dm-await 真出错（退出码 3 / 4）要留痕；「没有新私信」（退出码 1）不算；连续出错太久报一次主人；恢复后照常收
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const RealDate = Date
// 明天中午（本地时间）：以前写死 2026-10-24 12:00 —— 真实时间过了那一刻，子进程 dm-await 用真时钟建的游标时间线就比这些消息晚，消息全被当成历史挡掉
let now = (() => { const d = new RealDate(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime() })()
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])) } static now() { return now } }
globalThis.setInterval = globalThis.setTimeout = () => ({})
globalThis.clearInterval = globalThis.clearTimeout = () => {}
const { startScheduler } = await import('../../lib/scheduler.js')
const home = process.env.HOME
process.env.TEST_DM_FILE = path.join(home, 'dm.json')
process.env.TEST_DM_FAIL_FILE = path.join(home, 'dm-fail.flag')          // 存在 = 取私信的接口出错（scheduler 启动前设好）
const msgs = []
process.env.TEST_DM_MODE_FILE = path.join(home, 'dm-mode.txt')          // 写 newest / noend：中途换成「只给最新一页、不认 end_seqno」
const add = (seq, text, ts = Math.floor(now / 1000), from = 222) => { msgs.push({ msg_seqno: seq, msg_key: 'k' + seq, sender_uid: from, msg_type: 1, timestamp: ts, content: JSON.stringify({ content: text }) }); fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({ messages: msgs })) }
fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({ messages: [] }))
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '111' }, notify: { type: 'dm' }, listen: { dm: true, comment: false, live: false } }))
const prompts = [], logs = [], selves = []
let hostDown = false                                                   // true = 宿主暂时收不下（prompt 抛错）
const sched = startScheduler({ sessionController: { create: async () => {}, prompt: async (p) => { if (hostDown) throw Error('host temporarily unavailable'); prompts.push(p.content[0].text); selves.push(p.self) } } },
  { dshHome: process.env.DSH_HOME, cwd: home, biliMjs: fileURLToPath(new URL('../../tools/bili.mjs', import.meta.url)), log: (m) => logs.push(m) })
const tick = async () => { now += 6000; await sched.dmTick() }
const errLog = path.join(home, '.bili-ai', 'dm-tick-err.log')
const errLines = () => (fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').trim().split('\n').filter(Boolean) : [])
const sends = () => (fs.existsSync(process.env.TEST_REQUESTS) ? fs.readFileSync(process.env.TEST_REQUESTS, 'utf8') : '').split('\n').filter((l) => /send_msg/.test(l)).length
try {
  await tick()                                                         // 首次启用：只建游标
  assert.equal(prompts.length, 0); assert.equal(errLines().length, 0, '「没有新私信」不算出错')

  // ① 五条长私信：前四条一批（提示里全在），第五条下一批
  for (let i = 1; i <= 5; i += 1) add(i, `MARK${i} ` + '字'.repeat(440))
  await tick()
  assert.equal(prompts.length, 1)
  for (let i = 1; i <= 4; i += 1) assert.match(prompts[0], new RegExp(`MARK${i} `))
  assert.doesNotMatch(prompts[0], /MARK5|没放进来/)
  await tick()
  assert.equal(prompts.length, 2); assert.match(prompts[1], /MARK5 /); assert.doesNotMatch(prompts[1], /MARK1 /)

  // ② 接口出错：留痕（错误日志 + 宿主日志），不算「没有新私信」
  fs.writeFileSync(process.env.TEST_DM_FAIL_FILE, '1')
  add(6, '第六条')
  await tick()
  assert.equal(prompts.length, 2)
  assert.match(errLines().join('\n'), /dm-await 退出码 3/)
  assert.ok(logs.some((l) => /私信通道出错（连续 1 次）/.test(l)), logs.join('\n'))
  const before = sends()
  for (let i = 0; i < 29; i += 1) await tick()                          // 连续 30 次 → 报一次主人
  for (let w = 0; w < 150 && sends() === before; w += 1) await waitReal(100)   // 报备是另起的进程，等它发出去（最多 15 秒）
  assert.equal(sends(), before + 1, '连续出错太久要报一次主人')
  // 恢复：这一条照样送到；计数清零
  fs.rmSync(process.env.TEST_DM_FAIL_FILE)
  await tick()
  assert.equal(prompts.length, 3); assert.match(prompts[2], /第六条/)

  // ④ 积压的私信（宿主停了三天）：写明是哪天发的、多久以前，别当成刚说的
  add(7, '今晚8点提醒我开会', Math.floor(now / 1000) - 3 * 86400)
  await tick()
  assert.equal(prompts.length, 4)
  assert.match(prompts[3], /之前给你发的 1 条私信，现在才送到（最早一条是 3 天前）/); assert.match(prompts[3], /\[\d+月\d+日 \d\d:\d\d\] 今晚8点提醒我开会/)
  assert.doesNotMatch(prompts[3], /刚给你发私信/)

  // ⑤ 凭据读不了：退出码 2（不是「没有新私信」的 1），照样留痕
  const credFile = path.join(home, '.bili-ai', 'credentials.json'), cred = fs.readFileSync(credFile, 'utf8')
  fs.writeFileSync(credFile, '{坏')
  const before2 = errLines().length
  await tick()
  assert.ok(errLines().length > before2 && /退出码 2/.test(errLines().at(-1)), errLines().at(-1))
  fs.writeFileSync(credFile, cred)

  // ⑥ 工具链本身起不来（退出码 1、没打印 {"hit":false}）：也算出错，不当成「没有新私信」
  const broken = path.join(home, 'broken-bili.mjs')
  fs.writeFileSync(broken, 'process.exit(1)\n')
  const s2 = startScheduler({ sessionController: { create: async () => {}, prompt: async () => {} } },
    { dshHome: process.env.DSH_HOME, cwd: home, biliMjs: broken, log: (m) => logs.push(m) })
  const before3 = errLines().length
  now += 6000; await s2.dmTick(); s2.stop()
  assert.ok(errLines().length > before3 && /退出码 1/.test(errLines().at(-1)), errLines().at(-1))

  // ⑦ 积压太多、中间有补不上的空档，取到的最新那部分里又全是她自己的：不叫醒她，但推送告诉主人
  fs.writeFileSync(process.env.TEST_DM_MODE_FILE, 'newest,noend')
  add(8, '主人：今晚8点开会')
  for (let i = 9; i <= 68; i += 1) add(i, '她的报备' + i, Math.floor(now / 1000), 111)
  const before4 = sends(), p4 = prompts.length
  await tick()
  for (let w = 0; w < 150 && sends() === before4; w += 1) await waitReal(100)
  assert.equal(prompts.length, p4, '没有取到主人的新私信，不叫醒她')
  assert.equal(sends(), before4 + 1, '中间那段可能有主人的私信：推送告诉主人')
  fs.rmSync(process.env.TEST_DM_MODE_FILE)

  // ⑧ 换号（Astra 审查）：旧号取到、还没交付确认的一批不交给新号；宿主日志和面板读的错误日志里都留一行；新号从现在起重新建游标
  assert.ok(selves.length > 0 && selves.every((x) => x === '111'), '排进宿主的私信回合记着是哪个号收到的：' + selves.join(','))
  add(69, '换号前发给旧号的')
  hostDown = true; await tick(); hostDown = false                     // 宿主暂时收不下：这一批留在「待交付」
  const stateFile = path.join(home, '.bili-ai', 'dm-await-state.json')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending?.self, '111')
  const cfg = JSON.parse(fs.readFileSync(process.env.BILI_WHALE_CONFIG, 'utf8'))
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ ...cfg, self: { mid: '333' } }))
  const p8 = prompts.length, s8 = sends()
  await tick()
  assert.equal(prompts.length, p8, '旧号那一批不交给新号')
  assert.ok(logs.some((l) => /⚠️ 换号了.*旧号（UID 111）.*1 条/.test(l)), logs.join('\n'))
  for (let w = 0; w < 150 && sends() === s8; w += 1) await waitReal(100)   // 推送是另起的进程，等它发出去
  assert.equal(sends(), s8 + 1, '作废了：推送告诉主人要紧的再发一次')
  assert.match(errLines().at(-1), /换号了.*旧号（UID 111）.*1 条/)
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending, undefined)
  add(70, '换号之后发的')
  await tick()
  assert.equal(prompts.length, p8 + 1); assert.match(prompts.at(-1), /换号之后发的/); assert.doesNotMatch(prompts.at(-1), /换号前发给旧号的/)
  assert.equal(selves.at(-1), '333')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending, undefined, '新号这一批照常确认')

  // ⑨ 取的时候不知道是哪个号（凭据里没有 UID、配置里也没填）：照样交给宿主，self 是空串 —— 不是「没有这一项」（宿主把没有这一项的当旧版排进来的、不跑）
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ ...cfg, self: { mid: '' } }))
  add(71, '不知道是哪个号的时候发的')
  const p9 = prompts.length
  await tick()
  assert.equal(prompts.length, p9 + 1); assert.match(prompts.at(-1), /不知道是哪个号的时候发的/)
  assert.equal(selves.at(-1), '', '带着 self（空串）')
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ ...cfg, self: { mid: '333' } }))

  // ⑩ 旧版留下的待交付一批（自己和状态都没记是哪个号）：作废，宿主日志说「记不清是哪个号」，推送主人一次 —— 之后的轮询不再推
  add(72, '旧版留下没确认的')
  const cur10 = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, owner: '222', self: '', cursor: cur10.cursor, seen: cur10.seen ?? [], initializedAt: 1,
    pending: { hit: true, mid: '222', name: 'Owner', messages: [{ key: 'k72', seq: 72, ts: Math.floor(now / 1000), type: 1, text: '旧版留下没确认的' }], cover: 72, text: 'x', receipt: 'r-legacy' } }))
  const p10 = prompts.length, s10 = sends()
  await tick()
  assert.equal(prompts.length, p10, '说不清是哪个号的那批不交给她')
  assert.ok(logs.some((l) => /⚠️ 1 条主人私信还没确认交给她，记不清是哪个号收到的/.test(l)), logs.join('\n'))
  for (let w = 0; w < 150 && sends() === s10; w += 1) await waitReal(100)
  assert.equal(sends(), s10 + 1, '推送告诉主人一次')
  await tick(); await waitReal(1500)
  assert.equal(sends(), s10 + 1, '之后的轮询不再推'); assert.equal(prompts.length, p10, '作废的那条也不再交付')

  // ③ 状态文件读不了：退出码 4，同样留痕
  const n = errLines().length
  fs.writeFileSync(path.join(home, '.bili-ai', 'dm-await-state.json'), '{坏了')
  await tick()
  assert.ok(errLines().length > n && /退出码 4/.test(errLines().at(-1)), errLines().at(-1))
} finally { sched.stop() }

// setTimeout 被换掉了：用真时钟 + setImmediate 等一会儿
function waitReal(ms) { const end = RealDate.now() + ms; return new Promise((resolve) => { const spin = () => (RealDate.now() >= end ? resolve() : setImmediate(spin)); spin() }) }
