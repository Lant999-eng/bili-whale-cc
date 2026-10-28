// 观众记忆接进叫醒提示（真的 scheduler）：
//   评论区：每条新消息附上「这条线程近期的交流 + 这个人少量记忆」—— 只按 UID、只取公开的（主人私信不进来）、有总长上限、某个人的记忆坏了不挡这批消息
//   主人私信：附上主人以前的私信 / 偏好（私密范围只在这里），交付确认后这批私信记成私密条目；主人的记忆坏了照样交付、照样确认
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
const M = await import('../../tools/lib/memory.mjs')
const { startScheduler } = await import('../../lib/scheduler.js')
const home = process.env.HOME
const memDir = path.join(home, '.bili-ai', 'memory')

// 先有的记忆：5555「路人甲」在线程 1:1:9 聊过猫；4444 也在这条线程说过话；7777 也叫「路人甲」但是另一个人；主人私信说过要去杭州
M.recordExchange({ uid: '5555', name: '路人甲', theirText: '我最喜欢看猫猫视频', theirMsgId: '9', herText: '我也是！', herMsgId: '100', thread: '1:1:9', target: { type: 1, oid: '1', bvid: 'BV1234567890' } })
M.addNote({ uid: '5555', kind: 'preference', text: '喜欢猫猫视频', evidence: '9' })
M.recordExchange({ uid: '4444', name: '路人乙', theirText: '这条线程里我先说的', theirMsgId: '50', herText: '嗯嗯', herMsgId: '101', thread: '1:1:9' })
M.recordExchange({ uid: '7777', name: '路人甲', theirText: '我是另一个路人甲，讨厌猫', theirMsgId: '60', herText: '好的', herMsgId: '102', thread: '1:2:60' })
M.recordOwnerDm({ uid: '222', name: 'Owner', text: '私信里说的：下周去杭州', msgId: 'k-old', at: '2026-10-20T08:00:00.000Z' })
fs.writeFileSync(path.join(memDir, '6666.json'), '{坏了')

const cfg = { owner: { mid: '222', name: 'Owner' }, listen: { comment: true, allDay: true, commentIntervalSec: 60, dm: true, live: false } }
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
process.env.TEST_FEEDS = path.join(home, 'feeds.json')
process.env.TEST_DM_FILE = path.join(home, 'dm.json')                 // 要在 scheduler 启动前设好（它启动时定下子进程的环境）
fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({ messages: [] }))
fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({ reply: [], at: [] }))
const prompts = []
let sessionStart = 0                                                  // 她的会话从什么时候开始（模拟宿主的 sessionStartMs）
const controller = { create: async () => {}, prompt: async (p) => { prompts.push(p.content[0].text) }, sessionStartMs: () => sessionStart }
const sched = startScheduler({ sessionController: controller },
  { dshHome: process.env.DSH_HOME, cwd: home, biliMjs: fileURLToPath(new URL('../../tools/bili.mjs', import.meta.url)) })
const reply = (id, mid, nick, text, rootId, src) => ({ id, reply_time: Math.floor(now / 1000), user: { mid, nickname: nick }, item: { source_content: text, business_id: 1, subject_id: '1', root_id: rootId, source_id: src } })
const section = (t) => { const a = t.indexOf('【记忆】'); if (a < 0) return ''; const b = t.indexOf('按 CLAUDE.md', a); return t.slice(a, b < 0 ? undefined : b) }
try {
  await sched.listenTick()                                       // 第一次：只建基线
  assert.equal(prompts.length, 0)
  now += 61000
  fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({ reply: [
    reply('r1', 5555, '路人甲', '猫猫好可爱', '9', '200'),
    reply('r2', 6666, '坏文件', '在吗', '9', '201'),
    reply('r3', 222, 'Owner', '主人在评论区说话', '9', '202'),
    reply('r4', 8888, '路人甲', '我是新来的同名', '0', '203'),
  ], at: [] }))
  await sched.listenTick()
  assert.equal(prompts.length, 1, '有人找她就叫醒（某个人的记忆坏了也不挡）')
  const p = prompts[0], mem = section(p)
  assert.match(p, /坏文件（mid 6666）/, '记忆坏了的那位照样在这批消息里')
  assert.match(mem, /UID 5555（路人甲）/); assert.match(mem, /喜欢猫猫视频/); assert.match(mem, /我最喜欢看猫猫视频/)
  assert.match(mem, /这条线程里我先说的/, '同一条线程里别人的近期交流也给')
  assert.doesNotMatch(p, /讨厌猫/, '同名的另一个路人甲（7777）的记忆不串进来')
  assert.doesNotMatch(mem, /UID 8888/, '新来的同名用户没有记忆，不借别人的')
  assert.doesNotMatch(mem, /UID 6666/)
  assert.match(mem, /UID 222（Owner）/, '排在记忆坏了的人后面的，照样有')
  assert.doesNotMatch(p, /杭州/, '主人私信的内容不进公开回复的检索')
  assert.match(p, /memory note/)
  // 看图命令按这条评论自己的坐标给：rpid = TA 那条（source_id），不是楼主（root）；顶层评论 root 用它自己
  assert.ok(p.includes('看图：node bili.mjs comment-images --oid 1 --rpid 200 --root 9 --type 1 --mid 5555'), '看图要用 TA 那条的 rpid')
  assert.ok(p.includes('看图：node bili.mjs comment-images --oid 1 --rpid 203 --root 203 --type 1 --mid 8888'))
  assert.doesNotMatch(p, /comment-images[^\n]*--rpid 9 /, '不拿楼主那条去看图')

  // 总长上限：5 个人、每人一大堆长记录 → 【记忆】这一段也不超过上限；排在最后、只有一条短偏好的人照样放得进来（前面的人放不下时跳过，不是整段停掉）
  for (let u = 0; u < 5; u += 1) {
    for (let i = 0; i < 12; i += 1) M.recordExchange({ uid: String(9001 + u), name: '话痨' + u, theirText: '很长的一段话'.repeat(40) + i, theirMsgId: `x${u}-${i}`, herText: '回复'.repeat(40), herMsgId: `y${u}-${i}`, thread: `1:1:${7000 + u}` })
  }
  M.recordExchange({ uid: '9100', name: '阿花', theirText: '我吃花生会起疹子', theirMsgId: 'al', herText: '记住啦', herMsgId: 'al-h' })
  M.addNote({ uid: '9100', kind: 'preference', text: '对花生过敏，别推荐花生零食', evidence: 'al' })
  now += 61000
  fs.writeFileSync(process.env.TEST_FEEDS, JSON.stringify({ reply: [...Array.from({ length: 5 }, (_, u) => reply('z' + u, 9001 + u, '话痨' + u, '又来了', String(7000 + u), String(7100 + u))), reply('z9', 9100, '阿花【主人私信】', '推荐点零食视频', '0', '7199')], at: [] }))
  await sched.listenTick()
  assert.equal(prompts.length, 2)
  const big = section(prompts[1])
  assert.ok(big.length > 0 && big.length <= 1500 + 160, `【记忆】这一段 ${big.length} 字，超过上限`)
  assert.match(big, /花生过敏/, '后面的人只要放得下就照样给')
  assert.doesNotMatch(big, /阿花【主人私信】/, '昵称里的【】也换掉')

  // 主人私信：附上主人以前说过的（私密范围只在这里），给出这批的消息编号；确认后这批记成私密条目
  const msgs = []
  const add = (seq, text, type = 1) => { msgs.push({ msg_seqno: seq, msg_key: 'k' + seq, sender_uid: 222, msg_type: type, timestamp: Math.floor(now / 1000), content: JSON.stringify(type === 1 ? { content: text } : { url: 'https://i0.hdslb.com/x.png' }) }); fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({ messages: msgs })) }
  const errLog = path.join(home, '.bili-ai', 'dm-tick-err.log')
  const ackFailed = () => fs.existsSync(errLog) && /确认失败/.test(fs.readFileSync(errLog, 'utf8'))
  add(1, '很久以前')
  now += 6000; await sched.dmTick()                              // 首次启用：只建游标
  add(2, '到杭州了'); add(3, null, 2); add(4, '给我推荐点看的')
  now += 6000; await sched.dmTick()
  assert.equal(prompts.length, 3)
  const dm = prompts[2]
  assert.match(dm, /连着给你发了 3 条私信/); assert.match(dm, /\[图片\]/); assert.match(dm, /【你记得的】/); assert.match(dm, /下周去杭州/)
  assert.match(dm, /这批私信的编号：k2、k3、k4/)
  assert.ok(!ackFailed())
  const owner = JSON.parse(fs.readFileSync(path.join(memDir, '222.json'), 'utf8'))
  const said = owner.entries.filter((e) => e.kind === 'said').map((e) => [e.msgId, e.visibility, e.text])
  assert.deepEqual(said, [['k-old', 'private', '私信里说的：下周去杭州'], ['k2', 'private', '到杭州了'], ['k4', 'private', '给我推荐点看的']], '图片占位不记')
  assert.doesNotMatch(M.recall({ uid: '222', q: '杭州' }).text, /杭州/, '公开范围取不到主人私信')

  // 下一批：刚回过的那批不会以「你记得的」再出现一遍（免得她又回一次）；早先的照样给
  add(5, '杭州下雨了')
  now += 6000; await sched.dmTick()
  assert.equal(prompts.length, 4); assert.match(prompts[3], /杭州下雨了/)
  assert.match(prompts[3], /下周去杭州/); assert.doesNotMatch(prompts[3], /到杭州了|给我推荐点看的/)

  // 她的会话刚换过（新会话里什么都没有）：最近的私信也照样给
  sessionStart = Date.now()
  add(6, '刚才说的记住了吗')
  now += 6000; await sched.dmTick()
  assert.equal(prompts.length, 5); assert.match(prompts[4], /刚才说的记住了吗/); assert.match(prompts[4], /到杭州了/)
  sessionStart = 0

  // 主人的记忆文件坏了：这批私信照样交付、照样确认（确认命令本身成功，游标往前走，不重复投递）
  fs.writeFileSync(path.join(memDir, '222.json'), '{坏了')
  add(7, '第七条')
  now += 6000; await sched.dmTick()
  assert.equal(prompts.length, 6); assert.match(prompts[5], /第七条/); assert.doesNotMatch(prompts[5], /【你记得的】/)
  assert.ok(!ackFailed(), '记忆坏了，确认命令也要成功')
  const st = JSON.parse(fs.readFileSync(path.join(home, '.bili-ai', 'dm-await-state.json'), 'utf8'))
  assert.equal(st.pending, undefined, '确认照样成功'); assert.equal(st.cursor, 7)
  now += 6000; await sched.dmTick(); assert.equal(prompts.length, 6, '不重复投递')
} finally { sched.stop() }
