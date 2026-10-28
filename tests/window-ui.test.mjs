// 「她的小窗」页面（host/window-ui/）：页面里没有内联脚本、没有 on* 属性，脚本里不拼 HTML、不 eval；
// 字幕节奏（每条至少 1.5 秒、积压 ≥4 条时 0.6 秒、落后 10 秒以上跳到最新）；她的原话默认显示（最多 80 字），「遮住私话」打开就遮；
// 再在一个假 DOM 里把 window.js 真跑一遍：快照 → 事件按节奏放 → 回合小结 → 断线重连。全部离线，不起服务、不开浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PACE, createPlayer, dwellOf, isLight, overlayFor, pickExpr, spriteUrl, captionOf, textLineOf, shouldMask, glyphOf, kindLabelOf, chipOf,
  planLine, inflightChips, summaryOf, fmtClock, fmtDurCN, fmtCost, fmtTokens, clip, bvLink, coverUrl, safeHref, talkMsOf,
  whenLabel, queuedLine, todayStrip, silentLimitMs, isChatId, STATE_CAP, hhmm,
} from '../host/window-ui/player.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const UI = path.join(root, 'host', 'window-ui')
const read = (f) => fs.readFileSync(path.join(UI, f), 'utf8')

// ─────────────── 静态检查 ───────────────
test('window ui: no inline script, no on* handlers, only same-origin assets; scripts never build HTML or eval', () => {
  const html = read('index.html'), js = read('window.js'), player = read('player.mjs'), css = read('window.css')
  for (const [f, s] of [['index.html', html], ['window.js', js], ['player.mjs', player], ['window.css', css]]) assert.ok(!s.includes('\r'), `${f} uses LF line endings`)
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.equal(scripts.length, 1, 'exactly one script tag')
  assert.match(scripts[0][1], /\btype="module"/)
  assert.match(scripts[0][1], /\bsrc="\/window\.js"/)
  assert.equal(scripts[0][2].trim(), '', 'the script tag has no inline body')
  assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(html), 'no on* event-handler attributes')
  assert.ok(!/\sstyle\s*=/i.test(html), 'no inline style attributes')
  assert.ok(!/javascript:/i.test(html + js + player), 'no javascript: URLs')
  assert.ok(!/https?:\/\//i.test(html), 'the page loads nothing from other origins')
  assert.match(html, /<link rel="stylesheet" href="\/window\.css">/)
  // 页面里写的是 bili-whale：服务按 persona.name 换成她的名字（window.mjs 的 withName），window.js 从标题拿名字，cli window --top 按它找窗口
  assert.match(html, /<title>bili-whale<\/title>/, 'the window title starts with the persona name (served in by window.mjs; cli window --top finds it by that)')
  assert.match(html, /<img id="sp-closed" class="frame" alt="bili-whale">/)
  for (const [f, s] of [['window.js', js], ['player.mjs', player]]) {
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function\b/, /document\.write/, /\bset(Timeout|Interval)\(\s*['"`]/, /setAttribute\(\s*['"]on/i, /\bimport\s*\(/])
      assert.ok(!bad.test(s), `${f} must not use ${bad}`)
    for (const [u] of s.matchAll(/https?:\/\/[^\s'"`)]+/g)) assert.match(u, /^https:\/\/((www|t|live|space|m)\.bilibili\.com|b23\.tv)\b/, `${f}: only bilibili links (${u})`)
  }
  assert.ok(!/@import|url\(/i.test(css), 'css pulls in no other files (CSP img-src/default-src)')
  // window.js 只从 player.mjs 拿东西，且拿的名字 player.mjs 都导出了
  const imports = [...js.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gm)]
  assert.equal(imports.length, 1); assert.equal(imports[0][2], './player.mjs')
  const exported = new Set([...player.matchAll(/^export\s+(?:const|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
  for (const name of imports[0][1].split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(exported.has(name), `player.mjs exports ${name}`)
  // window.js 用到的每个元素 id 页面里都有
  const ids = JSON.parse(js.match(/^const IDS = (\[[^\]]*\])/m)[1].replaceAll("'", '"'))
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`)
  for (const f of ['window.js', 'player.mjs']) {
    const r = spawnSync(process.execPath, ['--check', path.join(UI, f)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${f} parses: ${r.stderr}`)
  }
})

// ─────────────── 字幕节奏 ───────────────
const ev = (seq, kind = 'tool_start', more = {}) => ({ seq, kind, turn: 'bili-whale-dm-1', cap: `动作${seq}`, toolId: `tu${seq}`, ...more })

test('player: one caption at a time, each on screen at least 1.5 s; feed rows are released together with the bubble', () => {
  const p = createPlayer()
  p.push(ev(1), 0); p.push(ev(2), 0)
  let o = p.tick(0)
  assert.deepEqual(o.reveal.map((e) => e.seq), [1]); assert.equal(o.show.seq, 1)
  assert.equal(p.tick(1499).show, null, 'not before 1.5 s')
  assert.deepEqual(p.tick(1499).reveal, [])
  o = p.tick(1500)
  assert.equal(o.show.seq, 2); assert.deepEqual(o.reveal.map((e) => e.seq), [2])
  assert.equal(p.tick(9000).show, null, 'nothing left: the last caption stays up')
  assert.equal(p.current.seq, 2)
  p.push(ev(3), 9000)
  assert.equal(p.tick(9000).show.seq, 3, 'the old caption has been up long enough: the next one shows at once')
})

test('player: 0.6 s per caption while 4 or more are waiting, back to 1.5 s when the queue is short', () => {
  const p = createPlayer(), shown = []
  for (let i = 1; i <= 6; i++) p.push(ev(i), 0)
  for (let t = 0; t <= 6000; t += 100) { const o = p.tick(t); if (o.show) shown.push([o.show.seq, t]) }
  // 1 上屏时还排着 5 条 → 0.6 秒；2 上屏时排着 4 条 → 0.6 秒；3 上屏时只剩 3 条 → 1.5 秒
  assert.deepEqual(shown, [[1, 0], [2, 600], [3, 1200], [4, 2700], [5, 4200], [6, 5700]])
  assert.equal(dwellOf(ev(1), 4), PACE.fastMs); assert.equal(dwellOf(ev(1), 3), PACE.minMs)
  // 排队的又涨到 4 条：当前这条立刻缩成 0.6 秒
  const q = createPlayer()
  q.push(ev(1), 0); q.tick(0)
  q.push(ev(2), 700); assert.equal(q.tick(700).show, null)
  for (let i = 3; i <= 5; i++) q.push(ev(i), 700)
  assert.equal(q.tick(700).show.seq, 2, 'with 4 waiting, 0.7 s on screen is already enough')
})

test('player: more than 10 s behind → jump to the newest; everything in between still goes into the feed', () => {
  const p = createPlayer()
  p.push(ev(1), 0); p.tick(0)
  for (let i = 2; i <= 5; i++) p.push(ev(i), 100)
  assert.equal(p.tick(10_100).show?.seq, 2, 'exactly 10 s is not "more than 10 s": play on')
  const o = p.tick(10_101)
  assert.deepEqual(o.reveal.map((e) => e.seq), [3, 4, 5], 'all of the backlog goes into the feed at once')
  assert.equal(o.show.seq, 5); assert.equal(o.skipped, 2)
  assert.equal(p.waiting, 0)
  // 窗口藏了半天（没人 tick）：回来第一下就是最新那条
  const h = createPlayer()
  for (let i = 1; i <= 30; i++) h.push(ev(i), i * 10)
  const back = h.tick(60_000)
  assert.equal(back.reveal.length, 30); assert.equal(back.show.seq, 30)
})

test('player: "thinking" and successful tool ends do not take caption time when more is waiting; errors and her words do', () => {
  const p = createPlayer()
  p.push(ev(1, 'thinking'), 0); p.push(ev(2, 'tool_end', { ok: true }), 0); p.push(ev(3), 0)
  const o = p.tick(0)
  assert.deepEqual(o.reveal.map((e) => e.seq), [1, 2, 3]); assert.equal(o.show.seq, 3)
  assert.ok(isLight(ev(1, 'thinking')) && isLight(ev(2, 'tool_end', { ok: true })))
  assert.ok(!isLight(ev(2, 'tool_end', { ok: false })), 'a failed tool is shown like any caption')
  const q = createPlayer()
  q.push(ev(1, 'thinking'), 0); q.tick(0)
  q.push(ev(2), 50)
  assert.equal(q.tick(50).show.seq, 2, 'a lone "在想…" gives way at once')
  // 她说的话按字数停：每字 120 毫秒，1.5–6 秒
  assert.equal(dwellOf(ev(1, 'said', { text: '嗯' }), 0), 1500)
  assert.equal(dwellOf(ev(1, 'said', { text: '一'.repeat(30) }), 0), 3600)
  assert.equal(dwellOf(ev(1, 'said', { text: '一'.repeat(80) }), 0), 6000)
  assert.equal(dwellOf(ev(1, 'said', { text: '一'.repeat(80) }), 4), 600, 'but a backlog still wins')
  p.reset(); assert.equal(p.waiting, 0); assert.equal(p.current, null)
})

// ─────────────── 表情 / 文字 / 链接 ───────────────
test('expressions follow the caption being played; missing sprites fall back to neutral, then the first one', () => {
  assert.deepEqual(overlayFor({ kind: 'turn_start' }), { expr: '小吃惊', talkMs: 0, holdMs: 1500 })
  assert.equal(overlayFor({ kind: 'thinking' }).expr, '想事情')
  assert.equal(overlayFor({ kind: 'tool_start', activity: 'watch' }).expr, '浅笑')
  assert.equal(overlayFor({ kind: 'tool_start', activity: 'think' }).expr, '想事情')
  assert.equal(overlayFor({ kind: 'tool_start', activity: 'other' }).expr, 'neutral')
  assert.equal(overlayFor({ kind: 'tool_start', activity: 'send', text: '一'.repeat(10) }).talkMs, 1200, 'sending her words: the mouth moves')
  assert.equal(overlayFor({ kind: 'tool_start', activity: 'watch' }).talkMs, 0)
  assert.deepEqual(overlayFor({ kind: 'said', text: '一'.repeat(100) }).talkMs, 6000, 'talking is capped at 6 s')
  assert.equal(talkMsOf({ text: '你好呀' }), 360)
  assert.deepEqual(overlayFor({ kind: 'tool_end', ok: false }), { expr: '别扭', talkMs: 0, holdMs: 4000 })
  assert.equal(overlayFor({ kind: 'tool_end', ok: true }), null, 'a normal tool end keeps the current face')
  for (const k of ['retry', 'denied']) assert.equal(overlayFor({ kind: k }).expr, '别扭')
  assert.deepEqual(overlayFor({ kind: 'turn_end', ok: true }), { expr: '浅笑', talkMs: 0, holdMs: 3000 })
  assert.equal(overlayFor({ kind: 'turn_end', ok: false }).expr, '低落')
  assert.equal(overlayFor({ kind: 'note' }), null)
  assert.equal(overlayFor({ kind: 'note', glyph: '错', cap: '模型接口出错了' }).expr, '别扭', 'an API error note looks 别扭 like stateOf says')
  const all = ['neutral', '低落', '别扭', '困', '小吃惊', '想事情', '浅笑']
  assert.equal(pickExpr('浅笑', all), '浅笑')
  assert.equal(pickExpr('浅笑', ['neutral', '困']), 'neutral')
  assert.equal(pickExpr('浅笑', ['困', '低落']), '困')
  assert.equal(pickExpr('浅笑', []), null, 'no sprites listed: ask for no image at all')
  assert.equal(pickExpr('浅笑', undefined), null)
  assert.equal(spriteUrl('白裙', '浅笑'), `/sprite/${encodeURIComponent('白裙')}/${encodeURIComponent('浅笑')}.png`)
  assert.equal(spriteUrl('黑裙', '困', true), `/sprite/${encodeURIComponent('黑裙')}/${encodeURIComponent('说话')}/${encodeURIComponent('困')}.png`)
  assert.equal(spriteUrl('../x', 'a/b'), '/sprite/..%2Fx/a%2Fb.png', 'names are encoded, never joined as paths')
})

test('her words are shown by default (≤80 chars); 「遮住私话」 hides every 她说 and every private text, never the public captions', () => {
  const long = '主人，今天看了一条关于猫坐地铁的视频，' + '好'.repeat(100)
  const said = { kind: 'said', cap: '不该显示的 cap', text: long, private: true }
  const shown = captionOf(said, false)
  assert.ok(shown.startsWith('她说：「主人，今天看了'))
  assert.equal(Array.from(shown).length, '她说：「'.length + 80 + 1 + 1, 'her text is cut to 80 chars plus …')
  assert.ok(!shown.includes('不该显示的 cap'), 'a said caption never uses cap')
  assert.equal(captionOf(said, true), '她说了句话（遮住了）')
  assert.equal(captionOf({ kind: 'said', text: '公开的一句话' }, true), '她说了句话（遮住了）', 'all of her words are hidden: the last line of a turn is to the owner, and it is not known in time')
  assert.ok(shouldMask({ kind: 'said' }, true) && !shouldMask({ kind: 'said' }, false))
  const dm = { kind: 'tool_start', cap: '在给你报备', text: '我今天发了一条评论', private: true, activity: 'send' }
  assert.equal(captionOf(dm, true), '在给你报备', 'the caption itself is never private')
  assert.equal(textLineOf(dm, false), '“我今天发了一条评论”')
  assert.equal(textLineOf(dm, true), '（这句遮住了）')
  assert.equal(textLineOf({ kind: 'tool_start', cap: '在评论《猫》' }, true), null)
  assert.equal(textLineOf({ kind: 'said', text: 'x' }, false), null, 'said text lives in the caption line only')
  assert.equal(captionOf({ kind: 'thinking' }, false), '在想…')
  assert.equal(captionOf({ kind: 'tool_start', cap: '一'.repeat(120) }, false).length, 81)
  assert.equal(clip('😀'.repeat(81)), '😀'.repeat(80) + '…', 'clip counts characters, not UTF-16 halves')
  assert.equal(glyphOf({ kind: 'said' }), '说')
  assert.equal(glyphOf({ kind: 'tool_end', ok: false, glyph: '看' }), '错')
  assert.equal(glyphOf({ kind: 'tool_start', glyph: '<b>' , activity: 'watch' }), '看', 'unknown glyphs fall back to the activity')
  assert.equal(glyphOf({ kind: 'denied' }), '错')
})

test('labels, chips, plan countdown (from atMs, DST-safe), summaries and money', () => {
  assert.equal(kindLabelOf('bili-whale-dm-123'), '你发来私信')
  assert.equal(kindLabelOf('bili-whale-listen-1'), '有人找她')
  assert.equal(kindLabelOf('bili-whale-live-1'), '直播间有人喊她')
  assert.equal(kindLabelOf('bili-whale-1792890601535'), '按作息醒来')
  assert.equal(kindLabelOf('manual-1792839021437'), '你叫醒了她')
  assert.equal(kindLabelOf('turn-1', '其它'), '其它')
  assert.equal(kindLabelOf('chat-1792890601535'), '你在和她当面聊', 'cli open chat pseudo-turn')
  assert.ok(isChatId('chat-1') && !isChatId('bili-whale-dm-1') && !isChatId(null))
  assert.equal(chipOf({}, false).text, '连接中')
  assert.equal(chipOf({ host: { state: 'offline' } }, true).text, '宿主离线')
  // 牌子只是一个短词：「你在和她当面聊」由旁边的种类 / 气泡说，牌子再说一遍就是同一句出现三次
  assert.deepEqual(chipOf({ host: { state: 'paused' } }, false), { text: '当面聊', cls: 'chat' })
  assert.equal(chipOf({ host: { state: 'online' }, state: 'chatting' }, false).text, '当面聊')
  assert.deepEqual(chipOf({ host: { state: 'paused' }, state: 'chatting' }, true, 'chat-1'), { text: '醒着', cls: 'chat' }, 'the chat pseudo-turn: awake, in the chat colour')
  assert.deepEqual(chipOf({ host: { state: 'online' } }, true, 'bili-whale-dm-1'), { text: '醒着', cls: 'awake' })
  assert.equal(chipOf({ host: { state: 'online' } }, false).text, '睡着')
  // 服务器没给 caption 时的兜底和 liveview.stateOf 说法一致；asleep 只说「在睡觉」（几点醒在作息那行）
  assert.equal(STATE_CAP.night_done, '在睡觉 · 今晚的事做完了'); assert.equal(STATE_CAP.day, '白天不醒，私信随时能叫醒她')
  assert.equal(STATE_CAP.done, '这回合做完了'); assert.equal(STATE_CAP.failed, '上一回合没做完'); assert.equal(STATE_CAP.asleep, '在睡觉')
  // 2026-10-25 夏令时结束那夜：02:10 出现两次，倒计时只认 atMs
  const now = Date.parse('2026-10-24T16:22:00Z'), atMs = 1792890601535
  const line = planLine({ action: 'skip', atMs, text: '下一次：2026-10-25 02:10（只写日记）' }, now)
  assert.match(line, /醒（只写日记）· 还有 /)
  assert.ok(!line.includes('今晚只写日记'), '「今晚」is not ours to say: the plan may be for tomorrow night')
  assert.ok(line.endsWith('还有 ' + fmtClock(atMs - now)))
  // 哪天：用服务器给的 plan.when（和桌宠气泡一个说法）；没有就按本地日历自己算
  assert.equal(planLine({ action: 'wake', atMs, when: '明天凌晨 02:10' }, now), `明天凌晨 02:10 醒（醒来看视频）· 还有 ${fmtClock(atMs - now)}`)
  assert.equal(planLine({ action: 'skip', atMs: now + 26 * 3600_000, when: '后天 02:10' }, now), '后天 02:10 醒（只写日记）· 还有 26:00:00')
  assert.match(planLine({ action: 'wake', atMs: now + 65_000 }, now), /醒来看视频）· 还有 1:05$/)
  assert.match(planLine({ action: 'wake', atMs: now - 30_000 }, now), /该醒了/)
  assert.equal(planLine({ action: 'done', text: '今晚已经醒过了' }, now), '今晚已经醒过了', 'not pending: the server says what actually happened')
  assert.equal(planLine(null, now), null)
  // 兜底的日历说法（本地时间算，不按 24 小时）：同一天只说钟点；12 小时内的后半夜也只说钟点（那是「今晚」）；再远说明天 / 后天 / 几月几号
  const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()
  assert.equal(whenLabel(L(2026, 10, 24, 21, 0), L(2026, 10, 24, 14, 0)), '21:00')
  assert.equal(whenLabel(L(2026, 10, 25, 2, 10), L(2026, 10, 24, 22, 0)), '02:10')
  assert.equal(whenLabel(L(2026, 10, 26, 3, 30), L(2026, 10, 25, 2, 20)), '明天凌晨 03:30', '02:20 seeing a 03:30 wake 25 h away: not "03:30"')
  assert.equal(whenLabel(L(2026, 10, 25, 7, 30), L(2026, 10, 24, 14, 0)), '明早 07:30')
  assert.equal(whenLabel(L(2026, 10, 25, 14, 0), L(2026, 10, 24, 14, 0)), '明天 14:00')
  assert.equal(whenLabel(L(2026, 10, 25, 20, 30), L(2026, 10, 24, 14, 0)), '明晚 20:30')
  assert.equal(whenLabel(L(2026, 10, 26, 20, 0), L(2026, 10, 24, 23, 0)), '后天 20:00')
  assert.equal(whenLabel(L(2026, 11, 3, 20, 0), L(2026, 10, 24, 23, 0)), '11月3日 20:00')
  assert.equal(whenLabel(NaN, now), '')
  // 排着的回合：气泡已经说「你的私信到了，马上醒」时，只排着那一条私信就不再说一遍
  assert.equal(queuedLine(['bili-whale-dm-9'], 'dm_queued'), '')
  assert.equal(queuedLine({ dm: 1, total: 1 }, 'dm_queued'), '')
  assert.equal(queuedLine({ dm: 1, total: 3 }, 'dm_queued'), '还排着 3 个回合（1 个是你的私信）')
  assert.equal(queuedLine({ dm: 2, total: 2 }, 'dm_queued'), '还排着 2 个回合（都是你的私信）')
  assert.equal(queuedLine({ dm: 1, total: 1 }, 'chatting'), '还排着 1 个回合（是你的私信）', 'while chatting the bubble does not mention the DM')
  assert.equal(queuedLine({ dm: 0, total: 2 }, 'queued'), '还排着 2 个回合')
  assert.equal(queuedLine(2, 'queued'), '还排着 2 个回合'); assert.equal(queuedLine(0, 'asleep'), ''); assert.equal(queuedLine(null, 'asleep'), '')
  // 多久听不到服务器算它停了：2.5 个心跳（服务器说的 beatSec；不像话的值按 10 秒）
  assert.equal(silentLimitMs({ beatSec: 10 }), 25_000); assert.equal(silentLimitMs({ beatSec: 4 }), 10_000)
  assert.equal(silentLimitMs(undefined), 25_000); assert.equal(silentLimitMs({ beatSec: 'x' }), 25_000); assert.equal(silentLimitMs({ beatSec: 0 }), 25_000)
  assert.equal(fmtClock(161_000), '2:41'); assert.equal(fmtClock(28_092_000), '7:48:12'); assert.equal(fmtClock(-5), '0:00')
  assert.equal(fmtDurCN(197_000), '3 分 17 秒'); assert.equal(fmtDurCN(45_000), '45 秒'); assert.equal(fmtDurCN(3_720_000), '1 小时 2 分')
  assert.equal(fmtCost(1.374), '$1.37'); assert.equal(fmtCost(0.047), '$0.047'); assert.equal(fmtCost(null), null); assert.equal(fmtCost(NaN), null)
  assert.equal(fmtTokens(8421), '8421'); assert.equal(fmtTokens(12_345), '1.2 万'); assert.equal(fmtTokens(250_000), '25 万')
  const fly = [
    { toolId: 'a', cap: '在看《一》', activity: 'watch', since: 1000 }, { toolId: 'b', cap: '在看《二》', activity: 'watch', since: 2000 },
    { toolId: 'c', cap: '在做视频《三》', activity: 'make', since: '1970-01-01T00:00:03.000Z' }, { toolId: 'd', cap: '在搜「猫」', activity: 'search' },
  ]
  assert.deepEqual(inflightChips(fly, 'c'), [{ text: '同时在看 2 条视频', since: 1000 }, { text: '在搜「猫」', since: null }])
  assert.deepEqual(inflightChips(fly.slice(2), null), [{ text: '在做视频《三》', since: 3000 }, { text: '在搜「猫」', since: null }])
  assert.deepEqual(inflightChips([fly[0]], 'a'), [], 'the one in the bubble is not repeated')
  assert.equal(inflightChips(Array.from({ length: 6 }, (_, i) => ({ toolId: 'x' + i, cap: '在读' + i })), null).at(-1).text, '还有 3 件')
  const evs = [
    { kind: 'tool_start', activity: 'watch', bv: 'BV1xx411c7mD' }, { kind: 'tool_start', activity: 'watch', bv: 'BV1xx411c7mD' },
    { kind: 'tool_start', activity: 'watch', bv: 'BV1yy411c7mD' }, { kind: 'tool_start', activity: 'write', cap: '在写日记' },
  ]
  assert.equal(summaryOf({ durationMs: 197_000, steps: 39, costUsd: 1.37, ok: true }, evs), '3 分 17 秒 · 39 步 · $1.37 · 看了 2 条 · 写了日记')
  assert.equal(summaryOf({ ok: false }, []), '没跑完')
  // 初筛（debrief --no-frames、字幕…）服务器标 seen：也算看过；只翻评论区的（没有 seen）不算；同一条只算一次
  const screened = [
    ...['BV1aa411c7mD', 'BV1bb411c7mD', 'BV1cc411c7mD', 'BV1dd411c7mD', 'BV1ee411c7mD'].map((bv) => ({ kind: 'tool_start', activity: 'read', seen: true, bv })),
    { kind: 'tool_start', activity: 'watch', bv: 'BV1aa411c7mD' }, { kind: 'tool_start', activity: 'read', bv: 'BV1ff411c7mD', cap: '在翻评论区' },
    { kind: 'tool_start', activity: 'read', seen: true, bv: 'not-a-bv' },
  ]
  assert.equal(summaryOf({ ok: true }, screened), '看了 5 条')
})

test('今天 strip: 发出 is public posts only (the server already leaves out share DMs); upload-uncertain videos are 要你核对, not 等你审; the hint names only what has work', () => {
  const T = (o) => todayStrip({ turns: 2, watched: 3, sent: 1, dmToOwner: 1, costUsd: 0.8, ...o })
  const text = (s) => s.stats.map(([x]) => x).join(' | ')
  let s = T({ pending: 1, pendingVideos: 1, pendingDrafts: 0, uncertain: 0 })
  assert.equal(text(s), '回合 2 | 看了 3 条 | 发出 1 条 | 给你私信 1 条 | 等你审 1 件 | 花了 $0.80')
  assert.deepEqual(s.stats.find(([x]) => x.startsWith('等你审'))[1], 'hot')
  assert.equal(s.review, '审：node host/cli.mjs videos', 'no drafts waiting: do not send him to pending')
  s = T({ pending: 2, pendingVideos: 0, pendingDrafts: 2, uncertain: 1 })
  assert.equal(text(s), '回合 2 | 看了 3 条 | 发出 1 条 | 给你私信 1 条 | 等你审 2 件 | 要你核对 1 件 | 花了 $0.80')
  assert.equal(s.review, '审：node host/cli.mjs pending；核对投稿结果：node host/cli.mjs dashboard')
  s = T({ pending: 0, pendingVideos: 0, pendingDrafts: 0, uncertain: 2 })
  assert.match(text(s), /等你审 0 件 \| 要你核对 2 件/)
  assert.equal(s.stats.find(([x]) => x.startsWith('等你审'))[1], '')
  assert.equal(s.review, '核对投稿结果：node host/cli.mjs dashboard', 'uncertain uploads point to the dashboard, never to `videos` (which lists only reviews)')
  s = T({ pending: 0, pendingVideos: 0, pendingDrafts: 0, uncertain: 0 })
  assert.equal(s.review, ''); assert.ok(!text(s).includes('核对'))
  // 老服务器没有分开的数：有等审的两条命令都给
  assert.equal(T({ pending: 1 }).review, '审：node host/cli.mjs videos · node host/cli.mjs pending')
  assert.equal(T({ costUsd: null, pending: -3 }).stats.at(-1)[0], '花了 —')
  assert.equal(todayStrip(null), null)
})

test('links: only bilibili / b23 addresses ever become clickable', () => {
  assert.equal(bvLink('BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD/')
  assert.equal(bvLink('BV1xx411c7mD/../x'), null); assert.equal(bvLink('av123'), null)
  assert.equal(coverUrl('BV1xx411c7mD'), '/cover/BV1xx411c7mD'); assert.equal(coverUrl('../../etc'), null)
  for (const ok of ['https://www.bilibili.com/video/BV1xx411c7mD/', 'https://t.bilibili.com/123', 'https://space.bilibili.com/1/', 'https://b23.tv/abc'])
    assert.equal(safeHref(ok), ok)
  for (const bad of ['javascript:alert(1)', 'http://www.bilibili.com/', 'https://evil.com/?bilibili.com', 'https://www.bilibili.com.evil.com/', 'https://b23.tv.evil/', '//www.bilibili.com/', 'https://www.bilibili.com/"onmouseover=x', null])
    assert.equal(safeHref(bad), null, String(bad))
})

// ─────────────── 假 DOM 里真跑 window.js ───────────────
class FakeEl {
  constructor(tag, id = '') { Object.assign(this, { tagName: String(tag).toUpperCase(), id, children: [], parentNode: null, _text: '', className: '', dataset: {}, style: {}, attrs: {}, listeners: {}, hidden: false, scrollTop: 0, scrollHeight: 0, clientHeight: 300 }) }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean), set = (a) => { this.className = a.join(' ') }
    return {
      add: (...c) => set([...new Set([...list(), ...c])]), remove: (...c) => set(list().filter((x) => !c.includes(x))), contains: (c) => list().includes(c),
      toggle: (c, force) => { const on = force === undefined ? !list().includes(c) : Boolean(force); set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c)); return on },
    }
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v) }
  set innerHTML(_) { throw new Error('innerHTML used') }
  set outerHTML(_) { throw new Error('outerHTML used') }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { const t = new FakeEl('#text'); t._text = n; n === '' || this.children.push(Object.assign(t, { parentNode: this })); continue } n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n) } }
  replaceChildren(...ns) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; this.append(...ns) }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c }
  remove() { this.parentNode?.removeChild(this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src' || k === 'href') delete this[k] }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f) }
  fire(t, more = {}) { for (const f of this.listeners[t] ?? []) f({ type: t, target: this, ...more }) }
  focus() { if (FakeEl.doc) FakeEl.doc.activeElement = this }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b }
}
const walk = (n) => [n, ...n.children.flatMap(walk)]
const byClass = (n, c) => walk(n).filter((x) => x.classList.contains(c))
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
/** 假 fetch 的回应；net.on[地址] 可以给某个地址单独回（也可以回一个还没 resolve 的 promise） */
const res = (body, status = 200) => ({ status, ok: status === 200, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'track', 'base'])

/** 装一套假的浏览器全局（按 index.html 建好带 id 的元素和初始 hidden），再导入一份新的 window.js */
async function page(t, { store = new Map(), storeThrows = false, failImages = new Set(), name = null } = {}) {
  const saved = {}
  for (const k of ['document', 'EventSource', 'fetch', 'localStorage', 'Image', 'matchMedia']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
  t.after(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k] } })
  const ids = new Map()
  for (const m of read('index.html').matchAll(/<(\w+)\s([^>]*?\bid="([^"]+)"[^>]*)>/g)) {
    const e = new FakeEl(m[1], m[3]); e.hidden = /\shidden\b/.test(' ' + m[2]); ids.set(m[3], e)
  }
  // 标题：服务填好的那个（name = 配置里的 persona.name；不给 = 页面里原样的 bili-whale）
  const doc = { title: name ?? /<title>([^<]*)<\/title>/.exec(read('index.html'))[1], hidden: false, activeElement: null, listeners: {}, body: new FakeEl('body'), getElementById: (id) => ids.get(id) ?? null, createElement: (tag) => new FakeEl(tag),
    addEventListener(tp, f) { (this.listeners[tp] ??= []).push(f) }, fire(tp, more = {}) { for (const f of this.listeners[tp] ?? []) f({ type: tp, ...more }) } }
  // body 的直接子元素（审核面板开着时它们设 inert）：按 index.html 的嵌套找最外一层，有 id 的用上面建好的那个
  const html = read('index.html'), inner = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  let depth = 0
  for (const m of inner.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
    if (m[1]) { depth--; continue }
    if (depth === 0) doc.body.append(ids.get(/\bid="([^"]+)"/.exec(m[3])?.[1]) ?? new FakeEl(m[2]))
    if (!VOID_TAGS.has(m[2].toLowerCase())) depth++
  }
  FakeEl.doc = doc
  t.after(() => { FakeEl.doc = null })
  const sources = [], fetches = [], calls = [], images = []
  // down = 连不上（fetch 直接失败，服务停了）；hang = 连上了却不回（服务卡住），一直挂到页面自己的超时把它掐掉；on = 按地址单独回
  const net = { status: 200, body: null, down: false, hang: false, on: {} }
  class FakeES {
    constructor(url) { Object.assign(this, { url, readyState: 0, listeners: {} }); sources.push(this) }
    addEventListener(tp, f) { (this.listeners[tp] ??= []).push(f) }
    emit(tp, data) { this.readyState = 1; for (const f of this.listeners[tp] ?? []) f({ data: JSON.stringify(data) }) }
    fail(closed) { this.readyState = closed ? 2 : 0; for (const f of this.listeners.error ?? []) f({}) }
    close() { this.readyState = 2; this.closed = true }
  }
  class FakeImage { set src(v) { this._src = v; images.push(v) } get src() { return this._src } decode() { return failImages.has(this._src) ? Promise.reject(new Error('404')) : Promise.resolve() } }
  const ls = storeThrows ? { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('SecurityError') } } : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
  const fetch = async (url, opts = {}) => {
    fetches.push(url); calls.push({ url, opts })
    if (net.down) throw new TypeError('Failed to fetch')
    if (net.hang) return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
    if (net.on[url]) return net.on[url](opts)
    return { status: net.status, ok: net.status === 200, json: async () => net.body }
  }
  // node 24 自己也可能带 localStorage / EventSource（实验特性，只读的 getter）：一律重新定义成我们的假货
  for (const [k, v] of Object.entries({ document: doc, EventSource: FakeES, localStorage: ls, Image: FakeImage, fetch, matchMedia: undefined }))
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
  await import(pathToFileURL(path.join(UI, 'window.js')).href + '?case=' + (++pageN))
  const $ = (id) => ids.get(id)
  const tick = async (ms) => { for (let i = 0; i < ms; i += 50) { t.mock.timers.tick(50); await flush() } }
  return { doc, $, all: () => [...ids.values()], sources, fetches, calls, images, net, store, tick, es: () => sources.at(-1) }
}
let pageN = 0
const T0 = Date.parse('2026-10-24T20:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const DM = 'bili-whale-dm-test-1'
const EXPRS = ['neutral', '低落', '别扭', '困', '小吃惊', '想事情', '浅笑']
const XSS = '<img src=x onerror=alert(1)>'
function snapshot(over = {}) {
  return {
    v: 1, at: iso(T0), host: { state: 'online', label: '在线', heartbeatAgeSec: 12 },
    turn: { id: DM, kind: 'dm', kindLabel: '主人私信', at: iso(T0 - 161_000), steps: 7, tokens: 12_345, inflight: [] },
    state: 'thinking', expr: '想事情', talking: false, caption: '在想…', outfit: '白裙', exprs: EXPRS, talkingExprs: EXPRS,
    plan: { text: '下一次：02:10（只写日记）', atMs: T0 + 7 * 3600_000 + 48 * 60_000 + 12_000, action: 'skip', reason: '本次计划跳过看视频' },
    queued: 0, lastTurn: { id: 'bili-whale-1790000000000', kindLabel: '按作息醒来', at: iso(T0 - 3600_000), durationMs: 197_000, costUsd: 0.641, ok: true },
    today: { turns: 3, costUsd: 1.94, watched: 4, watchedList: [{ bv: 'BV1xx411c7mD', title: '猫坐地铁' + XSS }, { bv: '../../x', title: 'bad' }], sent: 2, dmToOwner: 1, pending: 1 },
    feed: [
      { seq: 1, t: iso(T0 - 161_000), kind: 'turn_start', turn: DM, cap: '你发来私信' },
      { seq: 2, t: iso(T0 - 160_000), kind: 'tool_start', turn: DM, cap: '在看私信通道', glyph: '看', activity: 'read', toolId: 'tu1' },
      { seq: 3, t: iso(T0 - 158_000), kind: 'tool_end', turn: DM, cap: '有 1 条新私信', ok: true, toolId: 'tu1' },
      { seq: 4, t: iso(T0 - 150_000), kind: 'said', turn: DM, cap: '她说', text: '主人' + XSS + '好'.repeat(90), private: true },
    ],
    ...over,
  }
}
const sprite = (expr, open = false) => spriteUrl('白裙', expr, open)

test('window.js in a fake DOM: snapshot render, paced captions, privacy toggle, turn summary, reconnects', async (t) => {
  const P = await page(t, { name: '测试角色' })
  const { $, tick } = P
  assert.equal(P.sources.length, 1); assert.equal(P.es().url, '/events')
  await tick(100)
  assert.equal($('chip').textContent, '连接中'); assert.equal($('cap').textContent, '正在连上她…')
  P.net.body = snapshot()
  P.es().emit('hello', snapshot())
  await tick(100)
  // 顶栏
  assert.equal($('chip').textContent, '醒着'); assert.ok($('chip').classList.contains('awake'))
  assert.equal(P.doc.title, '测试角色 · 醒着')
  assert.equal($('kind').textContent, '你发来私信')
  assert.equal($('timer').textContent, '2:41')
  assert.equal($('steps').textContent, '7 步'); assert.equal($('meter').textContent, '1.2 万 新 token', 'new tokens only (input + output + cache writes)')
  // 快照里的动态直接铺好（不重播），气泡用服务器给的此刻状态
  assert.equal($('cap').textContent, '在想…')
  const group = byClass($('feed'), 'turn')
  assert.equal(group.length, 1)
  assert.match(byClass(group[0], 'turn-h')[0].textContent, /你发来私信/)
  const rows = byClass($('feed'), 'row')
  assert.equal(rows.length, 2, 'turn_start is the header, tool_end folds into its tool_start row')
  assert.match(rows[0].textContent, /在看私信通道.*有 1 条新私信/)
  const saidRow = rows[1]
  assert.ok(saidRow.textContent.includes('她说：「主人' + XSS), 'her words are shown by default, as plain text')
  assert.ok(saidRow.textContent.includes('…」') && !saidRow.textContent.includes('好'.repeat(80)), 'and cut to 80 chars')
  assert.equal($('feed-empty').hidden, true)
  // 立绘：解码好以后才换上；张嘴那张也备好
  assert.equal($('sp-closed').src, sprite('想事情')); assert.equal($('sp-open').src, sprite('想事情', true)); assert.equal($('sp-open').hidden, false)
  assert.equal($('stage').classList.contains('asleep'), false)
  // 今天：只有合法 BV 变成封面；标题是纯文字
  assert.match($('t-stats').textContent, /回合 3.*看了 4 条.*发出 2 条.*给你私信 1 条.*等你审 1 件.*花了 \$1\.94/)
  const covers = byClass($('t-covers'), 'cv')
  assert.equal(covers.length, 1); assert.equal(covers[0].href, 'https://www.bilibili.com/video/BV1xx411c7mD/'); assert.equal(covers[0].rel, 'noreferrer noopener')
  assert.ok(covers[0].textContent.includes(XSS))
  assert.equal($('t-review').hidden, false)

  // 一下子落下 6 条：0.6 秒、0.6 秒，然后回到 1.5 秒；动态列表跟着气泡一条条长
  const watch = (seq, n) => ({ seq, t: iso(T0 - 5000), kind: 'tool_start', turn: DM, cap: `在看《视频${n}》`, glyph: '看', activity: 'watch', toolId: 'w' + n, bv: `BV1xx411c7m${n}` })
  for (let n = 1; n <= 5; n++) P.es().emit('ev', watch(4 + n, n))
  P.es().emit('ev', { seq: 10, t: iso(T0), kind: 'said', turn: DM, cap: '她说', text: '我先看看这几条' })
  P.es().emit('ev', watch(3, 99))   // 旧序号（重连补发的重复）：丢掉
  const t1 = Date.now()
  await tick(100)
  assert.match($('cap').textContent, /^在看《视频1》 · 0:0\d$/, 'elapsed time is counted from the transcript time')
  const n = () => byClass($('feed'), 'row').length
  assert.equal(n(), 3)
  await tick(t1 + 700 - Date.now()); assert.match($('cap').textContent, /^在看《视频2》/); assert.equal(n(), 4)
  assert.equal(byClass($('chips'), 'fly')[0]?.textContent.startsWith('同时在看 2 条视频'), true)
  await tick(t1 + 1300 - Date.now()); assert.match($('cap').textContent, /^在看《视频3》/)
  await tick(t1 + 2700 - Date.now()); assert.match($('cap').textContent, /^在看《视频3》/, 'only 3 waiting now: 1.5 s each')
  await tick(t1 + 2850 - Date.now()); assert.match($('cap').textContent, /^在看《视频4》/); assert.equal(n(), 6)
  assert.equal($('cover').hidden, false); assert.equal($('cover-img').src, '/cover/BV1xx411c7m4')
  await tick(t1 + 5900 - Date.now())
  assert.equal($('cap').textContent, '她说：「我先看看这几条」'); assert.equal(n(), 8)
  assert.equal($('sp-closed').src, sprite('浅笑'))
  let flapped = 0
  for (let i = 0; i < 10; i++) { await tick(50); if ($('sprite').classList.contains('talk')) flapped++ }
  assert.ok(flapped > 0 && flapped < 10, 'the mouth opens and closes while she talks')

  // 「遮住私话」：她说的全部遮住、存进 localStorage；再点一次恢复
  $('eye').fire('click')
  assert.equal($('eye').getAttribute('aria-pressed'), 'true')
  assert.equal(P.store.get('whale-window.hide-private'), '1')
  assert.equal($('cap').textContent, '她说了句话（遮住了）')
  assert.ok(!walk($('feed')).some((x) => x._text.includes('主人') || x._text.includes('我先看看')), 'no trace of her words in the feed')
  assert.equal(byClass($('feed'), 'masked').length, 2)
  $('eye').fire('click')
  assert.equal(P.store.get('whale-window.hide-private'), '0'); assert.equal($('cap').textContent, '她说：「我先看看这几条」')

  // 用户往上翻：不再自动滚，出「N 条新动态 ↓」
  Object.assign($('feed'), { scrollHeight: 2000, scrollTop: 0, clientHeight: 300 }); $('feed').fire('scroll')
  P.es().emit('ev', { seq: 11, t: iso(Date.now()), kind: 'tool_end', turn: DM, cap: '看完了《视频1》（字幕✓ 画面✓）', ok: true, toolId: 'w1' })
  P.es().emit('ev', { seq: 12, t: iso(Date.now()), kind: 'denied', turn: DM, cap: '想跑一条不允许的命令，被拦下了' })
  await tick(200)
  assert.equal($('more').hidden, true, 'her line is still on screen (1.5 s): the next ones wait')
  await tick(1000)
  assert.equal($('more').hidden, false); assert.equal($('more').textContent, '2 条新动态 ↓')
  assert.match(byClass($('feed'), 'row')[2].textContent, /看完了《视频1》（字幕✓ 画面✓）/, 'the result lands on its own tool row')
  assert.equal($('sp-closed').src, sprite('别扭'), 'a blocked command looks 别扭')
  $('more').fire('click')
  assert.equal($('more').hidden, true); assert.equal($('feed').scrollTop, 2000)

  // 窗口藏起来 11 秒：回来直接跳到最新，中间的照样进列表
  P.doc.hidden = true; P.doc.fire('visibilitychange')
  for (let k = 13; k <= 15; k++) P.es().emit('ev', { seq: k, t: iso(Date.now()), kind: 'tool_start', turn: DM, cap: `动作${k}`, activity: 'other', toolId: 'o' + k })
  const before = n()
  await tick(11_000)
  assert.equal(n(), before, 'nothing is played while hidden')
  P.doc.hidden = false; P.doc.fire('visibilitychange')
  await tick(100)
  assert.equal(n(), before + 3); assert.match($('cap').textContent, /^动作15/)

  // 回合结束：小结卡片；顶栏换成「这回合 $x」；服务器跟上以后回到睡觉的样子
  P.es().emit('ev', { seq: 16, t: iso(Date.now()), kind: 'turn_end', turn: DM, cap: '这回合结束了', ok: true, steps: 39, durationMs: 197_000, costUsd: 1.37 })
  await tick(1600)
  const sum = byClass($('feed'), 'sum')
  assert.equal(sum.length, 1); assert.equal(sum[0].textContent, '3 分 17 秒 · 39 步 · $1.37 · 看了 5 条')
  assert.equal($('chip').textContent, '睡着'); assert.equal($('meter').textContent, '这回合 $1.37'); assert.equal($('timer').textContent, '用了 3:17')
  assert.equal($('cap').textContent, '这回合结束了')
  assert.equal(P.es().readyState, 1)
  const polled = P.fetches.length
  await tick(3000)
  assert.ok(P.fetches.length > polled, 'a turn end asks for a fresh snapshot soon')
  assert.equal($('cap').textContent, '这回合结束了', 'the server still reports the turn (it waits for the log line): keep the end caption, not its stale 「在想…」')
  assert.equal($('sp-closed').src, sprite('浅笑'), 'and the end face, not the stale 想事情')
  P.net.body = snapshot({ turn: null, state: 'asleep', expr: '困', caption: '在睡觉', feed: [] , lastTurn: { id: DM, kindLabel: '主人私信', at: iso(Date.now()), durationMs: 197_000, costUsd: 1.37, ok: true } })
  P.net.body.feed = snapshot().feed.concat([{ seq: 16, t: iso(Date.now()), kind: 'turn_end', turn: DM, cap: '这回合结束了', ok: true }])
  await tick(10_500)
  assert.equal($('cap').textContent, '在睡觉')
  assert.equal($('sp-closed').src, sprite('困')); assert.ok($('stage').classList.contains('asleep'))
  assert.match($('plan').textContent, /醒（只写日记）· 还有 7:4\d:\d\d$/)
  assert.equal($('idle').hidden, false); assert.match($('last').textContent, /上一回合.*你发来私信.*3 分 17 秒.*\$1\.37.*跑完了/)
  assert.match($('hostline').textContent, /^宿主在线 · 心跳 \d+ 秒前$/)

  // SSE 被服务器关掉（403）：页面隔一会儿重连，快照也取不到 → 告诉主人怎么重新打开
  P.net.status = 403
  P.es().fail(true)
  await tick(100)
  assert.equal($('conn').hidden, false); assert.match($('conn').textContent, /node host\/cli\.mjs window/)
  assert.equal($('chip').textContent, '连不上', 'a dead cookie means the snapshot in hand is stale too')
  assert.ok($('hostline').textContent.startsWith('这个窗口和小窗服务断开了'), 'restarted, not stopped: the host line does not say 停了')
  await tick(1100)
  assert.equal(P.sources.length, 2, 'reconnected after 1 s')
  P.net.status = 200
  P.es().emit('hello', snapshot({ feed: [{ seq: 1, t: iso(Date.now()), kind: 'turn_start', turn: 'manual-1' }] }))
  await tick(100)
  assert.equal($('conn').hidden, true)
  assert.equal(byClass($('feed'), 'turn').length, 1, 'a restarted server (sequence back to 1) rebuilds the feed instead of mixing')
})

test('window.js: private window (localStorage throws) still starts with her words shown; offline host is grey with the start command', async (t) => {
  const P = await page(t, { storeThrows: true, failImages: new Set([sprite('困', true)]) })
  P.es().emit('hello', snapshot({ host: { state: 'offline', label: '离线' }, turn: null, state: 'offline', expr: '困', caption: '', feed: snapshot().feed.slice(3) }))
  await P.tick(200)
  const { $ } = P
  assert.equal($('chip').textContent, '宿主离线'); assert.ok($('stage').classList.contains('offline'))
  assert.equal($('cap').textContent, '宿主没在跑')
  assert.match($('hostline').textContent, /node host\/cli\.mjs start/)
  assert.ok(!$('hostline').textContent.includes('宿主没在跑'), 'the bubble says it; the host line only adds the command')
  assert.equal($('sp-closed').src, sprite('困')); assert.equal($('sp-open').hidden, true, 'no open-mouth twin decoded: no flap')
  assert.ok(byClass($('feed'), 'row')[0].textContent.includes('她说：「主人'))
  $('eye').fire('click')
  assert.equal($('eye').getAttribute('aria-pressed'), 'true', 'the toggle works without storage')
  assert.ok(byClass($('feed'), 'row')[0].textContent.includes('她说了句话（遮住了）'))
})

test('window.js: the toggle remembered as on hides her words from the very first paint', async (t) => {
  const P = await page(t, { store: new Map([['whale-window.hide-private', '1']]) })
  P.es().emit('hello', snapshot())
  await P.tick(100)
  assert.equal(P.$('eye').getAttribute('aria-pressed'), 'true')
  assert.ok(!walk(P.$('feed')).some((x) => x._text.includes('主人')))
  assert.ok(byClass(P.$('feed'), 'row')[1].textContent.includes('她说了句话（遮住了）'))

  // 回合之间：排着的回合按 stateOf 的 { dm, total } 写法也数得对；私信排着时说「马上醒」
  P.es().emit('hello', snapshot({ turn: null, state: 'queued', expr: 'neutral', caption: '有人找她，马上醒', queued: { dm: 0, total: 2 } }))
  await P.tick(300)
  assert.equal(P.$('queued').textContent, '还排着 2 个回合'); assert.equal(P.$('cap').textContent, '有人找她，马上醒')
  P.es().emit('hello', snapshot({ turn: null, state: 'dm_queued', expr: '小吃惊', caption: '', queued: ['bili-whale-dm-9'] }))
  await P.tick(300)
  assert.equal(P.$('queued').hidden, true, 'the bubble already says it: the queue line does not repeat it')
  assert.equal(P.$('cap').textContent, '你的私信到了，马上醒'); assert.equal(P.$('sp-closed').src, sprite('小吃惊'))
})

test('window.js: a poll snapshot older than the live stream neither wipes nor replays the feed; a cover that is not there yet is retried', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.es().emit('hello', snapshot())
  await tick(100)
  P.es().emit('ev', { seq: 5, t: iso(Date.now()), kind: 'tool_start', turn: DM, cap: '在看《猫坐地铁》', glyph: '看', activity: 'watch', toolId: 'w1', bv: 'BV1xx411c7mD' })
  await tick(200)
  assert.match($('cap').textContent, /^在看《猫坐地铁》 · 0:00$/)
  assert.equal($('cover').hidden, false); assert.equal($('cover-img').src, '/cover/BV1xx411c7mD'); assert.equal($('cover').href, 'https://www.bilibili.com/video/BV1xx411c7mD/')
  $('cover-img').fire('error')                      // debrief 还没把封面抓下来
  await tick(200)
  assert.equal($('cover').hidden, true)
  P.net.body = snapshot()                            // 轮询拿到的快照只到 seq 4（比 SSE 推来的旧）
  const rows = byClass($('feed'), 'row').length
  await tick(10_000)
  assert.ok(P.fetches.length >= 2, 'polled meanwhile')
  assert.equal(byClass($('feed'), 'row').length, rows, 'nothing rebuilt or replayed')
  assert.match($('cap').textContent, /^在看《猫坐地铁》 · 0:10$/, 'the bubble keeps the live caption and its clock')
  assert.equal($('cover').hidden, true, 'not retried within 15 s')
  await tick(6000)
  assert.equal($('cover').hidden, false, 'retried after 15 s')
})

// ─────────────── 小窗服务停了 / 卡住了：页面自己认出来 ───────────────
const LOST_TEXT = '小窗服务停了'
test('window.js: the page came without a persona name (fresh install) → the title starts with bili-whale', async (t) => {
  const P = await page(t)
  P.net.body = snapshot()
  P.es().emit('hello', snapshot())
  await P.tick(100)
  assert.equal(P.doc.title, 'bili-whale · 醒着')
})

test('window.js: the viewer stops mid-turn → grey, 连不上, the clock stops, the banner stays one sentence; the next hello picks the turn back up', async (t) => {
  const P = await page(t, { name: '测试角色' })
  const { $, tick } = P
  P.net.body = snapshot()
  P.es().emit('hello', snapshot())
  await tick(200)
  assert.equal($('chip').textContent, '醒着'); assert.equal($('timer').textContent, '2:41')
  // 服务停了：SSE 断了（浏览器按服务器说的 3 秒自己重连一次，每次都失败），快照也取不到
  P.net.down = true
  P.es().fail(false)
  await tick(1500)
  assert.equal($('chip').textContent, '连不上'); assert.ok($('chip').classList.contains('off'))
  assert.equal(P.doc.title, '测试角色 · 连不上', 'the title still starts with her name (cli window --top)')
  assert.ok($('stage').classList.contains('offline'), 'grey like an offline host')
  assert.equal($('cap').textContent, '连不上小窗服务')
  assert.ok($('hostline').textContent.startsWith(LOST_TEXT) && !/心跳|宿主在线/.test($('hostline').textContent), 'no stale 宿主在线 · 心跳 N 秒前')
  assert.ok($('conn').textContent.startsWith(LOST_TEXT)); assert.match($('conn').textContent, /node host\/cli\.mjs window/)
  for (const k of ['kind', 'timer', 'steps', 'meter']) assert.equal($(k).textContent, '', `${k} is not left running on the last snapshot`)
  assert.equal($('chips').children.length, 0); assert.equal($('plan').hidden, true); assert.equal($('last').hidden, true)
  assert.equal($('sp-closed').src, sprite('困'))
  // 之后 30 秒：浏览器每 3 秒重连失败一次、页面每几秒轮询失败一次 —— 横幅不在两句话之间来回跳，计时不走
  const texts = [$('conn').textContent]
  for (let i = 0; i < 60; i++) {
    if (i % 6 === 0) P.es().fail(false)
    await tick(500)
    if ($('conn').textContent !== texts.at(-1)) texts.push($('conn').textContent)
  }
  assert.deepEqual(texts, [texts[0]], 'one banner sentence while it is down')
  assert.equal($('timer').textContent, ''); assert.equal($('chip').textContent, '连不上')
  assert.ok(P.fetches.length >= 8, 'still trying to reach it every few seconds')
  // 服务回来了（浏览器那条 SSE 重连上了）：还是同一个回合，接着计时
  P.net.down = false
  P.es().emit('hello', snapshot({ at: iso(Date.now()) }))
  await tick(200)
  assert.equal($('conn').hidden, true); assert.equal($('chip').textContent, '醒着'); assert.equal($('stage').classList.contains('offline'), false)
  assert.equal($('kind').textContent, '你发来私信')
  const secs = $('timer').textContent.split(':').reduce((a, x) => a * 60 + Number(x), 0)
  assert.ok(Math.abs(secs - (Date.now() - (T0 - 161_000)) / 1000) <= 1, `the clock is counted from the turn start again (${$('timer').textContent})`)
})

test('window.js: SSE looks open but the viewer says nothing for 2.5 heartbeats and polls hang → 连不上 and a fresh connection; heartbeats alone keep it alive', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.es().emit('hello', snapshot({ viewer: { startedAt: iso(T0 - 60_000), beatSec: 10 } }))
  await tick(200)
  P.net.hang = true                              // /api/live 连上了却不回：页面 8 秒后自己掐掉
  // 心跳照常来：服务活着，只是快照慢 —— 不算停
  for (let i = 0; i < 6; i++) { await tick(10_000); P.es().emit('hb', { at: iso(Date.now()) }) }
  assert.equal($('chip').textContent, '醒着'); assert.equal($('conn').hidden, true)
  // 心跳也没了（服务卡死 / 睡眠唤醒后连接半死）：25 秒没动静 + 挂着的那次轮询超时 → 认定停了，并且自己重连一次
  const n0 = P.sources.length
  await tick(40_000)
  assert.equal($('chip').textContent, '连不上'); assert.ok($('conn').textContent.startsWith(LOST_TEXT))
  assert.equal($('timer').textContent, '')
  assert.ok(P.sources.length > n0, 'it opens a new EventSource instead of trusting the silent one')
  assert.ok(P.sources[n0 - 1].closed, 'and closes the silent one')
  // 新连接的 hello：接回来
  P.net.hang = false
  P.es().emit('hello', snapshot({ viewer: { startedAt: iso(T0 - 60_000), beatSec: 10 } }))
  await tick(200)
  assert.equal($('chip').textContent, '醒着'); assert.equal($('conn').hidden, true)
  // startedAt 对不上：小窗服务重启过（又开了新的小窗、共用 cookie），或者端口上换了别的程序在冒充 —— 页面分不出来，一律不认。
  // 不收它的快照（不重画）、不再连、不再轮询、横幅说清楚；之后它推的聊天不收，按钮也不往它那儿发
  const n1 = P.sources.length, f1 = P.fetches.length
  const FAKE = 'bili-whale-win-1761456000000-abcd'
  P.es().emit('hello', snapshot({ viewer: { startedAt: iso(Date.now()), beatSec: 10 }, feed: [{ seq: 1, t: iso(Date.now()), kind: 'turn_start', turn: 'manual-2' }],
    chat: [{ id: FAKE, at: iso(Date.now()), text: '假的', state: 'done', reply: '冒充的回复' }] }))
  P.es().emit('chat', { chat: [{ id: FAKE, at: iso(Date.now()), text: '假的', state: 'done', reply: '冒充的回复' }] })
  await tick(200)
  assert.equal(byClass($('feed'), 'turn').length, 1)
  assert.doesNotMatch(byClass($('feed'), 'turn-h')[0].textContent, /你叫醒了她/, '冒充的快照没收')
  assert.equal($('chip').textContent, '连不上'); assert.match($('conn').textContent, /小窗服务重启过（或者这个端口上换了别的程序）/)
  assert.ok(P.es().closed); assert.ok(!$('chatlog').textContent.includes('冒充'))
  $('say').value = '我的私话'
  $('send').fire('click')
  await tick(60_000)
  assert.equal(P.sources.length, n1, '不再重连'); assert.deepEqual(P.fetches.slice(f1).filter((u) => u === '/api/live' || u === '/api/act'), [], '不再轮询、不发话')
  assert.match($('say-st').textContent, /小窗服务重启过（或者这个端口上换了别的程序）/)
})

test('window.js 跟她说 / 叫醒 / 替你做的事：太长的页面上就拦；发着时只读；后来没交上 → 话放回输入框；叫醒的双击不算两下；断线时漏掉的 job 重连后补上、同一件只提示一次；hello 之前推来的不收', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  const V = { startedAt: iso(T0 - 60_000), beatSec: 10 }
  const job = { id: 'j1', act: 'say', label: '跟她说', state: 'running', ok: null, out: '', at: iso(T0) }
  // 假 fetch 对每个地址都回同一个 body：快照（轮询用）+ /api/me 的令牌 + /api/act 的回应 + /api/jobs 的单子
  P.net.body = { ...snapshot({ viewer: V, chat: [] }), act: 'tok', sayMax: 2000, ok: true, job, jobs: [] }
  P.es().emit('hello', snapshot({ viewer: V, chat: [] }))
  await tick(100)
  const acts = () => P.fetches.filter((u) => u === '/api/act').length
  // 2001 个 emoji（按字符数）：页面上就拦下，不发
  $('say').value = String.fromCodePoint(0x1f600).repeat(2001)
  $('send').fire('click'); await tick(50)
  assert.match($('say-st').textContent, /太长了（2001 字/); assert.equal(acts(), 0)
  // 发出去：发着的时候只读；服务器先回「在做」→ 输入框清空
  $('say').value = '帮我看看'
  $('send').fire('click')
  assert.equal($('say').readOnly, true)
  await tick(50)
  assert.equal(acts(), 1); assert.equal($('say').readOnly, false); assert.equal($('say').value, ''); assert.match($('say-st').textContent, /正在交给她/)
  // 后来没交上（job 事件）：那句放回输入框；同一件再报一次也不重复
  P.es().emit('job', { ...job, state: 'done', ok: false, out: '✗ 没交给她：队列写不进去' })
  await tick(50)
  assert.equal($('say').value, '帮我看看'); assert.match($('say-st').textContent, /队列写不进去/)
  $('say').value = ''
  P.es().emit('job', { ...job, state: 'done', ok: false, out: '✗ 没交给她：队列写不进去' })
  await tick(50)
  assert.equal($('say').value, '', '提示过的不再放回')
  // 叫醒：点一下变「再点一下」；紧接着（双击）的第二下不算；过一会儿再点才叫
  $('b-wake').fire('click'); $('b-wake').fire('click'); await tick(50)
  assert.equal(acts(), 1); assert.equal($('b-wake').textContent, '再点一下叫醒')
  await tick(700)
  $('b-wake').fire('click'); await tick(50)
  assert.equal(acts(), 2)
  // 断线：重连上来之前推来的聊天 / job 不收；重连的 hello 之后从 /api/jobs 补上断线时做完的投稿（提示一次）
  P.es().fail(false)
  P.es().emit('chat', { chat: [{ id: 'bili-whale-win-1761456000000-abcd', at: iso(Date.now()), text: '断线时', state: 'done', reply: 'hello 之前推来的' }] })
  await tick(50)
  assert.ok(!$('chatlog').textContent.includes('hello 之前推来的'))
  const done = { id: 'j9', act: 'approve', label: '投稿《猫坐地铁》', state: 'done', ok: true, out: '✓ 投好了 BV1xx411c7mD', at: iso(Date.now() - 60_000), endedAt: iso(Date.now()) }
  P.net.body = { ...P.net.body, jobs: [done] }
  P.es().emit('hello', snapshot({ viewer: V, chat: [] }))
  await tick(100)
  assert.equal($('toast').hidden, false); assert.match($('toast-h').textContent, /✓ 投稿《猫坐地铁》/)
  $('toast-x').fire('click')
  P.es().emit('job', done)
  await tick(50)
  assert.equal($('toast').hidden, true, '同一件不再提示')
})

// ─────────────── 回合之间的几种样子 ───────────────
test('window.js between turns: day is plain (no zz), asleep says only 在睡觉 over the plan line, night_done is sleepy without zz; turn headers use start times; a chat has no cost line', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  const ID = 'bili-whale-dm-x', end = T0 - 60_000
  const idle = (over) => snapshot({ turn: null, queued: { dm: 0, total: 0 }, lastTurn: { id: ID, kindLabel: '你发来私信', at: iso(end - 240_000), endedAt: iso(end), durationMs: 240_000, costUsd: 0.1, ok: true }, ...over })
  // 白天（不在醒的窗口里）：平常的脸、不画 zz；作息那行说哪天几点
  P.es().emit('hello', idle({ state: 'day', expr: 'neutral', caption: '白天不醒，私信随时能叫醒她',
    plan: { action: 'wake', atMs: T0 + 4 * 3600_000, when: '今晚 02:00', text: '今晚 02:00 醒（醒来看视频）' },
    // 回合头早掉出最近 150 条、只剩收尾那条：组标题按开始的时刻（结束 − 用时），和「上一回合」一致
    feed: [{ seq: 1, t: iso(end), kind: 'turn_end', turn: ID, ok: true, durationMs: 240_000, costUsd: 0.1 }] }))
  await tick(2000)
  assert.equal($('cap').textContent, '白天不醒，私信随时能叫醒她')
  assert.equal($('stage').classList.contains('asleep'), false); assert.equal($('sp-closed').src, sprite('neutral'))
  assert.match($('plan').textContent, /^今晚 02:00 醒（醒来看视频）· 还有 3:59:5\d$/)
  const head = byClass($('feed'), 'turn-h')[0].textContent
  assert.equal(head.slice(0, 5), hhmm(end - 240_000), 'header = start time, not the end time')
  assert.match($('last').textContent, new RegExp(`^上一回合 · ${hhmm(end - 240_000)} 你发来私信`))
  // 在窗口里、还要醒：困 + zz；气泡只说「在睡觉」，几点醒 / 还有多久只在作息那行说一次
  P.es().emit('hello', idle({ state: 'asleep', expr: '困', caption: '在睡觉 · 今晚 02:00 醒', plan: { action: 'wake', atMs: T0 + 4 * 3600_000, when: '今晚 02:00' }, feed: [] }))
  await tick(300)
  assert.equal($('cap').textContent, '在睡觉'); assert.ok($('stage').classList.contains('asleep'))
  assert.match($('plan').textContent, /^今晚 02:00 醒（醒来看视频）· 还有 3:59:5\d$/)
  // 今晚的事做完了：困的脸，不画 zz
  P.es().emit('hello', idle({ state: 'night_done', expr: '困', caption: '在睡觉 · 今晚的事做完了', plan: { action: 'done', atMs: null, text: '今晚已经醒过了' }, feed: [] }))
  await tick(300)
  assert.equal($('cap').textContent, '在睡觉 · 今晚的事做完了'); assert.equal($('sp-closed').src, sprite('困'))
  assert.equal($('stage').classList.contains('asleep'), false); assert.equal($('plan').textContent, '今晚已经醒过了')
  // cli open 当面聊：服务器给一个 chat-<毫秒> 的假回合 —— 牌子「醒着」、种类「你在和她当面聊」，走表、新 token
  const CHAT = 'chat-' + (T0 - 60_000)
  const chatTurn = { id: CHAT, kind: 'chat', kindLabel: '你在和她当面聊', at: iso(T0 - 60_000), steps: 2, tokens: 3000, inflight: [] }
  const chatStart = { seq: 2, t: iso(T0 - 60_000), kind: 'turn_start', turn: CHAT, cap: '你在和她当面聊' }
  P.es().emit('hello', idle({ host: { state: 'paused', label: '你在和她当面聊', heartbeatAgeSec: 5 }, state: 'chatting', expr: '浅笑', caption: '你正在和她当面聊', turn: chatTurn,
    feed: [chatStart] }))
  await tick(2000)
  assert.deepEqual([$('chip').textContent, $('chip').className], ['醒着', 'chip chat'])
  assert.equal($('kind').textContent, '你在和她当面聊'); assert.equal($('meter').textContent, '3000 新 token')
  assert.ok(byClass($('feed'), 'turn-h').some((h) => h.textContent.includes('你在和她当面聊')))
  // 聊完一句、快照里没有假回合了：没有花费可算，不挂「这回合 · 花费待算」；同一句不在牌子、气泡、宿主那行出现三次
  P.es().emit('hello', idle({ host: { state: 'paused', label: '你在和她当面聊', heartbeatAgeSec: 5 }, state: 'chatting', expr: '浅笑', caption: '你正在和她当面聊', feed: [chatStart] }))
  await tick(2000)
  assert.equal(byClass($('feed'), 'turn').length, 1, 'the same feed (no rebuild): the chat group is still there')
  assert.deepEqual([$('kind').textContent, $('timer').textContent, $('meter').textContent], ['', '', ''], 'no 「这回合 · 花费待算」 for a chat')
  assert.equal($('chip').textContent, '当面聊')
  assert.equal($('cap').textContent, '你正在和她当面聊'); assert.equal($('hostline').textContent, '宿主在等你们聊完再叫醒她')
  assert.equal(byClass($('feed'), 'sum').length, 0, 'a chat never gets a turn summary')
})

// ─────────────── 端口上换了服务 / 替你做的事的先后 / 重连前攒着的事件 ───────────────
const VW = { startedAt: iso(T0 - 60_000), beatSec: 10 }
const otherViewer = () => ({ startedAt: iso(Date.now()), beatSec: 10 })
const REPLACED_RE = /小窗服务重启过（或者这个端口上换了别的程序）/
const DEAD_SAY = '这个窗口不能用了：从命令行重开'
const REPLACED_HOST = '这个窗口不再连小窗服务了：这里看不到她现在的状态'
const CAT ={ id: '202610260900-cat', sub: 's1', title: '猫', meta: { tags: [], desc: 'd' }, hasFile: true }
const buttonIn = (root, text) => walk(root).find((x) => x.tagName === 'BUTTON' && x.textContent === text)
const textareaIn = (root) => walk(root).find((x) => x.tagName === 'TEXTAREA')
const actCount = (P) => P.fetches.filter((u) => u === '/api/act').length
const lastActBody = (P) => JSON.parse(P.calls.filter((c) => c.url === '/api/act').at(-1).opts.body)

test('window.js: a POLL answered by a different viewer (startedAt changed) retires the window — one banner nothing overwrites (not 实时连接断了 / 停了 / 登录失效, even on later errors or 403), a dead input, no more polls, acts or reconnects', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  assert.equal($('chip').textContent, '醒着')
  // 服务器把 SSE 关了（readyState 2）：页面马上轮询、之后每 3 秒一次，1 秒后自己重连
  P.es().fail(true)
  await tick(1500)
  assert.equal($('conn').textContent, '实时连接断了，先每几秒刷新一次…')
  assert.equal(P.sources.length, 2, 'reconnecting')
  // 轮询拿到的快照 startedAt 对不上：端口上回应的已经不是开这个窗口的那个服务
  P.net.body = { ...P.net.body, viewer: otherViewer(), feed: [{ seq: 1, t: iso(Date.now()), kind: 'turn_start', turn: 'manual-9' }] }
  await tick(3500)
  assert.match($('conn').textContent, REPLACED_RE); assert.equal($('conn').hidden, false)
  assert.equal($('chip').textContent, '连不上')
  assert.equal($('say').placeholder, DEAD_SAY)
  assert.equal($('b-review').disabled, true)
  assert.ok(P.es().closed, 'the reconnecting stream is closed too')
  assert.doesNotMatch(byClass($('feed'), 'turn-h').map((h) => h.textContent).join(' '), /你叫醒了她/, 'its snapshot was not taken')
  // 之后不管再发生什么（旧连接还在报错、403、连不上、窗口藏起来又回来、它又推 hello、你点按钮），都不改那句、不再联系它
  const f0 = P.fetches.length, n0 = P.sources.length, banner = $('conn').textContent
  P.net.status = 403
  P.sources[0].fail(true); P.es().fail(false); P.es().emit('hb', { at: iso(Date.now()) })
  P.doc.hidden = true; P.doc.fire('visibilitychange'); P.doc.hidden = false; P.doc.fire('visibilitychange')
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  $('say').value = '我的私话'; $('send').fire('click')
  $('b-review').fire('click')
  await tick(200)
  assert.match($('say-st').textContent, REPLACED_RE, 'the button says why nothing was sent')
  assert.equal($('sheet').hidden, true, 'the review sheet does not open any more')
  P.net.status = 200; P.net.down = true
  $('b-wake').fire('click'); await tick(700); $('b-wake').fire('click')
  await tick(60_000)
  assert.equal($('conn').textContent, banner)
  assert.doesNotMatch($('conn').textContent, /实时连接断了|小窗服务停了|登录失效/)
  assert.equal($('hostline').textContent, '这个窗口不再连小窗服务了：这里看不到她现在的状态', '宿主那行也不说「停了」')
  assert.equal($('say').placeholder, DEAD_SAY); assert.equal($('b-review').disabled, true)
  assert.deepEqual(P.fetches.slice(f0).filter((u) => u === '/api/live' || u === '/api/act'), [], 'no more polls, nothing sent')
  assert.equal(P.sources.length, n0, 'no new EventSource')
})

test('window.js: a poll still in flight when the window retires (hello from a different viewer) comes back 403 → the banner keeps the replaced sentence, nothing is retried', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  let gate = null
  P.net.on['/api/live'] = () => { gate = deferred(); return gate.promise }
  P.es().fail(true)                                  // 马上轮询（挂着）、1 秒后重连
  await tick(1200)
  assert.ok(gate, 'a poll is in flight'); assert.equal(P.sources.length, 2)
  P.es().emit('hello', snapshot({ viewer: otherViewer(), chat: [] }))
  await tick(50)
  assert.match($('conn').textContent, REPLACED_RE)
  const f0 = P.fetches.length, n0 = P.sources.length
  gate.resolve(res(null, 403)); await tick(50)
  assert.match($('conn').textContent, REPLACED_RE, 'the late 403 does not turn it into 登录失效')
  assert.doesNotMatch($('conn').textContent, /登录失效|小窗服务停了|实时连接断了/)
  assert.equal($('hostline').textContent, REPLACED_HOST, 'nor the host line into 「断开了」')
  await tick(30_000)
  assert.match($('conn').textContent, REPLACED_RE)
  assert.equal($('hostline').textContent, REPLACED_HOST, 'the host line (redrawn every 0.2 s) still says the replaced sentence')
  assert.deepEqual(P.fetches.slice(f0).filter((u) => u === '/api/live' || u === '/api/act'), [])
  assert.equal(P.sources.length, n0)
})

test('window.js: a job already reported done stays done — a later /api/jobs list (or SSE copy) that still says running neither greys 叫醒她 again nor makes the review sheet busy', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.net.on['/api/review'] = () => res({ videos: [CAT], channel: null })
  const hello = async () => { P.es().emit('hello', snapshot({ viewer: VW, chat: [] })); await tick(100) }
  await hello()
  const wake = { id: 'jw', act: 'wake', label: '叫醒她', state: 'running', ok: null, out: '' }
  P.es().emit('job', wake); await tick(50)
  assert.equal($('b-wake').disabled, true, 'running: not twice')
  P.es().emit('job', { ...wake, state: 'done', ok: true, out: '✓ 叫醒了' }); await tick(50)
  assert.equal($('b-wake').disabled, false); assert.equal($('say-st').textContent, '✓ 叫醒了')
  const synced = P.fetches.filter((u) => u === '/api/jobs').length
  P.net.body = { ...P.net.body, jobs: [wake] }        // 这份单子是它做完之前拿的
  await hello()
  assert.equal(P.fetches.filter((u) => u === '/api/jobs').length, synced + 1, 'the hello synced the jobs')
  assert.equal($('b-wake').disabled, false, 'the stale running copy does not grey the button again')
  P.es().emit('job', wake); await tick(50)
  assert.equal($('b-wake').disabled, false, 'nor does a stale running copy on SSE')

  // 审核：投稿在做 → 卡片上投稿 / 退回都不能点；做完了 → 能点；之后旧单子里还说「在做」→ 照样能点
  $('b-review').fire('click'); await tick(100)
  const sb = $('sheet-body')
  assert.ok(!buttonIn(sb, '投稿').disabled && !buttonIn(sb, '退回').disabled)
  const ap = { id: 'ja', act: 'approve', label: '投稿《猫》', state: 'running', ok: null, out: '' }
  P.es().emit('job', ap); await tick(50)
  assert.equal(buttonIn(sb, '投稿').disabled, true); assert.equal(buttonIn(sb, '退回').disabled, true)
  P.es().emit('job', { ...ap, state: 'done', ok: true, out: '✓ 投好了 BV1xx411c7mD' }); await tick(100)
  assert.ok(!buttonIn(sb, '投稿').disabled && !buttonIn(sb, '退回').disabled)
  P.net.body = { ...P.net.body, jobs: [wake, ap] }
  await hello()
  assert.equal($('sheet').hidden, false)
  assert.ok(!buttonIn(sb, '投稿').disabled && !buttonIn(sb, '退回').disabled, 'a stale running approve does not make the sheet busy again')
  assert.ok(!sb.textContent.includes('进行中'))
  P.es().emit('job', ap); await tick(50)
  assert.ok(!buttonIn(sb, '投稿').disabled, 'nor on SSE')
  assert.equal($('b-wake').disabled, false)
})

test('window.js: the say job ends on SSE before /api/act answers → the page goes by the job: done → input cleared and its out shown (not stuck on 正在交给她…); failed → the text stays in the input', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', sayMax: 2000, jobs: [] }
  let gate = null
  P.net.on['/api/act'] = () => { gate = deferred(); return gate.promise }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  // 交上了
  $('say').value = '帮我看看'
  $('send').fire('click'); await tick(50)
  assert.ok(gate, '/api/act is waiting'); assert.equal(actCount(P), 1)
  assert.equal($('say').readOnly, true); assert.equal($('send').disabled, true); assert.equal($('say-st').textContent, '正在交给她…')
  assert.equal(P.calls.at(-1).opts.headers['x-whale-act'], 'tok'); assert.deepEqual(lastActBody(P), { act: 'say', text: '帮我看看' })
  const j1 = { id: 'js1', act: 'say', label: '跟她说', state: 'running', ok: null, out: '' }
  P.es().emit('job', { ...j1, state: 'done', ok: true, out: '写进队列了\n✓ 交给她了：排在第 1 个' }); await tick(50)
  gate.resolve(res({ ok: true, job: j1 })); await tick(50)
  assert.equal($('say').value, ''); assert.equal($('say').readOnly, false); assert.equal($('send').disabled, false)
  assert.equal($('say-st').textContent, '✓ 交给她了：排在第 1 个'); assert.ok($('say-st').classList.contains('ok'))
  await tick(5000)
  assert.equal($('say-st').textContent, '✓ 交给她了：排在第 1 个', 'not stuck on 正在交给她…')
  // 没交上
  gate = null
  $('say').value = '再帮我看看'
  $('send').fire('click'); await tick(50)
  assert.ok(gate); assert.equal(actCount(P), 2)
  const j2 = { id: 'js2', act: 'say', label: '跟她说', state: 'running', ok: null, out: '' }
  P.es().emit('job', { ...j2, state: 'done', ok: false, out: '✗ 没交给她：队列写不进去' }); await tick(50)
  gate.resolve(res({ ok: true, job: j2 })); await tick(50)
  assert.equal($('say').value, '再帮我看看', 'the text stays in the input'); assert.equal($('say').readOnly, false)
  assert.equal($('say-st').textContent, '✗ 没交给她：队列写不进去'); assert.ok($('say-st').classList.contains('bad'))
})

test('window.js review sheet: a reject that comes back failed keeps the box and the reason (fix it and press again); a good one closes the box', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [], today: { ...snapshot().today, pendingVideos: 1 } }), act: 'tok', jobs: [], videos: [CAT], channel: null }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [], today: { ...snapshot().today, pendingVideos: 1 } }))
  await tick(100)
  assert.equal($('review-badge').textContent, '1')
  $('b-review').fire('click'); await tick(100)
  const sb = $('sheet-body')
  assert.equal(byClass(sb, 'card').length, 1); assert.equal(byClass(sb, 'card-h')[0].textContent, '猫')
  buttonIn(sb, '退回').fire('click')
  const box = byClass(sb, 'reject')[0]
  assert.ok(box, 'the reject box opens')
  textareaIn(box).value = '画面太暗'; textareaIn(box).fire('input')
  let answer = { ok: true, job: { id: 'j5', act: 'reject', state: 'done', ok: false, out: '✗ 没退成' } }
  P.net.on['/api/act'] = () => res(answer)
  buttonIn(box, '退回').fire('click'); await tick(50)
  assert.deepEqual(lastActBody(P), { act: 'reject', id: CAT.id, sub: 's1', text: '画面太暗' })
  assert.equal(byClass(sb, 'reject').length, 1, 'the box stays')
  assert.equal(textareaIn(sb)?.value, '画面太暗', 'with the reason in it')
  assert.ok(!buttonIn(box, '退回').disabled, 'and can be pressed again')
  const note = byClass(sb, 'note')[0]
  assert.equal(note.textContent, '✗ 没退成'); assert.ok(note.classList.contains('bad'))
  answer = { ok: true, job: { id: 'j6', act: 'reject', state: 'done', ok: true, out: '✓ 退回了' } }
  buttonIn(box, '退回').fire('click'); await tick(50)
  assert.equal(actCount(P), 2)
  assert.equal(byClass(sb, 'reject').length, 0, 'done: the box closes'); assert.equal(textareaIn(sb), undefined)
  assert.equal(byClass(sb, 'note')[0].textContent, '✓ 退回了')
})

test('window.js reconnect: ev pushed before the hello is buffered and merged with the hello feed (the hello only carries the last 150); a job pushed before the hello is dropped', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  const step = (seq) => ({ seq, t: iso(Date.now()), kind: 'tool_start', turn: DM, cap: `动作${seq}`, glyph: '读', activity: 'read', toolId: 'r' + seq })
  // 浏览器自己重连：服务器先补发漏掉的 5..8，再给 hello（hello 的快照里只剩 8..9）
  P.es().fail(false)
  await tick(100)
  for (let s = 5; s <= 8; s++) P.es().emit('ev', step(s))
  P.es().emit('job', { id: 'jw', act: 'wake', label: '叫醒她', state: 'running', ok: null, out: '' })
  P.es().emit('job', { id: 'jd', act: 'approve', label: '投稿《猫》', state: 'done', ok: true, out: '✓ 投好了', endedAt: iso(Date.now()) })
  await tick(100)
  assert.ok(!$('feed').textContent.includes('动作'), 'nothing is shown before the hello checks the viewer')
  P.es().emit('hello', snapshot({ viewer: VW, chat: [], feed: [step(8), step(9)] }))
  await tick(10_000)
  const caps = byClass($('feed'), 'row').map((r) => r.textContent).filter((x) => x.includes('动作'))
  assert.equal(caps.length, 5)
  for (let s = 5; s <= 9; s++) assert.ok(caps[s - 5].includes(`动作${s}`), `动作${s} in order`)
  assert.equal(byClass($('feed'), 'turn').length, 1, 'merged into the same turn, not rebuilt')
  assert.equal($('b-wake').disabled, false, 'the running job pushed before the hello was dropped')
  assert.equal($('toast').hidden, true, 'and so was the done one')
})

test('window.js reconnect: ev buffered before a hello from a DIFFERENT viewer are dropped and the page dies', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  const step = (seq) => ({ seq, t: iso(Date.now()), kind: 'tool_start', turn: DM, cap: `动作${seq}`, glyph: '读', activity: 'read', toolId: 'r' + seq })
  P.es().fail(false)
  await tick(100)
  for (let s = 5; s <= 8; s++) P.es().emit('ev', step(s))
  P.es().emit('hello', snapshot({ viewer: otherViewer(), chat: [], feed: [step(8), step(9)] }))
  await tick(10_000)
  assert.ok(!$('feed').textContent.includes('动作'), 'none of the buffered events (nor its feed) is shown')
  assert.match($('conn').textContent, REPLACED_RE); assert.equal($('say').placeholder, DEAD_SAY)
  assert.ok(P.es().closed)
})

// ─────────────── 审核面板 ───────────────
test('window.js review sheet: modal (the rest of the page is inert); a draft survives repaints but not a resubmitted card; the confirm box survives a repaint until its code expires; a running approve disables the card; Esc closes; a replaced viewer closes it', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  let review = { videos: [CAT], channel: null }
  P.net.on['/api/review'] = () => res(review)
  const snap = (n, over = {}) => snapshot({ viewer: VW, chat: [], today: { ...snapshot().today, pendingVideos: n }, ...over })
  P.net.body = { ...snap(1), act: 'tok', jobs: [] }
  P.es().emit('hello', snap(1))
  await tick(100)
  const kids = P.doc.body.children, sheet = $('sheet'), toastEl = $('toast')
  assert.ok(kids.length >= 8 && kids.includes(sheet) && kids.includes(toastEl) && kids.includes($('dock')), 'body children come from index.html')
  // 打开：后面的页面都 inert（面板和右下角的提示除外）
  $('b-review').fire('click'); await tick(100)
  assert.equal(sheet.hidden, false)
  for (const c of kids) assert.equal(c.inert === true, c !== sheet && c !== toastEl, `inert: ${c.id || c.tagName}`)
  const sb = $('sheet-body')
  assert.equal(byClass(sb, 'card').length, 1)

  // 退回框里写了一半：「退回」在做的 job 事件让面板重画 → 框和字都还在，光标也放回去
  buttonIn(sb, '退回').fire('click')
  const ta0 = textareaIn(sb)
  ta0.value = '画面太暗'; ta0.fire('input')
  ta0.setSelectionRange(2, 2)                             // 光标停在「画面|太暗」
  assert.equal(P.doc.activeElement, ta0)
  const rj = { id: 'jr', act: 'reject', label: '退回《猫》', state: 'running', ok: null, out: '' }
  P.es().emit('job', rj); await tick(50)
  assert.notEqual(textareaIn(sb), ta0, 'the sheet was repainted')
  assert.equal(textareaIn(sb).value, '画面太暗', 'the draft is kept')
  assert.equal(P.doc.activeElement, textareaIn(sb), 'and the cursor is put back into it')
  assert.deepEqual([textareaIn(sb).selectionStart, textareaIn(sb).selectionEnd], [2, 2], 'at the same place')
  assert.ok(buttonIn(sb, '投稿').disabled && buttonIn(sb, '退回').disabled, 'one review at a time')
  P.es().emit('job', { ...rj, state: 'done', ok: false, out: '✗ 没退成' }); await tick(100)
  assert.equal(textareaIn(sb)?.value, '画面太暗', 'reloaded, same card: still kept')
  // 她重交了（sub 变了）：另一张卡片，旧的框和草稿不带过去
  review = { videos: [{ ...CAT, sub: 's2' }], channel: null }
  P.net.body = { ...P.net.body, ...snap(2) }
  P.es().emit('hello', snap(2)); await tick(100)
  assert.equal(byClass(sb, 'card').length, 1)
  assert.equal(byClass(sb, 'reject').length, 0, 'the box of the old version is gone')
  buttonIn(sb, '退回').fire('click')
  assert.equal(textareaIn(sb).value, '', 'and so is its draft')
  buttonIn(byClass(sb, 'reject')[0], '算了').fire('click')
  assert.equal(textareaIn(sb), undefined)

  // 投稿：第一下拿确认口令 → 确认框；面板重画后照样在；口令过期（最多 115 秒）就收掉
  P.net.on['/api/act'] = () => res({ ok: true, need: 'confirm', confirm: 'x'.repeat(24), expiresInSec: 120, title: '猫', seconds: 30 })
  buttonIn(sb, '投稿').fire('click'); await tick(50)
  assert.deepEqual(lastActBody(P), { act: 'approve', id: CAT.id, sub: 's2' })
  const confirmBox = () => byClass(sb, 'confirm')[0]
  const c0 = confirmBox()
  assert.ok(c0, 'a confirm box'); assert.match(c0.textContent, /《猫》（30 秒）/); assert.ok(buttonIn(c0, '确认投稿'))
  P.es().emit('hello', snap(2)); await tick(100)          // hello → /api/jobs → 面板重画
  assert.ok(confirmBox() && confirmBox() !== c0, 'repainted, and the confirm box is still there')
  await tick(110_000)
  assert.ok(confirmBox(), 'still there after 110 s')
  await tick(6_000)
  assert.equal(confirmBox(), undefined, 'gone once the code has expired')

  // 投稿在做：卡片上投稿 / 退回都不能点，底下说在做什么
  const ap = { id: 'ja', act: 'approve', label: '投稿《猫》', state: 'running', ok: null, out: '' }
  P.es().emit('job', ap); await tick(50)
  assert.equal(buttonIn(sb, '投稿').disabled, true); assert.equal(buttonIn(sb, '退回').disabled, true)
  assert.match(byClass(sb, 'note')[0].textContent, /「投稿《猫》」进行中：上传 \+ 提交/)
  P.es().emit('job', { ...ap, state: 'done', ok: true, out: '✓ 投好了 BV1xx411c7mD' }); await tick(100)
  assert.ok(!buttonIn(sb, '投稿').disabled); assert.equal($('toast-h').textContent, '✓ 投稿《猫》')

  // Esc 关上：inert 撤掉
  P.doc.fire('keydown', { key: 'Escape' })
  assert.equal(sheet.hidden, true)
  for (const c of kids) if (c !== sheet && c !== toastEl) assert.equal(c.inert, false, `not inert: ${c.id || c.tagName}`)
  // 换了服务（startedAt 对不上）：开着的面板关上、再也打不开
  $('b-review').fire('click'); await tick(100)
  assert.equal(sheet.hidden, false)
  P.es().emit('hello', snap(2, { viewer: otherViewer() })); await tick(100)
  assert.equal(sheet.hidden, true)
  for (const c of kids) assert.notEqual(c.inert, true, `not inert: ${c.id || c.tagName}`)
  assert.equal($('b-review').disabled, true)
  $('b-review').fire('click'); await tick(100)
  assert.equal(sheet.hidden, true)
})

// ─────────────── 聊天：遮住私话 / 第一次对 job / 一句多长 ───────────────
const CHAT_AT = iso(T0 - 60_000)
const PRIVATE_CHAT = [
  { id: 'bili-whale-win-1761456000000-aaaa', at: CHAT_AT, text: '我的私话', state: 'done', reply: '她的回复', replyAt: CHAT_AT },
  { id: 'bili-whale-win-1761456001000-bbbb', at: CHAT_AT, text: 'x', state: 'failed', error: '带着她的话的原因' },
]
const CHAT_SECRETS = ['我的私话', '她的回复', '带着她的话的原因']

test('window.js chat: 「遮住私话」 masks what you said, her reply and a failure reason (it may quote her); off again shows them', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.es().emit('hello', snapshot({ viewer: VW, chat: PRIVATE_CHAT }))
  await tick(100)
  const log = $('chatlog')
  for (const s of CHAT_SECRETS) assert.ok(log.textContent.includes(s), `shown by default: ${s}`)
  assert.equal(byClass(log, 'masked').length, 0)
  $('eye').fire('click')
  for (const s of CHAT_SECRETS) assert.ok(!log.textContent.includes(s), `masked: ${s}`)
  assert.ok(log.textContent.includes('（遮住了）')); assert.match(log.textContent, /这一回合没做完：（遮住了）/)
  const msgs = byClass(log, 'msg')
  assert.equal(msgs.length, 3); assert.ok(msgs.every((m) => m.classList.contains('masked')))
  $('eye').fire('click')
  for (const s of CHAT_SECRETS) assert.ok(log.textContent.includes(s), `shown again: ${s}`)
  assert.ok(!log.textContent.includes('（遮住了）')); assert.equal(byClass(log, 'masked').length, 0)
})

test('window.js chat: the toggle remembered as on masks the chat from the very first paint', async (t) => {
  const P = await page(t, { store: new Map([['whale-window.hide-private', '1']]) })
  P.es().emit('hello', snapshot({ viewer: VW, chat: PRIVATE_CHAT }))
  await P.tick(100)
  const log = P.$('chatlog')
  for (const s of CHAT_SECRETS) assert.ok(!log.textContent.includes(s), `masked: ${s}`)
  assert.ok(log.textContent.includes('（遮住了）'))
  const msgs = byClass(log, 'msg')
  assert.equal(msgs.length, 3); assert.ok(msgs.every((m) => m.classList.contains('masked')))
})

test('window.js first /api/jobs sync: only a review that ended in the last 2 minutes is toasted (once); an old say result is not replayed under the input; a running wake greys 叫醒她', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  const jobs = [
    { id: 'a1', act: 'approve', label: '投稿《新的》', state: 'done', ok: true, out: '✓ 投好了', at: iso(T0 - 300_000), endedAt: iso(T0 - 30_000) },
    { id: 'a2', act: 'approve', label: '投稿《旧的》', state: 'done', ok: true, out: '✓ 投好了', at: iso(T0 - 900_000), endedAt: iso(T0 - 10 * 60_000) },
    { id: 's1', act: 'say', label: '跟她说', state: 'done', ok: false, out: '✗ 没交给她：很久以前的', at: iso(T0 - 100_000), endedAt: iso(T0 - 90_000) },
    { id: 'w1', act: 'wake', label: '叫醒她', state: 'running', ok: null, out: '', at: iso(T0 - 5_000) },
  ]
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs }
  // 数一共提示了几次（每次提示都换右下角的标题）
  const th = $('toast-h'), d = Object.getOwnPropertyDescriptor(FakeEl.prototype, 'textContent')
  let toasts = 0
  Object.defineProperty(th, 'textContent', { configurable: true, get() { return d.get.call(this) }, set(v) { toasts++; d.set.call(this, v) } })
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  assert.equal(toasts, 1, 'exactly one toast')
  assert.equal($('toast').hidden, false); assert.equal(th.textContent, '✓ 投稿《新的》')
  assert.equal($('say-st').textContent, '', 'an old say result is not shown under the input')
  assert.equal($('b-wake').disabled, true, 'the running wake greys the button')
  // 下一个 hello 拿到同一份单子：不再提示
  $('toast-x').fire('click')
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  assert.equal(toasts, 1); assert.equal($('toast').hidden, true); assert.equal($('say-st').textContent, '')
})

test('window.js: the per-message limit comes from /api/me (sayMax) — over it the page stops the message itself and sends nothing', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', sayMax: 5, ok: true, jobs: [], job: { id: 'jm', act: 'say', label: '跟她说', state: 'running', ok: null, out: '' } }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  $('say').value = '一二三四五六'
  $('send').fire('click'); await tick(50)
  assert.match($('say-st').textContent, /一句最多 5 字/); assert.match($('say-st').textContent, /6 字/)
  assert.equal(actCount(P), 0, 'nothing sent'); assert.equal($('say').value, '一二三四五六', 'the text stays')
  $('say').value = '一二三四五'
  $('send').fire('click'); await tick(50)
  assert.equal(actCount(P), 1, 'exactly the limit goes through')
})

// ─────────────── 断线重连那几秒：轮询来的快照 vs 补发的事件 ───────────────
const stepEv = (seq) => ({ seq, t: iso(T0), kind: 'tool_start', turn: DM, cap: `动作${seq}`, glyph: '读', activity: 'read', toolId: 'r' + seq })
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const seqsShown = (P) => byClass(P.$('feed'), 'row').map((r) => /动作(\d+)/.exec(r.textContent)?.[1]).filter(Boolean).map(Number)
// 服务器那边又出了 5..204，快照里只放得下最近 150 条（55..204）
const gapBody = () => ({ ...snapshot({ viewer: VW, chat: [], feed: range(55, 204).map(stepEv) }), act: 'tok', jobs: [] })

test('window.js reconnect: a poll that comes while the browser is reconnecting does not take a feed that skips ahead (the replay fills the gap) → after the replay + hello all 200 missed events are in the feed', async (t) => {
  const P = await page(t)
  const { tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  P.es().fail(false)                                   // 断了，浏览器自己在重连（readyState 0）
  const live0 = P.fetches.filter((u) => u === '/api/live').length
  P.net.body = gapBody()
  await tick(3000)
  assert.ok(P.fetches.filter((u) => u === '/api/live').length > live0, 'polled meanwhile')
  assert.deepEqual(seqsShown(P), [], 'the poll did not jump ahead to 55..204')
  // 重连上了：服务器先补发 5..204，再给 hello（快照里还是 55..204）
  for (const s of range(5, 204)) P.es().emit('ev', stepEv(s))
  P.es().emit('hello', snapshot({ viewer: VW, chat: [], feed: range(55, 204).map(stepEv) }))
  await tick(12_000)
  assert.deepEqual(seqsShown(P), range(5, 204), 'every missed event, in order')
})

test('window.js reconnect: no hello within 8 s of the first drop → polls take their feed again (the feed does not freeze while the browser keeps retrying every 3 s)', async (t) => {
  const P = await page(t)
  const { tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  P.es().fail(false)
  P.net.body = gapBody()
  await tick(3000); P.es().fail(false)                 // 浏览器每 3 秒重连失败一次：从第一次断开算，不是从最后一次
  await tick(3000); P.es().fail(false)
  await tick(1500)
  assert.deepEqual(seqsShown(P), [], 'within 8 s: still waiting for the replay')
  for (let i = 0; i < 6; i++) { await tick(3000); P.es().fail(false) }
  assert.deepEqual(seqsShown(P), range(55, 204), 'after 8 s the polled feed is taken')
})

test('window.js reconnect: a brand-new EventSource (the old one was closed for good) gets no replay → polls are not held for it', async (t) => {
  const P = await page(t)
  const { tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(200)
  P.es().fail(false)                                   // 浏览器自己重连……
  await tick(500)
  P.es().fail(true)                                    // ……被拒了（readyState 2）：页面马上轮询一次，1 秒后自己开一条新的
  await tick(50)
  P.net.body = gapBody()
  await tick(1000)
  assert.equal(P.sources.length, 2); assert.equal(P.es().readyState, 0, 'the new stream is still connecting')
  await tick(3000)                                     // 离第一次断开才 4.5 秒
  assert.ok(seqsShown(P).length > 0, 'the poll took its feed: a new stream replays nothing, there is nothing to wait for')
  await tick(12_000)
  assert.deepEqual(seqsShown(P), range(55, 204))
})

// ─────────────── act()：等的时候认出换了服务 ───────────────
test('window.js: the window retires while act() waits for its token → nothing is sent, the late token (and its sayMax) is not taken, the reason is the replaced sentence, the text stays', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), jobs: [] }
  const me = []
  P.net.on['/api/me'] = () => { const d = deferred(); me.push(d); return d.promise }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  $('say').value = '我的私话'
  $('send').fire('click'); await tick(50)
  assert.equal($('say-st').textContent, '正在交给她…')
  assert.equal(me.length, 2, 'the hello and act() are both waiting for /api/me')
  P.es().emit('hello', snapshot({ viewer: otherViewer(), chat: [] }))   // 等的时候认出换了服务
  await tick(50)
  for (const d of me) d.resolve(res({ act: 'IMPOSTOR-TOKEN', sayMax: 1 }))
  await tick(100)
  assert.equal(actCount(P), 0, 'nothing was sent')
  assert.match($('say-st').textContent, REPLACED_RE)
  assert.equal($('say').value, '我的私话'); assert.equal($('say').readOnly, false)
  // 它晚到的 sayMax 也没收：再点一次，拦下的理由还是「换了服务」，不是「太长了（一句最多 1 字）」
  $('send').fire('click'); await tick(50)
  assert.match($('say-st').textContent, REPLACED_RE); assert.doesNotMatch($('say-st').textContent, /太长了/)
  await tick(30_000)
  assert.equal(actCount(P), 0)
})

test('window.js: the window retires while /api/act is in flight → that answer (even a done job) is shown nowhere and the text stays', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  let gate = null
  P.net.on['/api/act'] = () => { gate = deferred(); return gate.promise }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] }))
  await tick(100)
  $('say').value = '帮我看看'
  $('send').fire('click'); await tick(50)
  assert.ok(gate); assert.equal(actCount(P), 1)
  P.es().emit('hello', snapshot({ viewer: otherViewer(), chat: [] }))
  await tick(50)
  gate.resolve(res({ ok: true, job: { id: 'j1', act: 'say', state: 'done', ok: true, out: '✓ IMPOSTOR-OUT' } }))
  await tick(100)
  assert.ok(!P.all().some((e) => e.textContent.includes('IMPOSTOR')) && !P.doc.title.includes('IMPOSTOR'), 'its answer is shown nowhere')
  assert.match($('say-st').textContent, REPLACED_RE); assert.ok(!$('say-st').classList.contains('ok'))
  assert.equal($('say').value, '帮我看看', 'not cleared'); assert.equal($('say').readOnly, false)
  assert.notEqual($('tab-chat').getAttribute('aria-selected'), 'true', 'not switched to the chat as if it went through')
  assert.equal(actCount(P), 1)
})

// ─────────────── 退回：服务器先回「在做」 ───────────────
test('window.js review sheet: a video reject answered as still running keeps the box (退回中…, its 退回 disabled, also across repaints); done but failed → box, reason and button back; done ok → closed, and stays closed on reopen / reload', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.on['/api/review'] = () => res({ videos: [CAT], channel: null })
  let gate = null
  P.net.on['/api/act'] = () => { gate = deferred(); return gate.promise }
  const snap = (n) => snapshot({ viewer: VW, chat: [], today: { ...snapshot().today, pendingVideos: n } })
  P.net.body = { ...snap(1), act: 'tok', jobs: [] }
  P.es().emit('hello', snap(1)); await tick(100)
  $('b-review').fire('click'); await tick(100)
  const sb = $('sheet-body')
  const boxes = () => byClass(sb, 'reject')
  const boxGo = () => buttonIn(boxes()[0], '退回')
  const note = () => byClass(sb, 'note')[0]
  buttonIn(sb, '退回').fire('click')
  textareaIn(sb).value = '画面太暗'; textareaIn(sb).fire('input')
  // 第一回：服务器开始做就推「在做」；15 秒到了先回「在做」；后来没退成
  boxGo().fire('click'); await tick(50)
  assert.ok(gate)
  const j7 = { id: 'j7', act: 'reject', label: '退回《猫》', state: 'running', ok: null, out: '' }
  P.es().emit('job', j7); await tick(50)
  assert.equal(textareaIn(sb)?.value, '画面太暗'); assert.equal(boxGo().disabled, true)
  gate.resolve(res({ ok: true, job: j7 })); await tick(50)
  assert.equal(boxes().length, 1, 'still running: the box stays')
  assert.equal(textareaIn(sb).value, '画面太暗')
  assert.equal(note().textContent, '退回中…')
  assert.equal(boxGo().disabled, true, 'cannot be pressed again while it runs')
  P.es().emit('job', j7); await tick(50)              // 又重画一次
  assert.equal(textareaIn(sb).value, '画面太暗'); assert.equal(boxGo().disabled, true)
  assert.match(note().textContent, /「退回《猫》」进行中/)
  P.es().emit('job', { ...j7, state: 'done', ok: false, out: '✗ 没退成：她的记录写不进去' }); await tick(100)
  assert.equal(boxes().length, 1, 'failed: the box stays'); assert.equal(textareaIn(sb).value, '画面太暗')
  assert.ok(!boxGo().disabled, 'and can be pressed again')
  assert.equal($('toast-h').textContent, '✗ 退回《猫》')
  // 第二回：在做 → 退成了 → 框关掉；关上面板再开、单子重读，都不再冒出来
  gate = null
  boxGo().fire('click'); await tick(50)
  assert.ok(gate)
  const j8 = { ...j7, id: 'j8' }
  P.es().emit('job', j8); await tick(50)
  gate.resolve(res({ ok: true, job: j8 })); await tick(50)
  assert.equal(boxes().length, 1); assert.equal(note().textContent, '退回中…')
  P.es().emit('job', { ...j8, state: 'done', ok: true, out: '✓ 退回了' }); await tick(100)
  assert.equal(boxes().length, 0, 'done: the box closes')
  $('sheet-x').fire('click'); $('b-review').fire('click'); await tick(100)
  assert.equal(boxes().length, 0, 'and stays closed after reopening the sheet')
  P.net.body = { ...P.net.body, ...snap(2) }
  P.es().emit('hello', snap(2)); await tick(100)
  assert.equal(boxes().length, 0, 'and after a reload')
  buttonIn(sb, '退回').fire('click')
  assert.equal(textareaIn(sb).value, '', 'its draft is gone too')
})

test('window.js review sheet: a channel-settings reject answered as still running keeps its box; once done ok the box stays closed on reload although the card (same sha) is still listed', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  const CH = { kind: 'submitted', state: 'waiting', sha: 'abcdef012345', text: '设定', at: iso(T0 - 3600_000) }
  P.net.on['/api/review'] = () => res({ videos: [], channel: CH })
  let gate = null
  P.net.on['/api/act'] = () => { gate = deferred(); return gate.promise }
  const snap = snapshot({ viewer: VW, chat: [], today: { ...snapshot().today, pendingVideos: 0, channelWaiting: true } })
  P.net.body = { ...snap, act: 'tok', jobs: [] }
  P.es().emit('hello', snap); await tick(100)
  assert.equal($('review-badge').textContent, '1')
  $('b-review').fire('click'); await tick(100)
  const sb = $('sheet-body')
  assert.equal(byClass(sb, 'card-h')[0].textContent, '她的频道设定')
  const boxes = () => byClass(sb, 'reject')
  const boxGo = () => buttonIn(boxes()[0], '退回')
  buttonIn(sb, '退回（写意见）').fire('click')
  textareaIn(sb).value = '语气再软一点'; textareaIn(sb).fire('input')
  boxGo().fire('click'); await tick(50)
  assert.deepEqual(lastActBody(P), { act: 'channel-reject', sha: CH.sha, text: '语气再软一点' })
  const j9 = { id: 'j9', act: 'channel-reject', label: '退回频道设定', state: 'running', ok: null, out: '' }
  P.es().emit('job', j9); await tick(50)
  gate.resolve(res({ ok: true, job: j9 })); await tick(50)
  assert.equal(boxes().length, 1, 'still running: the box stays'); assert.equal(textareaIn(sb).value, '语气再软一点')
  assert.equal(boxGo().disabled, true)
  assert.equal(byClass(sb, 'note')[0].textContent, '退回中…')
  assert.equal(buttonIn(sb, '确认这一版').disabled, true, 'one review at a time')
  P.es().emit('job', { ...j9, state: 'done', ok: true, out: '✓ 退回了，意见写进 channel-feedback.md' }); await tick(100)
  assert.equal(byClass(sb, 'card').length, 1, 'the same card (same sha) is still listed')
  assert.equal(boxes().length, 0, 'but its box is closed')
  $('sheet-x').fire('click'); $('b-review').fire('click'); await tick(100)
  assert.equal(boxes().length, 0, 'and stays closed after reopening')
  buttonIn(sb, '退回（写意见）').fire('click')
  assert.equal(textareaIn(sb).value, '', 'its draft is gone too')
})

test('window.js review sheet: a reject answered as still running BEFORE any job event (the stream was reconnecting) still counts as busy — 退回中, the box and the card buttons stay grey; the failed result then gives them back', async (t) => {
  const P = await page(t)
  const { $, tick } = P
  P.net.on['/api/review'] = () => res({ videos: [CAT], channel: null })
  let gate = null
  P.net.on['/api/act'] = () => { gate = deferred(); return gate.promise }
  P.net.body = { ...snapshot({ viewer: VW, chat: [] }), act: 'tok', jobs: [] }
  P.es().emit('hello', snapshot({ viewer: VW, chat: [] })); await tick(100)
  $('b-review').fire('click'); await tick(100)
  const sb = $('sheet-body')
  buttonIn(sb, '退回').fire('click')
  textareaIn(sb).value = '画面太暗'; textareaIn(sb).fire('input')
  const boxGo = () => buttonIn(byClass(sb, 'reject')[0], '退回')
  boxGo().fire('click'); await tick(50)
  const running = { id: 'j7', act: 'reject', label: '退回《猫》', state: 'running', ok: null, out: '' }
  gate.resolve(res({ ok: true, job: running })); await tick(50)
  assert.match(byClass(sb, 'note')[0].textContent, /退回中|进行中/)
  assert.equal(boxGo().disabled, true, 'the box cannot be sent twice while it runs')
  assert.equal(buttonIn(sb, '投稿').disabled, true); assert.equal(textareaIn(sb).value, '画面太暗')
  P.es().emit('job', { ...running, state: 'done', ok: false, out: '✗ 没退成', endedAt: iso(Date.now()) }); await tick(100)
  assert.equal(textareaIn(sb).value, '画面太暗'); assert.ok(!boxGo().disabled, 'the box can be sent again'); assert.ok(!buttonIn(sb, '投稿').disabled)
})
