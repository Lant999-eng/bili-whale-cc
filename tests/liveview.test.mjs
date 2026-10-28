// 「她的小窗」翻译层（host/liveview.mjs）：她会话记录的一行 → 白名单里的中文短事件。
// 用的是手写的假记录 tests/fixtures/transcript-synthetic.jsonl（形状照真记录：enqueue / 提示词 / 附件 / api-request / 每块一行的 assistant /
// tool_result + toolUseResult / cost-state …，内容全是假的），里面埋了「金丝雀」：主人的私信、私密日记、附件里的邮箱和组织号、
// 系统提示词、整段工具输出、图片 base64、完整路径、SESSDATA / auth_key / upsig / Cookie: —— 哪一只出现在输出里都算漏。
// 还测：字幕表每一行、调用和结果配对（晚到、乱序、结果比调用先到）、按 message.id 去重、回合头尾、状态 → 表情。
// 假记录的最后一段是主人 cli open 当面聊（没有 enqueue、宿主那边没有回合）：提示词里也埋了金丝雀，她帮主人搜的词只能出现在标了 private 的 text 里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator, captionFor, stateOf, whenText, pickExpr, kindOf, clean, redact, sanitizeEvent, EXPRS, EVENT_KINDS, GLYPHS, ACTIVITIES, MAX_LINE, VIEW_VERSION } from '../host/liveview.mjs'
import { shouldMask } from '../host/window-ui/player.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/transcript-synthetic.jsonl', import.meta.url))
const LINES = fs.readFileSync(FIXTURE, 'utf8').split('\n')
const DM_TURN = 'bili-whale-dm-r1', NIGHT_TURN = 'bili-whale-1792890601535'
const CHAT_TURN = 'chat-' + Date.parse('2026-10-24T16:40:00.000Z')   // 当面聊的假回合：id 取提示词那一行的时间
const CHAT_KW = '当面搜的词'
const T0 = Date.parse('2026-10-24T17:00:00Z')

/** 照服务端的用法喂一遍：每遇到 enqueue 换下一个回合 id（服务端是从 running.json 知道的） */
function replay({ titleOf = (bv) => (bv === 'BV1Inject001' ? '从看片记录来的标题' : null), clock = { t: T0 } } = {}) {
  const tr = createTranslator({ titleOf, now: () => clock.t })
  const ids = [DM_TURN, NIGHT_TURN]
  let k = -1
  const events = [], perLine = [], inflight = []
  for (const l of LINES) {
    try { const o = JSON.parse(l); if (o.type === 'queue-operation' && o.operation === 'enqueue') k += 1 } catch {}
    const evs = tr.feed(l, { turnId: ids[k] })
    events.push(...evs)
    perLine.push(evs)
    inflight.push(tr.inflight())
  }
  return { tr, events, perLine, inflight }
}
const lineIdx = (needle) => LINES.findIndex((l) => l.includes(needle))
const strings = (x, out = []) => {
  if (typeof x === 'string') out.push(x)
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out)
  return out
}

// ─────────────── 净化 ───────────────
test('clean：去掉控制 / 方向 / 零宽字符，空白并一个，截短不劈开代理对', () => {
  assert.equal(clean('a\u202eb\u2066c\u200bd\u200fe\ufefff\x07g\nh'), 'a b c' + 'def g h')
  assert.equal(clean('SES\u200bSDATA'), 'SESSDATA')          // 零宽字符拆不开凭据字样
  assert.equal(clean('x'.repeat(100)).length, 80)
  assert.ok(clean('x'.repeat(100)).endsWith('…'))
  const emoji = '😺'.repeat(50)                              // 每个占 2 个 UTF-16 单元
  const c = clean(emoji, 9)
  assert.ok(c.length <= 9 && !/[\ud800-\udbff]…$/.test(c), '不留半个代理对')
  assert.equal(clean(null), '')
  assert.equal(clean(undefined), '')
})

test('redact：各种凭据样子都抹掉，后面的中文不被吞', () => {
  const r = redact('SESSDATA=abc%2C123 bili_jct=deadbeef DedeUserID=42 DedeUserID__ckMd5=ff buvid3=XYZ-1 auth_key=1-2-3 upsig=aa deadline=99 access_token=t1 access_key=k1 refresh_token=r1 csrf=c1 w_rid=w1 sign=s1 key=k Bearer abc.def sk-ant-1234567890 Cookie: a=b; c=d')
  for (const v of ['abc%2C123', 'deadbeef', '=42', '=ff', 'XYZ-1', '1-2-3', 'upsig=aa', '=99', 't1', 'k1', 'r1', 'c1', 'w1', 's1', 'abc.def', 'ant-1234567890', 'a=b']) assert.ok(!r.includes(v), `${v} 没抹掉：${r}`)
  assert.equal(redact('《标题 upsig=abc》的字幕'), '《标题 upsig=***》的字幕')
  assert.equal(redact('https://x.bilivideo.com/a.m4s?deadline=1&upsig=ff&x=1'), 'https://x.bilivideo.com/a.m4s?deadline=***&upsig=***&x=1')
})

test('sanitizeEvent：只留认识的字段，≤80，路径只留文件名，去 base64，认得出凭据字样就整条丢', () => {
  const e = sanitizeEvent({ kind: 'tool_start', turn: 't1', t: '2026-10-24T16:00:00.000Z', cap: '在读 C:\\Users\\CANARYUSER\\.bili-whale\\notes.md', sub: 'See /Users/canary/x/y.txt and ~/.bili-ai/z.json', glyph: '读', activity: 'read',
    bv: 'BV1Cat000001', title: '标题'.repeat(30), ok: true, toolId: 'toolu_1', private: true, text: 'A'.repeat(70) + 'B'.repeat(30), extra: 'nope', seq: 9, steps: 3, tokens: -1, costUsd: NaN })
  assert.equal(e.cap, '在读 notes.md')
  assert.equal(e.sub, 'See y.txt and z.json')
  assert.equal(e.title.length, 40)
  assert.equal(e.text, '…')                                 // 100 个不带空格的字母 = 像 base64 → 抹掉
  assert.equal(e.extra, undefined); assert.equal(e.seq, undefined); assert.equal(e.tokens, undefined); assert.equal(e.costUsd, undefined)
  assert.equal(e.steps, 3); assert.equal(e.private, true)
  assert.equal(sanitizeEvent({ kind: 'note', cap: '网址不动 https://www.bilibili.com/video/BV1Cat000001/ 猫/狗/鸟' }).cap, '网址不动 https://www.bilibili.com/video/BV1Cat000001/ 猫/狗/鸟')
  for (const bad of ['Cookie: x', 'my token', 'SESSDATA=1', 'bili_jct', 'secret', 'password', 'api_key', 'API-KEY'])
    assert.equal(sanitizeEvent({ kind: 'said', cap: '她说', text: bad }), null, bad)
  assert.equal(sanitizeEvent({ kind: 'nope', cap: 'x' }), null)
  assert.equal(sanitizeEvent({ kind: 'note', cap: '' }), null)
  assert.equal(sanitizeEvent({ kind: 'note', cap: 'x', glyph: '说', activity: 'fly', bv: 'BV123', toolId: 'a b', t: 'yesterday', private: 'yes', ok: 'true' }).glyph, undefined)
  const w = sanitizeEvent({ kind: 'note', cap: 'x', glyph: '说', activity: 'fly', bv: 'BV123', toolId: 'a b', t: 'yesterday', private: 'yes', ok: 'true' })
  assert.deepEqual(w, { kind: 'note', turn: null, cap: 'x' })
})

// ─────────────── 整份假记录 ───────────────
test('金丝雀：私信 / 提示词 / 附件 / 私密日记 / 工具输出 / base64 / 路径 / 凭据，一只都不出现', () => {
  const { tr, events, inflight } = replay()
  const all = JSON.stringify({ events, inflight, recent: tr.recent(500), usage: tr.usage() })
  assert.ok(!/canary/i.test(all), '金丝雀漏了：' + (/.{0,40}canary.{0,40}/i.exec(all)?.[0] ?? ''))
  for (const s of ['主人说今晚想你了', 'example.com', '0badc0de', 'whale-diary-private', 'C:\\', '\\Users', '/Users', '/9j/', 'QUJDQUJD', '今天其实有点难过', '看到猫就好了', '频道设定全文', 'SESSDATA', 'bili_jct', 'Cookie', '[Image', '当面问', '没有结果'])
    assert.ok(!all.includes(s), `${s} 漏了`)
  // 给主人的话按约定是出得去的（标了 private，由页面决定遮不遮）
  assert.ok(all.includes('今晚也想你，早点睡呀') && all.includes('今晚看了猫坐地铁，好可爱'))
  // 她从主人的话里抄进命令参数的字：只在标了 private 的 text 里，cap / sub / 标题 / 进行中的小卡片里都没有
  for (const e of [...events, ...inflight.flat()]) for (const k of ['cap', 'sub', 'title']) assert.ok(!String(e[k] ?? '').includes(CHAT_KW), `${k} 里有主人的话：${e[k]}`)
  const kw = events.filter((e) => String(e.text ?? '').includes(CHAT_KW))
  assert.ok(kw.length > 0 && kw.every((e) => e.private === true && shouldMask(e, true)))
})

test('事件形状：种类 / 字段都在白名单里，每个字符串 ≤80，没有 seq，回合 id 对得上', () => {
  const { events } = replay()
  assert.ok(events.length > 40)
  const allowed = new Set(['kind', 'turn', 't', 'cap', 'sub', 'glyph', 'activity', 'bv', 'title', 'seen', 'ok', 'toolId', 'private', 'text', 'steps', 'tokens', 'costUsd', 'durationMs'])
  for (const e of events) {
    assert.ok(EVENT_KINDS.includes(e.kind))
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `多了字段 ${k}`)
    for (const s of strings(e)) assert.ok(s.length <= 80, s)
    if (e.title) assert.ok(e.title.length <= 40)
    if (e.glyph) assert.ok(GLYPHS.includes(e.glyph))
    if (e.activity) assert.ok(ACTIVITIES.includes(e.activity))
    if (e.t) assert.ok(Number.isFinite(Date.parse(e.t)))
    if ('seen' in e) assert.ok(e.seen === true && /^BV[0-9A-Za-z]{10}$/.test(e.bv), '「看了」只跟着 BV 走')
    assert.ok(e.turn === DM_TURN || e.turn === NIGHT_TURN || e.turn === CHAT_TURN, e.turn)
  }
  const kinds = new Set(events.map((e) => e.kind))
  for (const k of ['turn_start', 'thinking', 'tool_start', 'tool_end', 'said', 'retry', 'denied', 'turn_end']) assert.ok(kinds.has(k), k)
  assert.deepEqual(events.filter((e) => e.kind === 'turn_start').map((e) => [e.turn, e.cap]), [[DM_TURN, '你发来私信'], [NIGHT_TURN, '按作息醒来'], [CHAT_TURN, '你在和她当面聊']])
  // 当面聊没有回合尾（日志里没有它，不能闪「这回合做完了」）
  assert.equal(events.filter((e) => e.kind === 'turn_end').length, 2)
  assert.equal(events.find((e) => e.kind === 'retry').cap, '网络不太顺，重试中（1/10）')
  // 不认识的类型、坏 JSON、空行、附件、last-prompt、ai-title、api-request-blob/-shape、isMeta、file-history-*：一条都不出
  for (const needle of ['"type":"attachment"', '"type":"last-prompt"', '"type":"ai-title"', '"type":"api-request-blob"', '"type":"api-request-shape"', '"isMeta":true', '"type":"file-history-delta"', '"type":"file-history-snapshot"', '"type":"zz-future-record"', '"type":"atis-latch"', '"type":"mode"', '{not json'])
    for (let i = 0; i < LINES.length; i += 1) if (LINES[i].includes(needle)) assert.deepEqual(replay().perLine[i], [], needle)
})

test('配对：结果按 tool_use_id 对上调用 —— 乱序、晚到（隔着下一条回复）、结果先于调用都对', () => {
  const { events, inflight } = replay()
  const starts = new Map(), ends = new Map()
  events.forEach((e, i) => { if (e.kind === 'tool_start') starts.set(e.toolId, i); if (e.kind === 'tool_end' || e.kind === 'denied') { assert.ok(!ends.has(e.toolId), '一个调用只结束一次'); ends.set(e.toolId, i) } })
  // 带凭据字样的那条调用（说明里写了 cookie / SESSDATA）整条被丢掉了，只剩「被拦下了」
  assert.deepEqual([...ends.keys()].filter((id) => !starts.has(id)), ['toolu_hook'])
  for (const [id, i] of ends) if (starts.has(id)) assert.ok(starts.get(id) < i, id)
  assert.deepEqual([...starts.keys()].filter((id) => !ends.has(id)), ['toolu_bg'])   // 一直没等到结果的：回合结束时不再算进行中
  // 乱序：d2 的结果在 d1 前面
  const order = events.filter((e) => e.kind === 'tool_end').map((e) => e.toolId)
  assert.ok(order.indexOf('toolu_d2') < order.indexOf('toolu_d1'))
  // 进行中的列表一路跟着变
  const ids = (i) => inflight[i].map((x) => x.toolId)
  assert.deepEqual(ids(lineIdx('"id":"toolu_d4"')), ['toolu_d1', 'toolu_d2', 'toolu_d3', 'toolu_d4'])
  assert.deepEqual(ids(lineIdx('"tool_use_id":"toolu_d2"')), ['toolu_d1', 'toolu_d3', 'toolu_d4'])
  assert.deepEqual(ids(lineIdx('"tool_use_id":"toolu_d3"')), ['toolu_d4'])
  assert.deepEqual(ids(lineIdx('"id":"toolu_wv"')), ['toolu_d4', 'toolu_srch', 'toolu_wv'])        // 晚到的 d4 还挂着
  assert.deepEqual(ids(lineIdx('"tool_use_id":"toolu_d4"')), ['toolu_srch', 'toolu_wv'])
  // 开始事件被丢了，进行中的小卡片照样有（卡片不带英文说明，那句带凭据字样的说明出不去）
  const hook = inflight[lineIdx('"id":"toolu_hook"')].find((x) => x.toolId === 'toolu_hook')
  assert.deepEqual(Object.keys(hook).sort(), ['activity', 'cap', 'since', 'toolId'])
  assert.equal(hook.cap, '在跑一条命令')
  // 字幕本身就认得出凭据字样（读 cookies.txt）：卡片换成一句不带任何东西的
  const t2 = createTranslator({ now: () => T0 })
  assert.deepEqual(t2.feed(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tc', name: 'Read', input: { file_path: 'C:\\x\\cookies.txt' } }] } }), { turnId: 'manual-1' }).map((e) => e.kind), ['turn_start'])
  assert.deepEqual(t2.inflight().map((x) => [x.toolId, x.cap, x.activity]), [['tc', '在用工具', 'other']])
  assert.deepEqual(ids(lineIdx('"id":"toolu_bg"')), ['toolu_bg'])
  assert.deepEqual(inflight.at(-1), [])
  // 结果比调用先到：调用一到，开始和结束一起出
  const orph = replay().perLine[lineIdx('"id":"toolu_orph"')]
  assert.deepEqual(orph.map((e) => [e.kind, e.toolId, e.cap]), [['tool_start', 'toolu_orph', '在记一笔：今晚醒来的事'], ['tool_end', 'toolu_orph', '在记一笔：今晚醒来的事']])
  assert.deepEqual(replay().perLine[lineIdx('"tool_use_id":"toolu_orph"')], [])
  // 出错 / 被拦
  const d3 = events.find((e) => e.kind === 'tool_end' && e.toolId === 'toolu_d3')
  assert.deepEqual([d3.ok, d3.glyph, d3.sub], [false, '错', '出错了（退出码 2）'])
  assert.equal(events.filter((e) => e.kind === 'denied').length, 2)   // permissionDecision 和钩子的拒绝文字各一次
})

test('去重：同一行喂两遍不重复；同一 message.id 的几块只算一步、usage 只算一次；token 不算缓存重读', () => {
  const { events, perLine, tr } = replay()
  assert.deepEqual(perLine[lineIdx('"id":"toolu_d1"') + 4], [])        // 原样重复的那一行
  assert.equal(LINES[lineIdx('"id":"toolu_d1"') + 4], LINES[lineIdx('"id":"toolu_d1"')])
  assert.equal(events.filter((e) => e.kind === 'tool_start' && e.toolId === 'toolu_d1').length, 1)
  const ends = events.filter((e) => e.kind === 'turn_end')
  // 私信回合：3 次回复（msg_dm_1 有思考块 + 调用两行）；新 token = 输入 + 写缓存 + 输出：3+1000+50 + 2+200+40 + 2+100+20（缓存重读 5000/6000/6200 不算）
  assert.deepEqual([ends[0].steps, ends[0].tokens], [3, 1417])
  // 夜里那回合：15 次回复，每次 1+0+9（重读的 1000 不算；同一回复的 5 行、乱了时间的那一行都只算一次）
  assert.deepEqual([ends[1].steps, ends[1].tokens], [15, 150])
  // 最后那段当面聊另起一段计数：2 次回复
  assert.deepEqual(tr.usage(), { steps: 2, tokens: 20 })
  // 只有缓存重读的回复：0 个新 token
  const t0 = createTranslator({ now: () => T0 })
  t0.feed(JSON.stringify({ type: 'assistant', message: { id: 'r', content: [{ type: 'text', text: '嗯' }], stop_reason: 'tool_use', usage: { cache_read_input_tokens: 1_256_051 } } }), { turnId: 'manual-1' })
  assert.deepEqual(t0.usage(), { steps: 1, tokens: 0 })
  // 「在想」连着两条只出一条；同一回复里同样的话不重复
  const t2 = createTranslator({ now: () => T0 })
  const req = (q = 'sdk') => JSON.stringify({ type: 'api-request', timestamp: '2026-10-24T16:00:00.000Z', querySource: q })
  assert.equal(t2.feed(req()).length, 1); assert.equal(t2.feed(req()).length, 0)
  const said = JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '嗯' }], stop_reason: 'tool_use' } })
  assert.equal(t2.feed(said).length, 1); assert.equal(t2.feed(said).length, 0)
  assert.equal(t2.feed(req()).length, 1)
  const t3 = createTranslator({ now: () => T0 })
  assert.equal(t3.feed(req('generate_session_title')).length, 0, '旁路请求不算在想')
  // 没有别的键可去重的行（重试）：同一个 uuid 来两遍只算一次
  const retry = LINES[lineIdx('"subtype":"api_error"')]
  assert.equal(t3.feed(retry, { turnId: 'manual-1' }).filter((e) => e.kind === 'retry').length, 1)
  assert.deepEqual(t3.feed(retry, { turnId: 'manual-1' }), [])
})

test('标题：feed / search / debrief 标题 / watched / comments 抠出来，没有就问 titleOf，再没有用 BV，知道了以后换上', () => {
  const { events } = replay()
  const ev = (id, kind = 'tool_start') => events.find((e) => e.kind === kind && e.toolId === id)
  assert.equal(ev('toolu_d1').cap, '在看《猫坐地铁的一天》')                                      // feed 来的
  assert.equal(ev('toolu_d2').title, '反转 标题 auth_key=***&upsig=***')                          // 方向字符去掉、凭据抹掉
  assert.equal(ev('toolu_d2').cap, '在读《反转 标题 auth_key=***&upsig=***》的字幕和评论')
  assert.equal(ev('toolu_wv').cap, '在抽帧看《从看片记录来的标题》')                                // titleOf（看片记录）
  assert.equal(ev('toolu_d4').cap, '在看 BV1Late00004')                                            // 都没有：光秃秃的 BV
  assert.equal(ev('toolu_d4', 'tool_end').cap, '看完了《晚到的标题》（字幕✗ 画面✗）')               // debrief 的「标题:」到了就换上
  assert.equal(ev('toolu_d1', 'tool_end').cap, '看完了《猫坐地铁的一天》（字幕✓ 画面✓）')
  assert.equal(ev('toolu_d2', 'tool_end').cap, '读完了《反转 标题 auth_key=***》（字幕✓）')
  assert.equal(ev('toolu_feed', 'tool_end').cap, '挑了 3 条候选')
  assert.equal(ev('toolu_srch', 'tool_end').cap, '搜到 1 条')
  assert.equal(ev('toolu_cov').cap, '在看《猫坐地铁的一天》的封面')
  assert.equal(ev('toolu_cov2').cap, '在看 BV1Cook00003 的封面')                                    // 标题带 cookie 字样：不用，免得整条被丢

  // watched show / list、comments、search 进缓存；titleOf 查不到的 5 秒内不再问
  const clock = { t: T0 }
  let asked = 0
  const tr = createTranslator({ titleOf: (bv) => { asked += 1; if (bv === 'BV1Thr000011') throw new Error('boom'); return bv === 'BV1Tok000012' ? 'token 经济学' : null }, now: () => clock.t })
  const use = (id, command) => JSON.stringify({ type: 'assistant', uuid: 'u-' + id, message: { id: 'm-' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } })
  const res = (id, content) => JSON.stringify({ type: 'user', uuid: 'r-' + id, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } })
  tr.feed(use('w1', 'node bili.mjs watched show BV1Wat000007')); tr.feed(res('w1', 'BV1Wat000007 《看过的标题》 · UP 某人 · 95 秒\n素材：…'))
  tr.feed(use('w2', 'node bili.mjs watched list')); tr.feed(res('w2', '最近 1 天看过 1 条：\n  · 2026-10-24 10:00 BV1Lst000009 《列表标题》 范围：全片'))
  tr.feed(use('c1', 'node bili.mjs comments BV1Com000008')); tr.feed(res('c1', '评论「评论区标题」\nBV=BV1Com000008  aid=1  总评论≈3'))
  assert.equal(tr.feed(use('x1', 'node bili.mjs debrief BV1Wat000007'))[0].title, '看过的标题')
  assert.equal(tr.feed(use('x2', 'node bili.mjs subtitles BV1Lst000009'))[0].cap, '在读《列表标题》的字幕')
  assert.equal(tr.feed(use('x3', 'node bili.mjs video BV1Com000008'))[0].cap, '在了解《评论区标题》讲什么')
  assert.equal(tr.feed(use('x4', 'node bili.mjs debrief BV1Thr000011'))[0].cap, '在看 BV1Thr000011')   // titleOf 抛错也不炸
  assert.equal(tr.feed(use('x5', 'node bili.mjs debrief BV1Tok000012'))[0].cap, '在看 BV1Tok000012')   // 带凭据字样的标题不用
  const n = asked
  for (let i = 0; i < 5; i += 1) tr.inflight()
  assert.equal(asked, n, '5 秒内不再问')
  clock.t += 6000
  tr.inflight()
  assert.ok(asked > n, '过了 5 秒再问')
  // 后来知道标题：还挂着的调用跟着换
  assert.equal(tr.inflight().find((x) => x.toolId === 'x4').cap, '在看 BV1Thr000011')
  tr.feed(use('w3', 'node bili.mjs watched show BV1Thr000011')); tr.feed(res('w3', 'BV1Thr000011 《后来知道的》'))
  assert.deepEqual(tr.inflight().find((x) => x.toolId === 'x4'), { toolId: 'x4', cap: '在看《后来知道的》', bv: 'BV1Thr000011', title: '后来知道的', since: tr.inflight().find((x) => x.toolId === 'x4').since, activity: 'watch' })
})

test('私话：私信回合 / 一回合最后那句 / 不是宿主回合说的、dm 和 notify 的正文都标 private；私密日记只有那一句', () => {
  const { events } = replay()
  const said = events.filter((e) => e.kind === 'said')
  assert.deepEqual(said.map((e) => [e.text, e.private === true]), [
    ['收到啦，我这就回你', true], ['回好啦，晚安', true],                   // 私信回合
    ['先看看这几条', false],                                                   // 回合中间的自言自语
    ['顺手记一下 DedeUserID=*** buvid=*** Bearer *** sk-***', false],
    ['今晚就到这里啦，晚安', true],                                            // end_turn
    ['没搜到呀，换个词试试？', true],                                          // 当面聊
  ])
  // 当面聊里她帮主人搜：cap 是固定说法，主人的词在 text 里、标 private
  const cs = events.find((e) => e.toolId === 'toolu_chat_srch' && e.kind === 'tool_start')
  assert.deepEqual([cs.turn, cs.cap, cs.text, cs.private], [CHAT_TURN, '在搜视频', CHAT_KW, true])
  // 夜里那回合（不是主人起的）她自己搜的词：照样只在 text 里，不标 private
  const ns = events.find((e) => e.toolId === 'toolu_srch' && e.kind === 'tool_start')
  assert.deepEqual([ns.cap, ns.text, ns.private], ['在搜视频', '猫 地铁', undefined])
  const dm = events.find((e) => e.toolId === 'toolu_dm_send' && e.kind === 'tool_start')
  assert.deepEqual([dm.cap, dm.text, dm.private], ['在回你的私信', '今晚也想你，早点睡呀', true])
  const nt = events.find((e) => e.toolId === 'toolu_nt' && e.kind === 'tool_start')
  assert.deepEqual([nt.cap, nt.text, nt.private], ['在给你报备', '今晚看了猫坐地铁，好可爱', true])
  assert.ok(!events.some((e) => e.kind === 'tool_end' && e.text), '结束事件不再带正文')
  const cmt = events.find((e) => e.toolId === 'toolu_cmt' && e.kind === 'tool_start')
  assert.deepEqual([cmt.text, cmt.private], ['这只猫太会坐地铁了 auth_key=***', undefined])   // 公开评论：带前 40 字，不算私话
  for (const id of ['toolu_pr', 'toolu_pe']) for (const e of events.filter((x) => x.toolId === id)) {
    assert.deepEqual(Object.keys(e).sort(), ['activity', 'cap', 'glyph', 'kind', 'ok', 't', 'toolId', 'turn'].filter((k) => k !== 'ok' || e.kind === 'tool_end').sort())
    assert.equal(e.cap, id === 'toolu_pr' ? '在翻只给自己看的日记' : '在写只给自己看的日记')
  }
  assert.equal(events.find((e) => e.toolId === 'toolu_de').cap, '在写日记')
  assert.equal(events.find((e) => e.toolId === 'toolu_ch').cap, '在写频道设定')
  // Cookie 那句：整条丢掉
  assert.ok(!said.some((e) => /Cookie|SESSDATA/.test(e.text)))
})

test('回合尾：花费 = 这一回合的（会话累计相减；会话第一回合 = 累计本身），时长有累计用累计、没有用时间戳', () => {
  const { events } = replay()
  const [a, b] = events.filter((e) => e.kind === 'turn_end')
  assert.deepEqual([a.turn, a.ok, a.costUsd, a.cap], [DM_TURN, true, 0.126, '这回合做完了'])
  const ts = LINES.map((l) => { try { return JSON.parse(l).timestamp } catch { return undefined } })
  const first = Date.parse(ts[0]), lastBeforeCost = Date.parse(ts.slice(0, lineIdx('"totalCostUSD":0.126')).filter(Boolean).at(-1))
  assert.equal(a.durationMs, lastBeforeCost - first)
  assert.deepEqual([b.turn, b.costUsd, b.durationMs], [NIGHT_TURN, 0.6879, 181079 - 23203])
  // 不知道上一回合、也不是会话第一回合：不报花费（宁可空着也不报会话累计）
  const tr = createTranslator({ now: () => T0 })
  tr.feed(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-24T16:00:00.000Z' }), { turnId: 'manual-1' })
  tr.feed(JSON.stringify({ type: 'user', uuid: 'p', message: { content: 'x' }, turnPosition: { turnIndex: 4 } }), { turnId: 'manual-1' })
  const [e] = tr.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 2.6213 }), { turnId: 'manual-1' })
  assert.deepEqual([e.kind, e.costUsd, e.ok], ['turn_end', undefined, undefined])
  assert.deepEqual(tr.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 2.8 }), { turnId: 'manual-1' }), [], '一个回合只结束一次')
})

test('回合头尾：running.json 先到不重复；结束过的 id 当旧提示；cli open 当面聊不起回合头、话都算私话；logs 补的回合尾只出一次', () => {
  const clock = { t: T0 }
  const tr = createTranslator({ now: () => clock.t })
  const enq = (ts) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: 'CANARY' })
  const say = (id, text, stop = 'tool_use') => JSON.stringify({ type: 'assistant', uuid: 'u' + id, timestamp: '2026-10-24T16:00:05.000Z', message: { id, content: [{ type: 'text', text }], stop_reason: stop, usage: { output_tokens: 7 } } })
  const s1 = tr.turnStart({ id: 'bili-whale-dm-a', at: T0 - 1000 })
  assert.deepEqual(s1.map((e) => [e.kind, e.turn, e.cap, e.t]), [['turn_start', 'bili-whale-dm-a', '你发来私信', new Date(T0 - 1000).toISOString()]])
  assert.deepEqual(tr.turnStart({ id: 'bili-whale-dm-a', at: T0 }), [])
  assert.deepEqual(tr.feed(enq('2026-10-24T16:00:01.000Z'), { turnId: 'bili-whale-dm-a' }), [])     // enqueue 晚到：不再出回合头
  tr.feed(say('m1', '好'), { turnId: 'bili-whale-dm-a' })
  assert.deepEqual(tr.usage(), { steps: 1, tokens: 7 })
  const end = tr.turnEnd({ id: 'bili-whale-dm-a', ok: false, costUsd: 0.05, durationMs: 1200, at: T0 })
  assert.deepEqual(end.map((e) => [e.kind, e.ok, e.cap, e.steps, e.tokens, e.costUsd, e.durationMs]), [['turn_end', false, '这回合没做完', 1, 7, 0.05, 1200]])
  assert.deepEqual(tr.turnEnd({ id: 'bili-whale-dm-a', ok: true }), [])
  assert.deepEqual(tr.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }), { turnId: 'bili-whale-dm-a' }), [])
  // 结束过的 id 又当提示传进来（服务端还没读到新的 running.json）：新的一段先不认主，话按私话算
  assert.deepEqual(tr.feed(enq('2026-10-24T16:10:00.000Z'), { turnId: 'bili-whale-dm-a' }), [])
  const [x] = tr.feed(say('m2', '这句是谁的回合？'), { turnId: 'bili-whale-dm-a' })
  assert.deepEqual([x.turn, x.private], [null, true])
  // 下一行带上新 id：认下它，补回合头；计数没清（清零只看 enqueue）
  const y = tr.feed(say('m3', '在看视频'), { turnId: 'bili-whale-1792890000000' })
  assert.deepEqual(y.map((e) => [e.kind, e.turn]), [['turn_start', 'bili-whale-1792890000000'], ['said', 'bili-whale-1792890000000']])
  assert.equal(tr.usage().steps, 2)
  // 别的回合还挂着时 running.json 换了：回合头带新 id，眼下这一段不动
  const z = tr.turnStart({ id: 'manual-9', at: T0 })
  assert.deepEqual(z.map((e) => e.turn), ['manual-9'])
  assert.equal(tr.usage().steps, 2)
  // 没见过记录的回合由 logs 补尾：不知道步数和 token 就不报
  const far = tr.turnEnd({ id: 'bili-whale-listen-5', ok: true, costUsd: 0.2 })
  assert.deepEqual([far[0].turn, far[0].steps, far[0].tokens, far[0].costUsd], ['bili-whale-listen-5', undefined, undefined, 0.2])
  // cli open：没有回合 id 的 enqueue → 不起回合头，说的都是私话，cost-state 不出回合尾
  const t2 = createTranslator({ now: () => T0 })
  assert.deepEqual(t2.feed(enq('2026-10-24T16:20:00.000Z')), [])
  assert.equal(t2.feed(say('m4', '主人你好呀'))[0].private, true)
  assert.deepEqual(t2.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 3 })), [])
  // reset：从头再来，去重和回合头都清掉
  const { tr: t3 } = replay()
  t3.reset()
  const again = []
  let k = -1
  for (const l of LINES) { if (l.includes('"operation":"enqueue"')) k += 1; again.push(...t3.feed(l, { turnId: [DM_TURN, NIGHT_TURN][k] })) }
  assert.equal(again.filter((e) => e.kind === 'turn_start').length, 3)
  assert.equal(again.filter((e) => e.kind === 'turn_end').length, 2)
})

test('当面聊：宿主没回合时主人的提示词起一个假回合，不挂到做完的回合底下；同一场接着聊不另起；宿主回合来了就换过去', () => {
  const clock = { t: T0 }
  const tr = createTranslator({ now: () => clock.t })
  let n = 0
  const ts = (s) => new Date(T0 + s * 1000).toISOString()
  const prompt = (s, more = {}) => JSON.stringify({ type: 'user', uuid: 'p' + (n += 1), timestamp: ts(s), message: { role: 'user', content: 'CANARY 主人当面说的话' }, ...more })
  const say = (s, text, stop = 'end_turn') => JSON.stringify({ type: 'assistant', uuid: 'a' + (n += 1), timestamp: ts(s), message: { id: 'm' + n, content: [{ type: 'text', text }], stop_reason: stop, usage: { output_tokens: 3 } } })
  const use = (s, id, command) => JSON.stringify({ type: 'assistant', uuid: 'a' + (n += 1), timestamp: ts(s), message: { id: 'm' + n, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'List the folder' } }], stop_reason: 'tool_use' } })
  const enq = (s) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(s), content: 'CANARY' })
  // 一个夜里的回合，做完了
  tr.feed(enq(0), { turnId: 'bili-whale-1' }); tr.feed(say(1, '看视频', 'tool_use'), { turnId: 'bili-whale-1' })
  assert.equal(tr.turnEnd({ id: 'bili-whale-1', ok: true, at: ts(2) })[0].kind, 'turn_end')
  // 主人 cli open：没有 enqueue，服务端给的提示 id 是刚结束的那个（还没读到新的 running.json）→ 当成没有
  const a = tr.feed(prompt(60), { turnId: 'bili-whale-1' })
  const chat = 'chat-' + (T0 + 60_000)
  assert.deepEqual(a.map((e) => [e.kind, e.turn, e.cap]), [['turn_start', chat, '你在和她当面聊']])
  assert.deepEqual(kindOf(chat), { kind: 'chat', kindLabel: '你在和她当面聊' })
  const b = tr.feed(use(61, 'c1', 'node bili.mjs diary log 主人的私事 --note x'))
  assert.deepEqual([b[0].turn, b[0].cap, b[0].text, b[0].private], [chat, '在记一笔', '主人的私事', true])
  const c = tr.feed(use(62, 'c2', 'node bili.mjs studio new --format diary --title "主人起的名字"'))
  assert.deepEqual([c[0].cap, c[0].text, c[0].private], ['开了新作品', '主人起的名字', true])
  const d = tr.feed(use(63, 'c3', 'dir'))          // 不是 bili.mjs：英文说明也算主人那边的话 → text + private，不当小字
  assert.deepEqual([d[0].cap, d[0].sub, d[0].text, d[0].private], ['在跑一条命令', undefined, 'List the folder', true])
  assert.ok(tr.inflight().every((x) => !/主人|CANARY/.test(x.cap)))
  const s1 = tr.feed(say(64, '好呀', 'tool_use'))
  assert.deepEqual([s1[0].turn, s1[0].private], [chat, true], '当面聊里说的都是对主人说的')
  assert.deepEqual(tr.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 1 })), [], '当面聊不出回合尾')
  // 接着聊（还排了一次队）：同一场，不另起
  assert.deepEqual(tr.feed(enq(70)), [])
  assert.deepEqual(tr.feed(prompt(71)), [])
  assert.equal(tr.feed(say(72, '嗯嗯'))[0].turn, chat)
  // 隔了半小时以上又开口：新的一场
  const e = tr.feed(prompt(72 + 31 * 60))
  assert.deepEqual(e.map((x) => [x.kind, x.turn]), [['turn_start', 'chat-' + (T0 + (72 + 31 * 60) * 1000)]])
  // SDK 发的提示词（宿主的）、回合进行中的非 SDK 文字行：都不起聊天
  const t2 = createTranslator({ now: () => T0 })
  assert.deepEqual(t2.feed(prompt(0, { promptSource: 'sdk' })), [])
  t2.feed(enq(1), { turnId: 'bili-whale-2' }); t2.feed(say(2, '在看', 'tool_use'), { turnId: 'bili-whale-2' })
  assert.deepEqual(t2.feed(prompt(3), { turnId: 'bili-whale-2' }), [], '提示 id 还在：是宿主的回合')
  assert.deepEqual(t2.feed(prompt(4)), [], '回合没结束：压缩摘要之类，不拦腰截断')
  assert.equal(t2.feed(say(5, '继续', 'tool_use'))[0].turn, 'bili-whale-2')
  // 中断提示不算提示词
  const t3 = createTranslator({ now: () => T0 })
  assert.deepEqual(t3.feed(JSON.stringify({ type: 'user', uuid: 'i', timestamp: ts(0), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })), [])
  assert.equal(t3.feed(JSON.stringify({ type: 'user', uuid: 'j', timestamp: ts(1), message: { content: [{ type: 'text', text: 'CANARY 带图的提示' }, { type: 'image', source: { data: 'QUJD' } }] } }))[0].cap, '你在和她当面聊')
  // 聊着聊着宿主回合来了（running.json 先到）：换成宿主的回合，聊天的计数不带过去
  const h = tr.feed(say(9999, '我醒啦', 'tool_use'), { turnId: 'bili-whale-dm-9' })
  assert.deepEqual(h.map((x) => [x.kind, x.turn]), [['turn_start', 'bili-whale-dm-9'], ['said', 'bili-whale-dm-9']])
  assert.deepEqual(tr.usage(), { steps: 1, tokens: 3 })
  assert.ok(!/CANARY/.test(JSON.stringify(tr.recent(500))), '提示词 / 说明一个字都不出')
})

test('金丝雀：私信回合里她照搬主人的话当搜索词 / 作品名 / 日记种类 —— 不进 cap、不进进行中的小卡片、不进 stateOf 的字幕（桌宠念的就是它）', () => {
  const tr = createTranslator({ now: () => T0 })
  const id = 'bili-whale-dm-kw'
  const line = (o) => JSON.stringify({ uuid: 'u' + Math.random(), timestamp: new Date(T0 - 5000).toISOString(), ...o })
  const use = (tid, command) => line({ type: 'assistant', message: { id: 'm-' + tid, content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command, description: 'OWNERKW in desc' } }], stop_reason: 'tool_use' } })
  tr.turnStart({ id, at: T0 - 10_000 })
  tr.feed(line({ type: 'queue-operation', operation: 'enqueue', content: '帮我搜一下 OWNERKW秘密词' }), { turnId: id })
  tr.feed(line({ type: 'user', promptSource: 'sdk', message: { content: '[主人私信] 帮我搜一下 OWNERKW秘密词' } }), { turnId: id })
  const evs = [
    ...tr.feed(use('k1', 'node bili.mjs search "OWNERKW秘密词"'), { turnId: id }),
    ...tr.feed(use('k2', 'node bili.mjs studio new --title "OWNERKW的作品"'), { turnId: id }),
    ...tr.feed(use('k3', 'node bili.mjs diary log OWNERKW私事'), { turnId: id }),
    ...tr.feed(use('k4', 'type OWNERKW.txt'), { turnId: id }),
  ]
  assert.deepEqual(evs.map((e) => e.cap), ['在搜视频', '开了新作品', '在记一笔', '在跑一条命令'])
  for (const e of evs) {
    assert.ok(!/OWNERKW/.test(e.cap) && !/OWNERKW/.test(e.sub ?? '') && !/OWNERKW/.test(e.title ?? ''), JSON.stringify(e))
    assert.ok(/OWNERKW/.test(e.text) && e.private === true && shouldMask(e, true), '原话在 text 里、标 private、「遮住私话」遮得住')
  }
  assert.ok(tr.inflight().length === 4 && tr.inflight().every((x) => !/OWNERKW/.test(JSON.stringify(x))))
  for (const k of [1, 2, 3, 4]) {
    const st = stateOf({ now: T0 + 20_000 * k, host: { state: 'online' }, turn: { id, at: T0 - 10_000 }, inflight: tr.inflight().slice(0, k), recent: tr.recent() })
    assert.ok(!/OWNERKW/.test(st.caption), st.caption)
  }
})

test('settle：开机重放出来的事件按它们自己的时间算「多久以前」，不再像刚刚发生的', () => {
  const clock = { t: T0 }
  const tr = createTranslator({ now: () => clock.t })
  const turn = { id: 'bili-whale-7', at: new Date(T0 - 600_000).toISOString() }
  tr.turnStart({ id: turn.id, at: T0 - 600_000 })
  tr.feed(JSON.stringify({ type: 'system', subtype: 'api_error', uuid: 'e1', timestamp: new Date(T0 - 540_000).toISOString(), retryAttempt: 1, maxRetries: 10 }), { turnId: turn.id })
  tr.feed(JSON.stringify({ type: 'assistant', uuid: 's1', timestamp: new Date(T0 - 530_000).toISOString(), message: { id: 'm', content: [{ type: 'text', text: '好的' }], stop_reason: 'tool_use' } }), { turnId: turn.id })
  const S = () => { const r = stateOf({ now: clock.t, host: { state: 'online' }, turn, recent: tr.recent() }); return [r.state, r.expr, r.talking] }
  assert.deepEqual(S(), ['retry', '别扭', false], '没 settle：9 分钟前的重试像是刚发生的')
  tr.settle()
  assert.ok(tr.recent().every((e) => e.rx === Date.parse(e.t)))
  assert.deepEqual(S(), ['thinking', '想事情', false])
  // settle 以后新读到的照样按收到的时刻算
  tr.feed(JSON.stringify({ type: 'assistant', uuid: 's2', timestamp: new Date(T0 - 20_000).toISOString(), message: { id: 'm2', content: [{ type: 'text', text: '这句是刚读到的' }], stop_reason: 'tool_use' } }), { turnId: turn.id })
  assert.deepEqual(S(), ['replying', '浅笑', true])
})

test('不炸：坏行、超长行、不认识的类型、字段类型乱七八糟 → []，出来的照样干净', () => {
  const tr = createTranslator({ now: () => T0, titleOf: () => { throw new Error('x') } })
  for (const bad of [null, undefined, 42, {}, [], '', '   ', 'null', '[]', '"str"', '{', '{"type":"assistant"}', '{"type":"assistant","message":{"content":"str"}}',
    '{"type":"user","message":{"content":[null,1,{"type":"tool_result"}]}}', '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":null}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":7,"name":{},"input":[]}]}}', '{"type":"cost-state","totalCostUSD":"1"}', '{"type":"system","subtype":"api_error"}',
    '{"type":"queue-operation","operation":"enqueue","timestamp":{}}', '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"zz","content":{"a":1},"is_error":"yes"}]}}'])
    assert.doesNotThrow(() => tr.feed(bad, { turnId: 'manual-1' }))
  assert.deepEqual(tr.feed('{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"' + 'a'.repeat(MAX_LINE) + '"}]}}'), [])
  // 把假记录每一行的每个字段（两层以内）换成各种怪东西喂进去
  const weird = [null, 0, -1, '', [], {}, 'x'.repeat(10), true]
  const t2 = createTranslator({ now: () => T0 })
  let out = []
  const mutate = (o, depth, fn) => { if (!o || typeof o !== 'object' || depth > 2) return; for (const k of Object.keys(o)) { const keep = o[k]; for (const w of weird) { o[k] = w; fn() } o[k] = keep; mutate(keep, depth + 1, fn) } }
  for (const l of LINES) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    mutate(o, 0, () => { out.push(...t2.feed(JSON.stringify({ ...o, uuid: undefined }), { turnId: 'manual-2' })); t2.inflight(); t2.usage() })
  }
  assert.ok(out.length > 0)
  for (const e of out) { assert.ok(EVENT_KINDS.includes(e.kind)); for (const s of strings(e)) assert.ok(s.length <= 80) }
  assert.ok(!/canary/i.test(JSON.stringify(out)), '乱改字段也不漏')
  // Claude Code 自己补的接口错误消息：不是她说的话
  const t3 = createTranslator({ now: () => T0 })
  const evs = t3.feed(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { id: 'e', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } }), { turnId: 'manual-3' })
  assert.deepEqual(evs.map((e) => [e.kind, e.cap, e.glyph]), [['turn_start', '你叫醒了她', undefined], ['note', '模型接口出错了', '错']])
  assert.equal(t3.usage().steps, 0, '补的错误消息不算她回了一次')
})

test('作品：studio new 记下 id → 标题，render 用上；studio() 给出这一回合碰过的作品', () => {
  const tr = createTranslator({ now: () => T0 })
  const use = (id, input, name = 'Bash') => JSON.stringify({ type: 'assistant', uuid: 'u-' + id, message: { id: 'm-' + id, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } })
  const res = (id, content) => JSON.stringify({ type: 'user', uuid: 'r-' + id, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  // 作品名是她自己起的（可能照搬主人的话）：不进 cap（桌宠也念 cap），放 text
  const [n] = tr.feed(use('s1', { command: 'node bili.mjs studio new --format diary --title "猫的一天"' }))
  assert.deepEqual([n.cap, n.text, n.private], ['开了新作品', '猫的一天', true])        // 还没认出是谁的回合：按主人的算
  tr.feed(res('s1', '✓ 新作品 202610242210-mao （diary）\n  稿子：C:\\Users\\CANARYUSER\\.bili-whale\\studio\\202610242210-mao\\script.json'))
  assert.equal(tr.studio(), '202610242210-mao')
  assert.equal(tr.feed(use('s2', { file_path: 'C:\\Users\\x\\.bili-whale\\studio\\202610242210-mao\\script.json', content: '{}' }, 'Write'))[0].cap, '在写剧本')
  const [r] = tr.feed(use('s3', { command: 'node bili.mjs studio render 202610242210-mao' }), { turnId: 'bili-whale-1792890000000' }).filter((e) => e.kind === 'tool_start')
  assert.deepEqual([r.cap, r.sub, r.activity, r.text, r.private], ['在做视频', '做视频要几分钟', 'make', '猫的一天', undefined])
  const [s] = tr.feed(use('s4', { command: 'node bili.mjs studio submit 202610242210-mao --reason "很可爱的一条"' }))
  assert.deepEqual([s.cap, s.text], ['把作品交给你审', '猫的一天'])
  tr.feed(use('s5', { command: 'node bili.mjs studio check 202610242299-other' }))
  assert.equal(tr.studio(), '202610242299-other')
})

// ─────────────── 字幕表 ───────────────
test('字幕表：node bili.mjs 的每个子命令和开关', () => {
  const T = (bv) => ({ BV1Cat000001: '猫' }[bv] ?? null)
  const c = (cmd, ctx = { titleOf: T }) => captionFor('Bash', { command: cmd, description: 'some English' }, ctx)
  const rows = [
    ['node bili.mjs feed --n 6', '在挑今天看什么', '找', 'search'],
    ['node bili.mjs search "猫 地铁"', '在搜视频', '找', 'search'],
    ['node bili.mjs debrief BV1Cat000001', '在看《猫》', '看', 'watch'],
    ['node bili.mjs debrief BV1Dog000002', '在看 BV1Dog000002', '看', 'watch'],
    ['node bili.mjs debrief BV1Cat000001 --no-frames', '在读《猫》的字幕和评论', '读', 'read'],
    ['node bili.mjs debrief --no-frames BV1Cat000001', '在读《猫》的字幕和评论', '读', 'read'],
    ['node bili.mjs watch-video BV1Cat000001 3x3', '在抽帧看《猫》', '看', 'watch'],
    ['node bili.mjs subtitles BV1Cat000001', '在读《猫》的字幕', '读', 'read'],
    ['node bili.mjs video BV1Cat000001', '在了解《猫》讲什么', '读', 'read'],
    ['node bili.mjs comments BV1Cat000001 --sort hot', '在翻《猫》的评论区', '读', 'read'],
    ['node bili.mjs watched show BV1Cat000001', '在回想《猫》', '想', 'think'],
    ['node bili.mjs watched note BV1Cat000001 --text "看懂了"', '在记下对《猫》的理解', '记', 'write'],
    ['node bili.mjs watched list --days 1', '在翻看片记录', '读', 'read'],
    ['node bili.mjs comment-digest --hours 24', '在看今天谁找过她', '读', 'read'],
    ['node bili.mjs comment-images --oid 1 --rpid 2', '在看评论里附的图', '看', 'watch'],
    ['node bili.mjs thread 1 BV1Cat000001 3', '在核对刚发的东西', '读', 'read'],
    ['node bili.mjs check-comment 1', '在核对刚发的东西', '读', 'read'],
    ['node bili.mjs check-dynamic 1', '在核对刚发的东西', '读', 'read'],
    ['node bili.mjs check-mention 1 2 名字', '在核对刚发的东西', '读', 'read'],
    ['node bili.mjs recon BV1Cat000001', '发评论前在看评论区', '读', 'read'],
    ['node bili.mjs likes --hours 24', '在看谁赞了她', '读', 'read'],
    ['node bili.mjs comment --oid 1 --bvid BV1Cat000001 --message "好" --dry', '在打评论草稿', '写', 'write'],
    ['node bili.mjs comment --oid 1 --bvid BV1Cat000001 --message "好看" --go', '在评论《猫》', '发', 'send'],
    ['node bili.mjs comment --oid 1 --root 456 --parent 789 --message "谢谢" --go', '在回复评论', '发', 'send'],
    ['node bili.mjs comment --oid 1 --root 456 --message "谢谢" --dry', '在打回复草稿', '写', 'write'],
    ['node bili.mjs comment --oid 1 --type 11 --message "好看" --go', '在评论动态', '发', 'send'],
    ['node bili.mjs comment --oid 1 --type 17 --message "好看" --go', '在评论动态', '发', 'send'],
    ['node bili.mjs reply-draft add --oid 1 --bvid BV1Cat000001 --root 2 --message "嗯"', '写了条回复等你审', '写', 'send'],
    ['node bili.mjs reply-draft list', '在看待审的回复', '读', 'read'],
    ['node bili.mjs reply-draft drop r1', '撤回了一条待审回复', '写', 'other'],
    ['node bili.mjs comment-del --rpid 1 --go', '在删自己的评论', '发', 'send'],
    ['node bili.mjs comment-del --rpid 1 --dry', '在打删评论的草稿', '写', 'write'],
    ['node bili.mjs fav BV1Cat000001 --reason "想留着" --go', '收藏了《猫》', '记', 'other'],
    ['node bili.mjs fav BV1Cat000001 --reason "想留着" --dry', '想收藏《猫》', '想', 'think'],
    ['node bili.mjs fav --list', '在翻收藏夹', '读', 'read'],
    ['node bili.mjs fav --check BV1Cat000001', '在看收藏过《猫》没有', '找', 'search'],
    ['node bili.mjs dynamic post --text "今天" --go', '在发动态', '发', 'send'],
    ['node bili.mjs dynamic post --text "今天" --dry', '在打动态草稿', '写', 'write'],
    ['node bili.mjs dynamic rm --id 1 --go', '在删动态', '发', 'send'],
    ['node bili.mjs dynamic rm --id 1 --dry', '在打删动态的草稿', '写', 'write'],
    ['node bili.mjs dynamic list', '在看自己的动态', '读', 'read'],
    ['node bili.mjs dynamic-image --text "图" --go', '在发图文动态', '发', 'send'],
    ['node bili.mjs dynamic-edit 123 a.txt --go', '在改动态', '发', 'send'],
    ['node bili.mjs dynamic-edit 123 a.txt', '在打改动态的草稿', '写', 'write'],
    ['node bili.mjs danmaku send --room 1 --msg "晚上好" --go', '在发弹幕', '发', 'send'],
    ['node bili.mjs danmaku send --room 1 --msg "晚上好" --dry', '在打弹幕草稿', '写', 'write'],
    ['node bili.mjs danmaku live --room 1 --seconds 60', '在直播间看弹幕', '看', 'watch'],
    ['node bili.mjs danmaku history --room 1', '在回看直播间弹幕', '读', 'read'],
    ['node bili.mjs danmaku pre --room 1', '在看直播间能不能发弹幕', '读', 'read'],
    ['node bili.mjs await --room 1', '在直播间等人喊她', '看', 'other'],
    ['node bili.mjs comment-await --minutes 5', '在等评论区有人回她', '看', 'other'],
    ['node bili.mjs watch --aid 1 --root 2', '在等评论下的新回复', '看', 'other'],
    ['node bili.mjs dm-await', '在等私信', '看', 'other'],
    ['node bili.mjs dm --status', '在看私信通道', '读', 'read'],
    ['node bili.mjs dm --msg "晚安" --go', '在给你发私信', '发', 'send'],
    ['node bili.mjs dm --msg "晚安" --dry', '在打给你的私信草稿', '写', 'write'],
    ['node bili.mjs dm --share --target BV:BV1Cat000001 --msg "这条好看" --go', '在把《猫》分享给你', '发', 'send'],
    ['node bili.mjs dm --msg "这条好看" --share --target BV:BV1Cat000001 --dry', '在打分享《猫》的私信草稿', '写', 'write'],
    ['node bili.mjs dm --share --target BV:BV1Cat000001 --msg "这条好看"', '在打分享《猫》的私信草稿', '写', 'write'],
    ['node bili.mjs notify "看完了"', '在给你报备', '发', 'send'],
    ['node bili.mjs notify "看完了" --dry', '在打给你的报备草稿', '写', 'write'],
    ['node bili.mjs notify --test', '在发测试通知', '发', 'other'],
    ['node bili.mjs quota react --auto', '在看你有没有表态', '读', 'read'],
    ['node bili.mjs quota status', '在看今天还能说几句', '读', 'read'],
    ['node bili.mjs memory recall --uid 1', '在回想这位观众', '想', 'think'],
    ['node bili.mjs memory show --uid 1', '在回想这位观众', '想', 'think'],
    ['node bili.mjs memory note --uid 1 --kind guess --text "喜欢猫"', '在记观众小本本', '记', 'write'],
    ['node bili.mjs memory correct --uid 1 --id a --text b', '在记观众小本本', '记', 'write'],
    ['node bili.mjs memory forget --uid 1 --id a', '在记观众小本本', '记', 'write'],
    ['node bili.mjs memory done --uid 1 --id a', '在记观众小本本', '记', 'write'],
    ['node bili.mjs diary show', '在翻今天的日记', '读', 'read'],
    ['node bili.mjs diary tail --n 5', '在翻今天的日记', '读', 'read'],
    ['node bili.mjs diary log night --note "看了三条"', '在记一笔：今晚醒来的事', '记', 'write'],
    ['node bili.mjs diary log night-skip --note "今晚不看"', '在记一笔：今晚只写日记', '记', 'write'],
    ['node bili.mjs diary log dm --target 主人', '在记一笔：私信的事', '记', 'write'],
    ['node bili.mjs diary log', '在记一笔', '记', 'write'],
    ['node bili.mjs diary log something-new', '在记一笔', '记', 'write'],
    ['node bili.mjs night status', '在看今晚的作息', '读', 'read'],
    ['node bili.mjs studio channel', '在看自己的频道设定', '读', 'read'],
    ['node bili.mjs studio channel submit', '把频道设定交给你确认', '发', 'send'],
    ['node bili.mjs studio new --format diary --title "猫的一天"', '开了新作品', '做', 'make'],
    ['node bili.mjs studio cast', '在挑角色和衣服', '做', 'make'],
    ['node bili.mjs studio check 202610242210-mao', '在查重', '做', 'make'],
    ['node bili.mjs studio render 202610242210-mao', '在做视频', '做', 'make'],
    ['node bili.mjs studio submit 202610242210-mao --reason "值得"', '把作品交给你审', '发', 'send'],
    ['node bili.mjs studio list', '在翻自己的作品', '读', 'read'],
    ['node bili.mjs studio show 202610242210-mao', '在翻自己的作品', '读', 'read'],
    ['node bili.mjs studio stats --n 20', '在看自己视频的数据', '读', 'read'],
    ['node bili.mjs studio voices', '在挑音色', '做', 'make'],
    ['node bili.mjs session', '在确认自己登的是哪个号', '读', 'read'],
    ['node bili.mjs selftest', '在做体检', '做', 'other'],
    ['node bili.mjs deps --json', '在做体检', '做', 'other'],
    ['node bili.mjs whois 123', '在查 TA 是谁', '找', 'search'],
    ['node bili.mjs covers BV1Cat000001', '在抓封面', '看', 'watch'],
    ['node bili.mjs help', '在查工具怎么用', '读', 'other'],
    ['node bili.mjs', '在查工具怎么用', '读', 'other'],
    ['node bili.mjs frobnicate', '在查工具怎么用', '读', 'other'],
  ]
  for (const [cmd, cap, glyph, activity] of rows) {
    const r = c(cmd)
    assert.deepEqual([r.cap, r.glyph, r.activity], [cap, glyph, activity], cmd)
    assert.equal(r.sub, cmd.includes('studio render') ? '做视频要几分钟' : undefined, cmd)   // 认得的命令不用英文说明
  }
  // BV / 标题 / 正文
  assert.deepEqual([c('node bili.mjs debrief BV1Cat000001').bv, c('node bili.mjs debrief BV1Cat000001').title], ['BV1Cat000001', '猫'])
  assert.equal(c('node bili.mjs feed').bv, undefined)
  // 她从参数里抄的字（搜索词 / 作品名 / 不认得的日记种类）：cap 一律是固定说法，原话放 text；主人起的回合（私信 / 当面聊）标 private
  const long = c('node bili.mjs search "' + '长'.repeat(50) + '"')
  assert.deepEqual([long.cap, long.text, long.private], ['在搜视频', '长'.repeat(39) + '…', undefined])
  for (const [cmd, cap, words] of [['node bili.mjs search "主人的词"', '在搜视频', '主人的词'], ['node bili.mjs search --kw 主人的词', '在搜视频', '主人的词'],
    ['node bili.mjs studio new --title "主人起的名字"', '开了新作品', '主人起的名字'], ['node bili.mjs diary log 主人的私事', '在记一笔', '主人的私事']]) {
    for (const ctx of [{ dm: true }, { owner: true }]) {
      const r = c(cmd, ctx)
      assert.deepEqual([r.cap, r.text, r.private], [cap, words, true], cmd)
      assert.ok(!r.cap.includes(words) && !String(r.sub ?? '').includes(words))
      assert.ok(shouldMask({ kind: 'tool_start', ...r }, true), '「遮住私话」遮得住')
    }
    assert.equal(c(cmd).private, undefined, '不是主人起的回合：不标 private')
  }
  assert.equal(c('node bili.mjs search ""').text, undefined)
  assert.equal(c('node bili.mjs diary log night').text, undefined, '认得的种类不用再引一遍')
  // 「看了这条」：看画面 / 读字幕 / 翻评论 / 回想都算（回合小结「看了 N 条」按它数）；挑、搜、评论、收藏不算
  for (const cmd of ['debrief BV1Cat000001', 'debrief BV1Cat000001 --no-frames', 'watch-video BV1Cat000001 3x3', 'subtitles BV1Cat000001', 'video BV1Cat000001',
    'comments BV1Cat000001', 'watched show BV1Cat000001', 'watched note BV1Cat000001 --text x', 'recon BV1Cat000001', 'covers BV1Cat000001'])
    assert.deepEqual([c('node bili.mjs ' + cmd).seen, c('node bili.mjs ' + cmd).bv], [true, 'BV1Cat000001'], cmd)
  for (const cmd of ['feed', 'search BV1Cat000001', 'comment --oid 1 --bvid BV1Cat000001 --message x --go', 'fav BV1Cat000001 --go', 'debrief', 'watched list'])
    assert.equal(c('node bili.mjs ' + cmd).seen, undefined, cmd)
  assert.equal(sanitizeEvent({ kind: 'tool_start', cap: 'x', seen: true }).seen, undefined, '没有 BV 的「看了」不出')
  assert.equal(sanitizeEvent({ kind: 'tool_start', cap: 'x', seen: 'yes', bv: 'BV1Cat000001' }).seen, undefined)
  const g = c('node bili.mjs comment --oid 1 --bvid BV1Cat000001 --message "' + '字'.repeat(60) + '" --go')
  assert.equal(g.text.length, 40); assert.equal(g.private, undefined)
  assert.equal(c('node bili.mjs comment --oid 1 --message "草稿不出去" --dry').text, undefined)
  for (const cmd of ['node bili.mjs dm --msg "晚安" --go', 'node bili.mjs dm --msg "晚安" --dry', 'node bili.mjs dm --share --target BV1Cat000001 --msg "晚安" --go', "node bili.mjs notify '晚安'"])
    assert.deepEqual([c(cmd).text, c(cmd).private], ['晚安', true], cmd)
  assert.equal(c('node bili.mjs dm --msg "晚安" --go', { dm: true }).cap, '在回你的私信')          // 主人私信的回合里是「回」
  assert.equal(c('node bili.mjs notify "' + '报'.repeat(100) + '"').text.length, 80)
  assert.equal(c('node bili.mjs dynamic post --text "公开的动态" --go').text, '公开的动态')
  assert.equal(c('node bili.mjs danmaku send --room 1 --msg "晚上好" --go').text, '晚上好')
  const pick = (r) => [r.cap, r.text]
  assert.deepEqual(pick(c('node bili.mjs studio render 202610242210-mao', { studioTitleOf: () => '猫的一天' })), ['在做视频', '猫的一天'])
  assert.deepEqual(pick(c('node bili.mjs studio submit 202610242210-mao', { studioTitleOf: () => '猫的一天' })), ['把作品交给你审', '猫的一天'])
  assert.deepEqual(pick(c('node bili.mjs diary log ' + '很长的事件种类名字超过十二个字还要更长一点')), ['在记一笔', '很长的事件种类名字超过十二个字还要更长…'])   // 不认得的种类：≤20（含「…」）
  // 不是 bili.mjs：模型自己的英文说明当小字
  assert.deepEqual(captionFor('Bash', { command: 'ls -la', description: 'List files' }), { cap: '在跑一条命令', glyph: '做', activity: 'other', sub: 'List files' })
  // 主人起的回合里：英文说明也可能在转述主人的话 → 不当小字，放 text 标 private
  assert.deepEqual(captionFor('Bash', { command: 'ls -la', description: 'List files' }, { dm: true }), { cap: '在跑一条命令', glyph: '做', activity: 'other', text: 'List files', private: true })
  assert.deepEqual(captionFor('Bash', { command: 'ls' }), { cap: '在跑一条命令', glyph: '做', activity: 'other' })
  assert.equal(captionFor('Bash', { command: 'node C:\\x\\tools\\bili.mjs feed' }).cap, '在挑今天看什么')
  // 碰到私密日记：只有那一句
  assert.deepEqual(captionFor('Bash', { command: 'type whale-diary-private.md', description: 'peek' }), { cap: '在翻只给自己看的日记', glyph: '读', activity: 'read' })
  // 不炸
  assert.doesNotThrow(() => captionFor(null, null))
  assert.doesNotThrow(() => captionFor('Bash', { command: 42 }))
  assert.equal(captionFor('Bash', { command: 'node bili.mjs debrief BV1Cat000001' }, { titleOf: () => { throw new Error('x') } }).cap, '在看 BV1Cat000001')
})

test('字幕表：Read / Edit / Write 按文件名，别的工具', () => {
  const H = 'C:\\Users\\SomeOne\\.bili-whale'
  const f = (tool, p, extra = {}) => captionFor(tool, { file_path: p, ...extra }, { titleOf: (bv) => (bv === 'BV1Cat000001' ? '猫' : null) })
  const rows = [
    ['Read', `${H}\\whale-work\\whale-diary.md`, '在翻日记', '读', 'read'],
    ['Edit', `${H}\\whale-work\\whale-diary.md`, '在写日记', '写', 'write'],
    ['Write', `${H}\\whale-work\\whale-diary.md`, '在写日记', '写', 'write'],
    ['Read', `${H}\\channel.md`, '在看频道设定', '读', 'read'],
    ['Edit', `${H}\\channel.md`, '在改频道设定', '写', 'write'],
    ['Write', `${H}\\channel.md`, '在写频道设定', '写', 'write'],
    ['Read', `${H}\\shots\\covers\\BV1Cat000001.jpg`, '在看《猫》的封面', '看', 'watch'],
    ['Read', `${H}/shots/video/BV1Cat000001-2026-10-24T16-22-55Z-3x3.jpg`, '在看《猫》的画面', '看', 'watch'],
    ['Read', `${H}\\shots\\video\\BV1Cat000001-subs.jpg`, '在看字幕条', '看', 'watch'],
    ['Read', `${H}\\shots\\subs\\BV1Cat000001-debrief.txt`, '在读《猫》的字幕', '读', 'read'],
    ['Read', `${H}\\shots\\subs\\BV1Dog000002-ai-zh.txt`, '在读 BV1Dog000002 的字幕', '读', 'read'],
    ['Read', `${H}\\shots\\comment-img\\1-2.jpg`, '在看评论里附的图', '看', 'watch'],
    ['Read', `${H}\\studio\\x\\script.json`, '在看剧本', '读', 'read'],
    ['Write', `${H}\\studio\\x\\script.json`, '在写剧本', '写', 'write'],
    ['Edit', `${H}\\studio\\x\\script.json`, '在写剧本', '写', 'write'],
    ['Read', `${H}\\notes.md`, '在读 notes.md', '读', 'read'],
    ['Read', `${H}\\pic.png`, '在看图 pic.png', '看', 'watch'],
    ['Edit', `${H}\\notes.md`, '在改 notes.md', '写', 'write'],
    ['Write', '/home/x/notes.md', '在写 notes.md', '写', 'write'],
    ['Read', `${H}\\whale-work\\whale-diary-private.md`, '在翻只给自己看的日记', '读', 'read'],
    ['Edit', `${H}\\whale-work\\whale-diary-private.md`, '在写只给自己看的日记', '写', 'write'],
    ['Write', `${H}\\whale-work\\whale-diary-private.md`, '在写只给自己看的日记', '写', 'write'],
  ]
  for (const [tool, p, cap, glyph, activity] of rows) {
    const r = f(tool, p, { old_string: 'x', new_string: 'y', content: 'z' })
    assert.deepEqual([r.cap, r.glyph, r.activity], [cap, glyph, activity], `${tool} ${p}`)
    assert.ok(!r.cap.includes('SomeOne') && !r.cap.includes('\\'), r.cap)
  }
  assert.deepEqual(f('Edit', `${H}\\whale-diary-private.md`, { old_string: '秘密', new_string: '秘密2' }), { cap: '在写只给自己看的日记', glyph: '写', activity: 'write' })
  assert.deepEqual(captionFor('Grep', { pattern: 'x', path: `${H}\\whale-diary-private.md` }), { cap: '在翻只给自己看的日记', glyph: '读', activity: 'read' })
  assert.deepEqual(captionFor('Glob', { pattern: '*.md' }), { cap: '在翻找东西', glyph: '找', activity: 'search' })
  assert.deepEqual(captionFor('Grep', { pattern: '猫' }), { cap: '在翻找东西', glyph: '找', activity: 'search' })
  assert.equal(captionFor('TodoWrite', { todos: [{}, {}, {}] }).cap, '在列待办（3 项）')
  assert.equal(captionFor('TodoWrite', {}).cap, '在列待办')
  assert.equal(captionFor('Task', {}).cap, '在叫帮手')
  assert.equal(captionFor('WebSearch', { query: 'x' }).cap, '在上网查东西')
  assert.equal(captionFor('mcp__srv__do_thing', {}).cap, '在用工具 do_thing')
  assert.equal(captionFor('奇怪 的名字', {}).cap, '在用工具')
})

// ─────────────── 状态 → 表情 ───────────────
test('状态 → 表情：每种状态对上该有的表情和嘴动', () => {
  const now = T0
  const on = { state: 'online' }
  const turn = { id: 'bili-whale-1', at: new Date(now - 60_000).toISOString() }
  const ev = (kind, ago, more = {}) => ({ kind, turn: turn.id, cap: more.cap ?? kind, rx: now - ago, t: '2020-01-01T00:00:00.000Z', ...more })
  const S = (o) => { const r = stateOf({ now, host: on, ...o }); return [r.state, r.expr, r.talking] }
  assert.deepEqual(S({ host: { state: 'offline' } }), ['offline', '困', false])
  assert.deepEqual(S({ host: null }), ['offline', '困', false])
  assert.deepEqual(S({ plan: { action: 'wake', atMs: now + 3600_000 } }), ['asleep', '困', false])      // 不知道在不在窗口里：照旧
  assert.equal(stateOf({ now, host: on, plan: { action: 'skip', atMs: now + 60_000 } }).caption, `在睡觉 · ${whenText(now + 60_000, now)} 醒（只写日记）`)
  assert.deepEqual(S({}), ['day', 'neutral', false])
  assert.deepEqual(S({ plan: { action: 'done' } }), ['day', 'neutral', false])
  assert.deepEqual(S({ queued: ['bili-whale-dm-abc'] }), ['dm_queued', '小吃惊', false])
  assert.deepEqual(S({ queued: [{ id: 'bili-whale-dm-abc', at: 'x' }] }), ['dm_queued', '小吃惊', false])
  assert.deepEqual(S({ queued: { dm: 1, total: 1 } }), ['dm_queued', '小吃惊', false])
  assert.deepEqual(S({ queued: 2 }), ['queued', 'neutral', false])
  assert.deepEqual(S({ host: { state: 'paused' } }), ['paused', '浅笑', false])
  assert.deepEqual(S({ chatting: true, host: { state: 'offline' } }), ['chatting', '浅笑', false])
  assert.deepEqual(S({ chatting: true, recent: [{ kind: 'said', turn: null, cap: '她说', text: '你好呀', rx: now - 100 }] }), ['chatting', '浅笑', true])
  // 回合里
  assert.deepEqual(S({ turn: { ...turn, at: now - 500 }, recent: [ev('turn_start', 500)] }), ['starting', '小吃惊', false])
  assert.deepEqual(S({ turn: { ...turn, at: now - 400 }, recent: [] }), ['starting', '小吃惊', false])
  assert.deepEqual(S({ turn, recent: [ev('turn_start', 2000)] }), ['starting', 'neutral', false])
  assert.deepEqual(S({ turn, recent: [ev('turn_start', 9000), ev('thinking', 100)] }), ['thinking', '想事情', false])
  for (const [activity, state] of [['watch', 'watching'], ['read', 'reading'], ['search', 'searching'], ['write', 'writing'], ['make', 'making']])
    assert.deepEqual(S({ turn, recent: [ev('tool_start', 20_000, { activity })], inflight: [{ toolId: 'a', cap: 'x', activity, since: 'x' }] }), [state, '浅笑', false], activity)
  assert.deepEqual(S({ turn, recent: [ev('tool_start', 20_000, { activity: 'other' })], inflight: [{ toolId: 'a', cap: 'x', activity: 'other' }] }), ['working', 'neutral', false])
  assert.equal(stateOf({ now, host: on, turn, recent: [], inflight: [{ cap: '在看《猫》', activity: 'watch' }, { cap: '在看《狗》', activity: 'watch' }] }).caption, '在看《狗》（同时 2 件）')
  // 说话：120 毫秒一个字，最多 6 秒；按服务端收到的时刻（rx）算，不按记录时间
  const said = (ago, n) => ev('said', ago, { text: '字'.repeat(n) })
  assert.deepEqual(S({ turn, recent: [said(500, 10)] }), ['replying', '浅笑', true])
  assert.deepEqual(S({ turn, recent: [said(1300, 10)] }), ['thinking', '想事情', false])
  assert.deepEqual(S({ turn, recent: [said(5900, 100)] }), ['replying', '浅笑', true])
  assert.deepEqual(S({ turn, recent: [said(6100, 100)] }), ['thinking', '想事情', false])
  assert.deepEqual(S({ turn, recent: [ev('tool_start', 300, { activity: 'send', cap: '在回你的私信', text: '晚安晚安' })], inflight: [{ cap: '在回你的私信', activity: 'send' }] }), ['replying', '浅笑', true])
  assert.deepEqual(S({ turn, recent: [ev('tool_start', 9000, { activity: 'send', cap: '在回你的私信', text: '晚安' })], inflight: [{ cap: '在回你的私信', activity: 'send' }] }), ['replying', '浅笑', false])
  // 出错 / 被拦 / 重试：别扭 4 秒，后面马上又「在想」也不盖掉
  assert.deepEqual(S({ turn, recent: [ev('tool_end', 1000, { ok: false }), ev('thinking', 900)] }), ['error', '别扭', false])
  assert.deepEqual(S({ turn, recent: [ev('denied', 3900, { ok: false })] }), ['denied', '别扭', false])
  assert.deepEqual(S({ turn, recent: [ev('retry', 100)] }), ['retry', '别扭', false])
  assert.deepEqual(S({ turn, recent: [ev('note', 100, { glyph: '错' })] }), ['error', '别扭', false])
  assert.deepEqual(S({ turn, recent: [ev('tool_end', 4100, { ok: false }), ev('thinking', 4000)] }), ['thinking', '想事情', false])
  assert.deepEqual(S({ turn, recent: [said(100, 10), ev('retry', 50)] }), ['retry', '别扭', false])
  assert.deepEqual(S({ turn, recent: [ev('said', 100, { turn: 'other-turn', text: '别的回合' })] }), ['starting', 'neutral', false])
  assert.deepEqual(S({ turn, recent: [ev('turn_end', 500)] }), ['done', '浅笑', false])
  // 回合之后
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: true, at: new Date(now - 1000).toISOString() }, plan: { action: 'wake' } }), ['done', '浅笑', false])
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: true, at: new Date(now - 5000).toISOString() }, plan: { action: 'wake' } }), ['asleep', '困', false])
  // 结束时刻信日志，不信服务端读到的时刻（开机重放的旧回合尾巴 rx 就是开机那一刻）
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: true, at: new Date(now - 60_000).toISOString() }, recent: [{ kind: 'turn_end', turn: 'x', cap: 'x', rx: now - 1000 }] }), ['day', 'neutral', false])
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: true }, recent: [{ kind: 'turn_end', turn: 'x', cap: 'x', rx: now - 1000 }] }), ['done', '浅笑', false], '日志没给时刻才看读到的时刻')
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: false, at: new Date(now - 600_000).toISOString() }, plan: { action: 'wake' } }), ['failed', '低落', false])
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: false, at: new Date(now - 2 * 3600_000).toISOString() }, plan: { action: 'wake' } }), ['asleep', '困', false])
  assert.deepEqual(S({ lastTurn: { id: 'x', ok: false, at: now - 600_000 }, queued: ['bili-whale-dm-1'] }), ['dm_queued', '小吃惊', false])
  // 这套衣服没有想要的表情：退到 neutral
  assert.equal(stateOf({ now, host: on, turn, recent: [said(100, 10)], exprs: ['neutral', '困'] }).expr, 'neutral')
  assert.equal(stateOf({ now, host: { state: 'offline' }, exprs: ['neutral', '困'] }).expr, '困')
  assert.doesNotThrow(() => stateOf())
  assert.doesNotThrow(() => stateOf({ recent: [null, 1, 'x'], inflight: 'x', queued: 'x', turn: 'x' }))
})

test('状态 → 表情：白天 / 睡着等下一次 / 今晚做完了（看在不在醒的窗口里）', () => {
  const now = new Date(2026, 10, 10, 23, 0).getTime()          // 本地 11-10 23:00（避开夏令时那晚；按本地时区构造，换哪个时区跑都一样）
  const on = { state: 'online' }
  const S = (o) => { const r = stateOf({ now, host: on, ...o }); return [r.state, r.expr, r.caption] }
  const wake = { action: 'wake', atMs: new Date(2026, 10, 11, 2, 10).getTime(), startsAt: new Date(2026, 10, 10, 18, 0).getTime() }
  assert.deepEqual(S({ plan: wake, inWindow: true }), ['asleep', '困', '在睡觉 · 02:10 醒'])
  assert.deepEqual(S({ plan: { ...wake, action: 'skip' }, inWindow: true }), ['asleep', '困', '在睡觉 · 02:10 醒（只写日记）'])
  assert.deepEqual(S({ plan: { ...wake, atMs: now - 30_000 }, inWindow: true }), ['asleep', '困', '在睡觉 · 该醒了'])
  // 窗口外：白天，不画 zz（state 不是 asleep）、表情 neutral（桌宠不呼吸）
  assert.deepEqual(S({ plan: wake, inWindow: false }), ['day', 'neutral', '白天不醒，私信随时能叫醒她'])
  assert.deepEqual(S({ plan: { ...wake, windowOpen: false } }), ['day', 'neutral', '白天不醒，私信随时能叫醒她'], '也认 plan.windowOpen')
  // 窗口里、但下一次是明晚（凌晨醒过以后调度马上排好的那次）/ 计划是 done：今晚的事做完了
  const next = { action: 'wake', atMs: new Date(2026, 10, 11, 21, 40).getTime(), startsAt: new Date(2026, 10, 11, 18, 0).getTime() }
  assert.deepEqual(S({ plan: next, inWindow: true, now: new Date(2026, 10, 11, 2, 20).getTime() }), ['night_done', '困', '在睡觉 · 今晚的事做完了'])
  assert.deepEqual(S({ plan: { action: 'done', reason: '今天可用窗口已结束或已经处理' }, inWindow: true }), ['night_done', '困', '在睡觉 · 今晚的事做完了'])
  // done 但这一晚一次都没醒（窗口设成 0 次 / 间隔排不下；服务端给 woke:false，作息那行说「今晚不醒了」）：不说「做完了」
  assert.deepEqual(S({ plan: { action: 'done', woke: false, reason: '所有窗口都设成了 0 次' }, inWindow: true }), ['night_done', '困', '在睡觉'])
  assert.deepEqual(S({ plan: { action: 'done', woke: true }, inWindow: true }), ['night_done', '困', '在睡觉 · 今晚的事做完了'])
  assert.deepEqual(S({ plan: null, inWindow: true }), ['night_done', '困', '在睡觉'])
  // 同一晚分两段的窗口（20–22 点、01–03 点）：下一段 12 小时内就开 → 还是「等着醒」
  assert.deepEqual(S({ plan: { action: 'wake', atMs: new Date(2026, 10, 11, 1, 30).getTime(), startsAt: new Date(2026, 10, 11, 1, 0).getTime() }, inWindow: true, now: new Date(2026, 10, 10, 20, 30).getTime() }),
    ['asleep', '困', '在睡觉 · 01:30 醒'])
  // 没给 startsAt：按 atMs 离现在多远猜
  assert.equal(S({ plan: { action: 'wake', atMs: now + 3 * 3600_000 }, inWindow: true })[0], 'asleep')
  assert.equal(S({ plan: { action: 'wake', atMs: now + 20 * 3600_000 }, inWindow: true })[0], 'night_done')
  // 优先级：离线 / 当面聊 / 刚做完 / 私信到了 / 上一回合没做完 / 排着的 都在作息前面
  assert.equal(S({ host: { state: 'offline' }, plan: wake, inWindow: false })[0], 'offline')
  assert.equal(S({ chatting: true, inWindow: false })[0], 'chatting')
  assert.equal(S({ queued: ['bili-whale-dm-1'], inWindow: false })[0], 'dm_queued')
  assert.equal(S({ queued: 1, inWindow: true, plan: wake })[0], 'queued')
  assert.equal(S({ lastTurn: { id: 'x', ok: false, at: now - 60_000 }, inWindow: false })[0], 'failed')
})

test('状态 → 表情：接真的作息计划（18:00–06:00 一次）—— 凌晨醒过以后今晚做完了、白天是白天、晚上等着醒', async () => {
  const { makePlan, completePlan, inWindow } = await import('../tools/lib/night-plan.mjs')
  const cfg = { windows: [{ start: '18:00', end: '06:00', wakes: 1 }], skipChance: 0 }
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime()
  const planOf = (st, t) => (st.action === 'done' ? { action: 'done', reason: st.reason } : { action: st.action, atMs: st.atMs, startsAt: st.startsAt })
  const view = (st, t) => { const r = stateOf({ now: t, host: { state: 'online' }, plan: planOf(st, t), inWindow: inWindow(cfg, t) }); return [r.state, r.expr] }
  let st = makePlan(cfg, {}, at(10, 17), () => 0.7)                 // 11-10 17:00 排今晚那次
  assert.deepEqual(view(st, at(10, 17)), ['day', 'neutral'])
  assert.deepEqual(view(st, at(10, 19)), ['asleep', '困'])
  const fired = st.atMs
  st = completePlan(st, fired)
  st = makePlan(cfg, st, fired + 10 * 60_000, () => 0.5)           // 醒过以后马上排明晚那次
  assert.ok(st.action === 'wake' && st.startsAt > fired)
  assert.ok(inWindow(cfg, fired + 10 * 60_000), '醒过以后还在今晚的窗口里')
  assert.deepEqual(view(st, fired + 10 * 60_000), ['night_done', '困'])               // 以前：在睡觉 + zz，一直到傍晚
  assert.deepEqual(view(st, at(11, 9)), ['day', 'neutral'])
  assert.deepEqual(view(st, at(11, 14)), ['day', 'neutral'])
  assert.deepEqual(view(st, at(11, 18, 30)), ['asleep', '困'])                         // 明晚那段窗口开了：等着醒
})

test('状态 → 表情：小窗刚开时的旧回合 —— 低落从回合结束算一小时，开机前结束的不闪「这回合做完了」', () => {
  const now = T0, on = { state: 'online' }, since = now - 300
  const S = (o) => { const r = stateOf({ now, host: on, since, inWindow: true, plan: { action: 'wake', atMs: now + 3600_000, startsAt: now - 3600_000 }, ...o }); return [r.state, r.expr, r.caption] }
  // 开机重放：旧回合的尾巴 rx = 开机那一刻（没 settle）
  const replayed = (id, ok, rx = now - 200) => ({ kind: 'turn_end', turn: id, cap: 'x', ok, rx })
  // 20 小时前没做完：不低落
  assert.equal(S({ lastTurn: { id: 'a', ok: false, at: new Date(now - 20 * 3600_000).toISOString() }, recent: [replayed('a', false)] })[0], 'asleep')
  // 20 分钟前没做完（小窗开之前）：低落，从回合结束算 —— 再过 41 分钟就不低落了
  const f20 = { id: 'b', ok: false, at: new Date(now - 20 * 60_000).toISOString() }
  assert.deepEqual(S({ lastTurn: f20, recent: [replayed('b', false)] }), ['failed', '低落', '上一回合没做完'])
  assert.equal(stateOf({ now: now + 41 * 60_000, host: on, since, lastTurn: f20, recent: [replayed('b', false)] }).state, 'day')
  // 之后有做成的回合（记录里已经收尾、日志还没读到）：不低落
  assert.equal(S({ lastTurn: f20, recent: [replayed('b', false), { kind: 'turn_end', turn: 'c', cap: 'x', ok: true, t: new Date(now - 60_000).toISOString(), rx: now - 100 }] })[0], 'asleep')
  // 更早做成的回合（开机重放，rx 是开机那一刻）不算「之后」
  assert.equal(S({ lastTurn: f20, recent: [{ kind: 'turn_end', turn: 'z', cap: 'x', ok: true, t: new Date(now - 3600_000).toISOString(), rx: now - 250 }, replayed('b', false)] })[0], 'failed')
  // 做成的：开机前 1 秒结束 → 不闪；开机后结束 → 闪 3 秒
  assert.equal(S({ lastTurn: { id: 'd', ok: true, at: new Date(since - 1000).toISOString() }, recent: [replayed('d', true)] })[0], 'asleep')
  assert.deepEqual(S({ lastTurn: { id: 'e', ok: true, at: new Date(since + 100).toISOString() } }), ['done', '浅笑', '这回合做完了'])
  // endedAt 优先（at 改成开始时刻也没关系）
  assert.equal(S({ lastTurn: { id: 'f', ok: true, at: new Date(now - 600_000).toISOString(), endedAt: now - 100 } })[0], 'done')
  assert.equal(S({ lastTurn: { id: 'g', ok: false, at: new Date(now - 600_000).toISOString(), endedAt: now - 2 * 3600_000 } })[0], 'asleep')
  // 不给 since：照旧（刚结束就闪）
  assert.equal(stateOf({ now, host: on, lastTurn: { id: 'h', ok: true, at: now - 1000 } }).state, 'done')
})

test('whenText：按本地日历说「今晚 / 明早 / 明天 / 明晚 / 后天」，今晚后半夜只说钟点', () => {
  const L = (d, h, m = 0, mo = 10) => new Date(2026, mo, d, h, m).getTime()
  assert.equal(whenText(L(11, 2, 10), L(10, 23)), '02:10')                 // 今晚过了零点
  assert.equal(whenText(L(10, 23), L(10, 19)), '23:00')
  assert.equal(whenText(L(10, 20, 30), L(10, 10)), '今晚 20:30')
  assert.equal(whenText(L(10, 3, 30), L(10, 2, 20)), '03:30')
  assert.equal(whenText(L(12, 3, 36), L(11, 2, 20)), '明天凌晨 03:36')    // 「03:36 醒 · 还有 25:16:00」那种：要说是明天
  // 后半夜还是昨晚那一夜：凌晨 02:20 刚醒过（气泡「今晚的事做完了」），今天傍晚那次说「明晚」；06:00 以后才是「今晚」
  assert.equal(whenText(L(11, 21), L(11, 2, 20)), '明晚 21:00')
  assert.equal(whenText(L(11, 21), L(11, 5, 59)), '明晚 21:00')
  assert.equal(whenText(L(11, 21), L(11, 6, 0)), '今晚 21:00')
  assert.equal(whenText(L(11, 7, 30), L(10, 20)), '明早 07:30')
  assert.equal(whenText(L(11, 14), L(10, 20)), '明天 14:00')
  assert.equal(whenText(L(11, 20), L(10, 20)), '明晚 20:00')
  assert.equal(whenText(L(12, 20), L(10, 20)), '后天 20:00')
  assert.equal(whenText(L(20, 20), L(10, 20)), '11月20日 20:00')
  assert.equal(whenText(new Date(2026, 9, 25, 23).getTime(), new Date(2026, 9, 24, 22).getTime()), '明晚 23:00')   // 夏令时结束那天（25 小时）也是「明天」
  assert.equal(whenText(new Date(2026, 9, 25, 23).toISOString(), new Date(2026, 9, 24, 22).getTime()), '明晚 23:00')
  assert.equal(whenText(NaN, 0), '')
  assert.equal(whenText('x', 0), '')
})

test('状态 → 表情：接真翻译器（recent 带 rx，记录晚到也照样嘴动）', () => {
  const clock = { t: T0 }
  const tr = createTranslator({ now: () => clock.t })
  tr.turnStart({ id: DM_TURN, at: T0 - 20_000 })
  for (const l of LINES.slice(0, lineIdx('收到啦，我这就回你') + 1)) tr.feed(l, { turnId: DM_TURN })
  for (const e of tr.recent()) assert.ok(Number.isFinite(e.rx))
  assert.ok(!('rx' in tr.feed(LINES[lineIdx('toolu_dm_send')], { turnId: DM_TURN })[0]), 'feed 出的事件不带 rx')
  const st = stateOf({ now: clock.t, host: { state: 'online' }, turn: { id: DM_TURN, at: T0 - 20_000 }, inflight: tr.inflight(), recent: tr.recent() })
  assert.deepEqual([st.state, st.expr, st.talking], ['replying', '浅笑', true])
  clock.t += 10_000
  const st2 = stateOf({ now: clock.t, host: { state: 'online' }, turn: { id: DM_TURN }, inflight: tr.inflight(), recent: tr.recent() })
  assert.deepEqual([st2.state, st2.expr, st2.talking], ['replying', '浅笑', false])   // 私信还在发
})

test('pickExpr / kindOf / 常量', () => {
  assert.deepEqual(EXPRS, ['neutral', '浅笑', '困', '想事情', '别扭', '低落', '小吃惊'])
  assert.equal(VIEW_VERSION, 1)
  assert.equal(pickExpr('浅笑', EXPRS), '浅笑')
  assert.equal(pickExpr('浅笑', ['neutral', '困']), 'neutral')
  assert.equal(pickExpr('浅笑', ['困', '低落']), '困')
  assert.equal(pickExpr('浅笑', []), null)
  assert.equal(pickExpr('浅笑', null), null)
  assert.deepEqual(kindOf('bili-whale-dm-abc'), { kind: 'dm', kindLabel: '你发来私信' })
  assert.deepEqual(kindOf('bili-whale-listen-1'), { kind: 'listen', kindLabel: '有人找她' })
  assert.deepEqual(kindOf('bili-whale-live-1'), { kind: 'live', kindLabel: '直播间有人喊她' })
  assert.deepEqual(kindOf('bili-whale-1792890601535'), { kind: 'night', kindLabel: '按作息醒来' })
  assert.deepEqual(kindOf('manual-1'), { kind: 'manual', kindLabel: '你叫醒了她' })
  assert.deepEqual(kindOf('bili-whale-preview-1'), { kind: 'preview', kindLabel: '预览' })
  assert.deepEqual(kindOf(null), { kind: 'other', kindLabel: '她醒了' })
})

test('模块是纯的：不引任何文件系统 / 网络 / 进程模块，也不从 dashboard.mjs 拿东西', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../host/liveview.mjs', import.meta.url)), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), '不该有 import')
  assert.ok(!/require\(|process\.|fs\.|child_process|dashboard/.test(src.replace(/\/\/.*$/gm, '')))
  assert.ok(!src.includes('\r\n'), 'LF 换行')
})
