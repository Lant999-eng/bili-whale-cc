import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const RealDate = Date
let now = Date.now()
globalThis.Date = class extends RealDate { static now() { return now } }
globalThis.setInterval = globalThis.setTimeout = () => ({})
globalThis.clearInterval = globalThis.clearTimeout = () => {}
const { startScheduler } = await import('../../lib/scheduler.js')
process.env.TEST_DM_FILE = path.join(process.env.HOME, 'dm-input.json')
const ts = Math.floor(now / 1000)
// 主人会话里的全部消息（按序号）；mock-fetch 据此模拟 get_sessions 的 max_seqno 和 fetch_session_msgs
const msgs = []
const add = (seq, text) => {
  msgs.push({ msg_seqno: seq, msg_key: 'k' + seq, sender_uid: 222, msg_type: 1, timestamp: ts, content: JSON.stringify({ content: text }) })
  fs.writeFileSync(process.env.TEST_DM_FILE, JSON.stringify({ messages: msgs }))
}
add(1, 'history')
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ owner: { mid: '222' }, listen: { dm: true, comment: false, live: false } }))
const stateFile = path.join(process.env.HOME, '.bili-ai/dm-await-state.json')
let fail = true
const attempts = [], delivered = []
const sched = startScheduler({ sessionController: { create: async () => {}, prompt: async p => {
  attempts.push(p.requestId)
  if (fail) throw Error('host temporarily unavailable')
  delivered.push(p)
} } }, { dshHome: process.env.DSH_HOME, cwd: process.env.HOME, biliMjs: fileURLToPath(new URL('../../tools/bili.mjs', import.meta.url)) })
try {
  await sched.dmTick()                                    // 首次启用：只建游标，不投递历史
  assert.equal(attempts.length, 0)
  add(2, 'first'); add(3, 'second'); add(4, 'third')      // 主人连着发了三条
  now += 6000; await sched.dmTick()                       // 宿主暂时不可用：这一批留着，不推进已读位置
  const pending = JSON.parse(fs.readFileSync(stateFile)).pending
  assert.ok(pending?.receipt); assert.equal(pending.messages.length, 3)
  add(5, 'fourth'); fail = false; now += 6000
  await sched.dmTick()
  assert.equal(attempts[0], attempts[1])                  // 同一批、同一个 requestId
  const text = delivered[0].content[0].text
  assert.match(text, /连着给你发了 3 条私信/)
  assert.ok(text.indexOf('first') < text.indexOf('second') && text.indexOf('second') < text.indexOf('third'), '按顺序')
  assert.doesNotMatch(text, /fourth|history/)
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).pending, undefined)
  now += 6000; await sched.dmTick()
  assert.equal(delivered.length, 2)
  assert.match(delivered[1].content[0].text, /fourth/); assert.doesNotMatch(delivered[1].content[0].text, /first/)
  now += 6000; await sched.dmTick(); assert.equal(delivered.length, 2)
} finally { sched.stop() }
