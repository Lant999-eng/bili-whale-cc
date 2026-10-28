// 私信监听（只认主人）—— 2026-10-19 主人提议：私信比评论区更安静、风险更小
//   只看【主人那个会话】；其他会话（系统通知 / 陌生人）一律忽略。这个脚本只读私信，不发任何东西。
//   用法:
//     node dm-await.mjs --baseline              把当前位置记为「已读」，从现在起只认新消息
//     node dm-await.mjs --once [--json]         轮询一次（命中打印 DM_HIT；直接推进已读位置）
//     node dm-await.mjs --once --json --peek    把这一批新消息存成「待交付」，返回 receipt（不推进已读位置）
//     node dm-await.mjs --ack <receipt>        宿主可靠接收之后确认：推进已读位置，不访问网络
//
// 2026-10-23 改成按消息序号增量读取（参考 chenluQwQ/bilibili-ai-bot@6d24b1c 的 private_messages.py）：
//   以前只看会话的 last_msg —— 两次轮询之间主人连发 A、B、C，唤醒内容里可能只剩 C。
//   现在：会话的 max_seqno 比游标新 → fetch_session_msgs 取游标之后的消息 → 只留主人发的、按序号排好、按 msg_key 去重 →
//   一批（最多 MAX_BATCH 条）存成待交付。游标只在 --ack 时推进，而且只推进到这一批覆盖到的位置：
//   入队前崩溃 → 下次读到同一批；入队后、确认前崩溃 → 下次返回同一张 receipt（宿主按 requestId 去重）。
//   首次启用 / 换号：只建立游标，不追发历史消息；另外早于启用时间的消息一律不交付。
//   换号时旧号还没确认的那一批：不再交付、receipt 不认，作废时写一行进 dm-tick-err.log（面板看得到）；一批记着是哪个号取的（self）。
//   从旧版状态升级 / 旧版待交付确认之后：游标建在最近一页之前，只交付比旧版记下的位置新的（升级停机期间主人发的不丢）。
//   一批的大小同时受条数（20）和字数（每条按最多 500 字算、合计 2000）限制 —— 和唤醒提示放得下的一样多，确认的就是她看到的。
//   宿主专用：她的会话里（BILI_WHALE_AGENT=1）一律拒绝 —— 主人的私信由宿主取好、送进她的会话，她自己取会把这一批「吃掉」。
//   退出码：0 有新私信 · 1 没有 / 刚建游标（同时打印 {"hit":false}）· 2 用法 / 凭据不对 / 在她的会话里 · 3 网络或接口出错 ·
//           4 状态文件读不了 · 5 没料到的错
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { isAgent } from '../lib/paths.mjs'
import { renderShareCard } from '../lib/video-id.mjs'

if (isAgent()) { console.error('✗ 主人的私信由宿主取好、直接送进你的会话，不用自己取（dm-await 只给宿主用）'); process.exit(2) }
// 没料到的错（写状态文件失败之类）：退出码 5，别被当成「没有新私信」（1）
const crash = (e) => { console.error('✗ dm-await 出错：' + String(e?.stack ?? e).slice(0, 400)); process.exit(5) }
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const BASE = !!opt.baseline
const ONCE = !!opt.once || BASE
const JSONOUT = !!opt.json
const PEEK = !!opt.peek

const MAX_BATCH = 20        // 一批最多交付几条（再多的留给下一批，游标不越过它们）
const MSG_SHOW = 500        // 唤醒提示里每条最多放多少字（和 lib/scheduler.js 的 dmLines 一致）
const BATCH_CHARS = 2000    // 一批合计最多多少字（按每条 min(长度, MSG_SHOW) 算）
const FETCH_SIZE = 50       // 一次取多少条
const BACK_PAGES = 5        // 服务器给的是「最新的一页」、和游标之间有空档时，最多往回翻几页
const FORWARD_PAGES = 4     // 这一批没装满、又没到最新一条时，最多往后再翻几页（看看后面还有没有主人的私信）
const SEEN_KEEP = 500       // 记住多少个已确认的 msg_key（去重用）

const U = process.env.USERPROFILE || process.env.HOME || '/'
const STATE = path.join(U, '.bili-ai', 'dm-await-state.json')
let c
try { c = JSON.parse(fs.readFileSync(path.join(U, '.bili-ai', 'credentials.json'), 'utf8')) }
catch (e) { console.error(`✗ 读不了她的 B站 凭据（${e.code ?? e.message}）—— 跑 node host/cli.mjs cookie 重新填`); process.exit(2) }
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')
// 她现在用的号：凭据里的 UID（和 cookie 一起存，扫码 / 粘贴存凭据时写）→ 配置里的 self.mid（cookie 填完自动写）。
// 先看凭据：存凭据和改配置是两步，中间、或者改配置失败时，cookie 已经是新号了。换了号就重新建游标
const SELF = String(c?.dedeuserid || cfg.self?.mid || '').trim()
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空'); process.exit(2) }

const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://message.bilibili.com/',
  cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}`,
}
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('私信状态无法读取，已停止推进已读位置：' + error.message) }
}
const saveState = (o) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const temp = STATE + '.' + process.pid + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(temp, STATE) }
  finally { fs.rmSync(temp, { force: true }) }
}
const nowSec = () => Math.floor(Date.now() / 1000)
const sec = (t) => { const n = Number(t ?? 0); return n > 10_000_000_000 ? Math.floor(n / 1000) : n }

/** 一条私信 → 给她看的文字（不认识的类型也说一声，不悄悄丢掉） */
function render(m) {
  const type = Number(m.msg_type ?? 0)
  let body = m.content
  try { if (typeof body === 'string') body = JSON.parse(body) } catch {}
  if (type === 1) return typeof body === 'object' && body ? String(body.content ?? body.text ?? '') : String(m.content ?? '')
  // 分享卡片：直接给她 BV 号 + 标题 + UP 主（2026-10-24）。卡片里常常只有 av 号：以前给她的是 av 链接，她的工具打不开，
  //   只好按标题搜（搜出二十条也不知道是哪条）。现在本地换算成 BV 号；不是视频的分享（专栏、直播间）照实说（lib/video-id.mjs）
  if (type === 7) return renderShareCard(body && typeof body === 'object' ? body : null)
  if (type === 2) return '[图片]'
  return `[暂不支持显示的消息（类型 ${type}）]`
}

async function getJson(u) {
  const r = await fetch(u, { headers: H })
  // msg_key 是 19 位整数，超过 JS 数字的精度（直接解析会变成 …3000 这样的近似值：撤回对不上号，挨得很近的两条还会被当成同一条）
  // → 先按文本给它加上引号再解析，一位不差
  const raw = await (typeof r.text === 'function' ? r.text() : r.json().then((x) => JSON.stringify(x))).catch(() => '')
  try { return JSON.parse(String(raw).replace(/"msg_key"\s*:\s*(\d+)/g, '"msg_key":"$1"')) } catch { return {} }
}

/** 主人会话：{ max }（不在列表里返回 null） */
async function ownerSession() {
  const j = await getJson('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&size=100&mobi_app=web')
  if (j.code !== 0) throw new Error(`get_sessions code=${j.code} ${j.message ?? ''}`)
  const mine = (j.data?.session_list ?? []).find((s) => String(s.talker_id) === OWNER && Number(s.session_type ?? 1) === 1)
  if (!mine) return null
  return { max: Number(mine.max_seqno ?? mine.last_msg?.msg_seqno ?? 0) }
}

async function fetchPage(cursor, end = null) {
  const q = new URLSearchParams({ talker_id: OWNER, session_type: '1', begin_seqno: String(cursor), ...(end ? { end_seqno: String(end) } : {}), size: String(FETCH_SIZE), sender_device_id: '1', build: '0', mobi_app: 'web' })
  const j = await getJson('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?' + q)
  if (j.code !== 0) throw new Error(`fetch_session_msgs code=${j.code} ${j.message ?? ''}`)
  return { list: (j.data?.messages ?? []).filter((m) => Number(m.msg_seqno ?? 0) > cursor), more: Boolean(Number(j.data?.has_more ?? 0)) }
}

/**
 * 主人会话里游标之后的消息（按序号从小到大）。
 * 这个接口一次给多少、给的是「游标之后最早的一页」还是「最新的一页」还没用真号确认过：
 *   给的是最新一页、而且和游标之间有空档（has_more 且最小的序号 > 游标 + 1）→ 用 end_seqno 往回翻，最多 BACK_PAGES 页；
 *   还是补不上 → gap = true（交给提示说清楚「中间可能有没取到的」，不悄悄跳过）
 */
async function fetchAfter(cursor) {
  const bySeq = new Map()
  const add = (arr) => { for (const m of arr) bySeq.set(Number(m.msg_seqno), m) }
  const first = await fetchPage(cursor)
  add(first.list)
  const lowest = () => Math.min(...bySeq.keys())
  let gap = first.more && bySeq.size > 0 && lowest() > cursor + 1
  for (let i = 0; gap && i < BACK_PAGES; i += 1) {
    const low = lowest()
    const older = await fetchPage(cursor, low)
    const fresh = older.list.filter((m) => Number(m.msg_seqno) < low && !bySeq.has(Number(m.msg_seqno)))
    if (!fresh.length) break                                   // 往回翻不动（接口不认 end_seqno）：保留空档标记
    add(fresh)
    gap = older.more && lowest() > cursor + 1
  }
  const list = [...bySeq.values()].sort((a, b) => Number(a.msg_seqno) - Number(b.msg_seqno))
  return { list, more: first.more, gap }
}

/** 新状态：只建游标，不交付（首次启用 / 换号 / 旧版升级 / --baseline） */
function baselineState(st, max, why) {
  const base = { version: 2, owner: OWNER, self: SELF, cursor: Number(max ?? 0), seen: Array.isArray(st.seen) ? st.seen.slice(-SEEN_KEEP) : [],
    initializedAt: nowSec(), why, at: new Date().toISOString() }
  // 主人会话还不在列表里（游标只能从 0 开始）：记一道时间线，翻完全部旧消息之前一直挡着历史（留 2 分钟余量，免得本机时钟比 B站 快）
  if (!base.cursor) base.floorTs = base.initializedAt - 120
  return base
}

/** 从会话里挑出这一批：只要主人发的、没见过的、不早于启用时间的；返回 { messages, cover, truncated } */
function pickBatch(st, list, more) {
  const seen = new Set(st.seen ?? [])
  // 旧版（按数字解析）存下的编号是近似值：新取到的精确编号也按数字取近似再比
  const legacy = new Set((st.legacyKeys ?? []).map(String))
  const seenKey = (key) => seen.has(key) || legacy.has(key) || (legacy.size > 0 && /^\d+$/.test(key) && legacy.has(String(Number(key))))
  const batch = [], withdrawn = []
  let cover = Number(st.cursor ?? 0), chars = 0, full = false
  // 「不追发历史」主要靠游标（序号由服务器给，不受本机时钟影响）。只有建游标时主人会话还不在列表里（游标 = 0），
  // 才用时间兜底挡掉更早的消息；留 2 分钟余量，免得本机时钟比 B站 快时把刚发来的消息当成历史。
  // 从旧版升级过来的：floorTs = 旧版记下的位置（服务器时间），比它早的算历史
  const tsFloor = st.floorTs != null ? Number(st.floorTs) : Number(st.cursor ?? 0) > 0 ? 0 : Number(st.initializedAt ?? 0) - 120
  for (const m of list) {
    const seqno = Number(m.msg_seqno ?? 0)
    const type = Number(m.msg_type ?? 0)
    // type 5 = 撤回通知（内容是被撤回那条的编号），不是新消息；记下被撤回的是哪条（交付过的要从记忆里删掉）
    if (String(m.sender_uid ?? '') === OWNER && type === 5) withdrawn.push(String(m.content ?? '').replace(/^"|"$/g, '').trim())
    else if (String(m.sender_uid ?? '') === OWNER && Number(m.msg_status ?? 0) === 1 && seen.has(String(m.msg_key ?? seqno))) withdrawn.push(String(m.msg_key ?? seqno))
    if (String(m.sender_uid ?? '') === OWNER && Number(m.msg_status ?? 0) !== 1 && type !== 5) {
      const key = String(m.msg_key ?? seqno)
      const ts = sec(m.timestamp)
      if (!seenKey(key) && ts >= tsFloor) {
        const text = render(m)
        const size = Math.min(text.length, MSG_SHOW)
        // 剩下的留给下一批（条数满了，或者唤醒提示放不下了）：游标停在这一批的最后一条
        if (batch.length >= MAX_BATCH || (batch.length && chars + size > BATCH_CHARS)) { full = true; break }
        batch.push({ key, seqno, ts, type, text })
        chars += size
      }
    }
    cover = Math.max(cover, seqno)                           // 她自己的回复、撤回的、见过的也算「看过了」
  }
  if (full) cover = batch[batch.length - 1].seqno
  return { messages: batch, cover, full, withdrawn: withdrawn.filter(Boolean) }
}

const hitLine = (p) => `DM_HIT mid=${p.mid} name=${p.name} n=${p.messages.length} text=${p.text.replace(/\n/g, ' ').slice(0, 200)}`
const asPending = (p) => p.messages ? p : {   // 旧版（只有一条 text）的待交付：照样交付，确认后重新建游标
  ...p, messages: [{ key: String(p.key ?? ''), seqno: null, ts: Number(p.ts ?? 0), type: 1, text: String(p.text ?? '') }], legacy: true }

let st
try { st = loadState() } catch (e) { console.error(`✗ ${e.message}`); process.exit(4) }
if (st.owner && st.owner !== OWNER) st = {}                            // 换了主人：作废
// 游标和待交付的那一批是哪个号的（待交付的记着取它的号；没记就看状态里的）。换了号：那一批不再交付、它的 receipt 不认，
// 新号重新建游标 —— 旧号收到的私信不让新号去回（Astra 审查）
//   待交付的那批记着取它的号（取的时候不知道 = 空串）；旧版留下的没有这一项（null），就看状态里原本记的
const pendSelf = st.pending && Object.hasOwn(st.pending, 'self') ? String(st.pending.self ?? '') : null
const was = String(pendSelf || st.self || '')
const switched = Boolean(was && SELF && was !== SELF)
// 旧版留下的待交付一批：自己没记是哪个号取的，状态里原本也没记 —— 说不清是哪个号收到的，不能默认算现在这个号的：
// 和换号一样作废（不交付、receipt 不认、重新建游标、留记录、请主人重发）（Astra 第七次审查之后挑错时发现的）
const unknownPending = Boolean(st.pending && pendSelf === null && !st.self)
// 作废时说不清是哪个号的：上面那种，或者取的时候不知道是哪个号、之后又换了号 —— 不拿状态里的号去猜
const unknownWho = Boolean(st.pending && (unknownPending || (pendSelf === '' && switched)))
const voided = switched || unknownPending
// 以前不知道是哪个号（配置里还没有）：认现在这个，马上存下 —— 只放内存的话，没新私信的轮询都不写文件，下次换号就认不出来
//   （有一批说不清是哪个号的还在等：先不认，下面作废它、重新建游标时一起记上）
if (st.version === 2 && !st.self && SELF && !voided) { st.self = SELF; saveState(st) }

if (opt.ack) {
  const p = st.pending
  if (!p || p.receipt !== String(opt.ack) || p.mid !== OWNER) { console.error('私信确认凭据不匹配，未推进已读位置'); process.exit(2) }
  if (unknownWho) { console.error('这批私信记不清是哪个号取的 —— 不再交付，未推进已读位置'); process.exit(2) }
  if (switched) { console.error(`换号了：这批私信是旧号（UID ${was}）取的，现在她用的是 UID ${SELF} —— 不再交付，未推进已读位置`); process.exit(2) }
  const keys = asPending(p).messages.map((m) => m.key).filter(Boolean)
  const next = { ...st, seen: [...(st.seen ?? []), ...keys].slice(-SEEN_KEEP), at: new Date().toISOString() }
  delete next.pending
  delete next.floorTs
  if (p.legacy || p.cover == null || st.version !== 2) {
    // 旧版：不知道序号 → 下次轮询重建游标；比这一条新的（服务器时间）照样交付
    next.needBaseline = true
    if (Number(p.ts) > 0) next.floorTs = Number(p.ts)
    next.legacyKeys = [...(st.legacyKeys ?? []), ...keys].slice(-SEEN_KEEP)   // 旧版存的编号是丢了精度的近似值，对比时按同样的方式取近似
  } else next.cursor = Math.max(Number(st.cursor ?? 0), Number(p.cover))
  saveState(next)
  // 观众记忆：主人的私信记成「私密」条目（只在主人本人、私信里取得到，永远不进公开回复的检索）；记不上不影响确认
  try {
    const { recordOwnerDm } = await import('../lib/memory.mjs')
    for (const m of asPending(p).messages) {
      if (m.text && (m.type === 1 || m.type === 7)) recordOwnerDm({ uid: OWNER, name: OWNER_NAME, text: m.text, msgId: m.key, at: m.ts ? new Date(m.ts * 1000).toISOString() : undefined })
    }
  } catch (e) { console.error('（私信没记进记忆，不影响确认）' + String(e?.message ?? e).slice(0, 80)) }
  console.log('私信交付已确认'); process.exit(0)
}

// 还有没确认的一批：原样再给一次（同一张 receipt；宿主按 requestId 去重）—— 不重新读、不重复处理。换了号就不给了（下面作废）
if (st.pending?.mid === OWNER && !voided) {
  const p = asPending(st.pending)
  // 记的是哪个号就说哪个号（取的时候不知道 = 空串）；不拿现在这个号去补
  console.log(JSONOUT ? JSON.stringify({ hit: true, ...p, self: Object.hasOwn(st.pending, 'self') ? String(st.pending.self ?? '') : was }) : hitLine(p))
  process.exit(0)
}

let sess
try { sess = await ownerSession() } catch (e) { console.error(`✗ ${e.message}`); process.exit(3) }
const max = sess?.max ?? 0
const fresh = st.version !== 2 || st.needBaseline || voided || BASE
let baseline = null
// 换号之前那个号（或说不清是哪个号）还有一批没交付：随新游标一起作废，但不悄悄丢 —— 宿主日志、面板「最近的错误」都看得到
const dropped = voided && st.pending ? { self: unknownWho ? '' : was, n: asPending(st.pending).messages.length, ...(unknownWho ? { why: 'unknown' } : {}) } : null
const lost = dropped && (unknownWho
  ? `${unknownPending ? '旧版留下的 ' : ''}${dropped.n} 条你的私信还没确认交给她，记不清是哪个号收到的 —— 已作废，不交给她回复。要紧的话再发一次`
  : `换号了：旧号（UID ${dropped.self}）收到的 ${dropped.n} 条你的私信，换号时还没确认交给她 —— 已作废，新号不会去回。要紧的话发给新号（UID ${SELF}）再说一次`)
// 写进 dm-tick-err.log：面板「最近的错误」读它；宿主还没重启、用的是旧版生物钟时也留得下
if (lost) try { fs.appendFileSync(path.join(U, '.bili-ai', 'dm-tick-err.log'), new Date().toISOString() + ' ' + lost + '\n') } catch {}
if (fresh) {
  const why = BASE ? '手动 --baseline' : switched ? '换了号' : unknownPending && st.version === 2 ? '旧版待交付说不清是哪个号的' : st.needBaseline ? '旧版待交付已确认' : st.owner ? '从旧版状态升级' : '首次启用'
  // 从旧版过来（升级 / 旧版待交付刚确认）：旧版记下了读到哪（服务器时间）→ 游标建在最近一页之前，比那个位置新的照样交付
  //   说不清是哪个号的那一批作废了（没换号）：从它之后接着交付（按服务器时间，之后的是现在这个号的会话里取的），它自己不再交付
  const voidMsgs = unknownPending && !switched ? asPending(st.pending).messages : []
  const voidTs = Math.max(0, Number(st.pending?.ts) || 0, ...voidMsgs.map((m) => Number(m.ts) || 0))
  const legacyFloor = BASE || switched ? null : st.needBaseline ? st.floorTs
    : st.version !== 2 && st.owner ? Math.max(sec(st.lastSeen) || 0, voidMsgs.length ? voidTs : 0) || null
      : voidMsgs.length ? voidTs || null : null
  const voidKeys = voidMsgs.map((m) => String(m.key ?? '')).filter(Boolean)
  if (unknownPending) delete st.pending
  if (Number(legacyFloor) > 0) {
    if (lost && !JSONOUT) console.error(lost)
    // 旧版最后交付的那一条：同一秒里的不重复交付（旧版存的编号丢了精度，见 pickBatch 里的 legacyKeys）；作废的那批也不再交付
    const legacyKeys = [...(st.legacyKeys ?? []), ...(st.lastKey ? [String(st.lastKey)] : []), ...voidKeys]
    st = { ...baselineState(st, Math.max(0, max - FETCH_SIZE), why), floorTs: Number(legacyFloor), legacyKeys }
    saveState(st)
    baseline = why                                               // 往下照常取（只交付比旧版位置新的）
    // 作废了一批：这一轮先说出来就停（再往下取的话，万一断网，这一句就再也说不出来了）；比它新的下一轮照常交付
    if (lost) { if (JSONOUT) console.log(JSON.stringify({ hit: false, baseline, dropped })); process.exit(1) }
  } else {
    saveState(baselineState(st, max, why))
    if (BASE) console.log(`已把当前私信位置标记为已读（cursor=${max}）✓ 从现在起只认新消息${lost ? '\n' + lost : ''}`)
    else if (JSONOUT) console.log(JSON.stringify({ hit: false, baseline: why, ...(dropped ? { dropped } : {}) }))
    else console.log(`（${why}：已建立私信游标，不追发历史消息）${lost ? '\n' + lost : ''}`)
    process.exit(BASE ? 0 : 1)
  }
}
const none = (extra = {}) => {
  if (JSONOUT) console.log(JSON.stringify({ hit: false, ...(baseline ? { baseline } : {}), ...(dropped ? { dropped } : {}), ...extra }))
  else if (!ONCE) console.log('无新私信')
  process.exit(1)
}
if (!sess || max <= Number(st.cursor ?? 0)) none()

let got, list, pick
const seqMax = (l) => (l.length ? Number(l[l.length - 1].msg_seqno) : Number(st.cursor ?? 0))
try {
  got = await fetchAfter(Number(st.cursor ?? 0))
  list = got.list
  pick = pickBatch(st, list)
  // 这一批还没装满、又没取到会话的最新一条：往后再翻几页（后面可能还有主人的私信，也可能只是她自己发的报备）——
  // 翻到了才知道「后面还有没有主人的」，免得叫她等一批永远不会来的私信
  for (let i = 0; i < FORWARD_PAGES && !pick.full && seqMax(list) < max; i += 1) {
    const next = await fetchPage(seqMax(list))
    const have = new Set(list.map((m) => Number(m.msg_seqno)))
    const add = next.list.filter((m) => !have.has(Number(m.msg_seqno)))
    if (!add.length) break
    list = [...list, ...add].sort((a, b) => Number(a.msg_seqno) - Number(b.msg_seqno))
    pick = pickBatch(st, list)
  }
} catch (e) { console.error(`✗ ${e.message}`); process.exit(3) }
const { messages, cover, full, withdrawn } = pick
const reachedEnd = seqMax(list) >= max
const moreComing = full                      // 确定还有主人的私信没放进这一批（下一批马上送来）
const maybeMore = !full && !reachedEnd       // 翻了几页还没到最新一条：说不准后面还有没有
// 主人撤回了交付过的私信：从记忆里删掉。放在状态存好之后做 —— 记忆那边慢了 / 出错，都不耽误这一批私信（下次轮询原样拿得到）
const cleanWithdrawn = async () => {
  if (!withdrawn.length) return
  try {
    const { withdrawSaid } = await import('../lib/memory.mjs')
    for (const k of withdrawn) withdrawSaid({ uid: OWNER, msgId: k })
  } catch (e) { console.error('（撤回的私信没从记忆里删掉）' + String(e?.message ?? e).slice(0, 80)) }
}
if (!messages.length) {
  // 只有她自己的回复 / 撤回 / 见过的：游标往前推，不算命中；旧消息还没翻完时那道时间线留着
  if (cover > Number(st.cursor ?? 0)) { const next = { ...st, cursor: cover, at: new Date().toISOString() }; if (reachedEnd) delete next.floorTs; saveState(next) }
  await cleanWithdrawn()
  // 补不上的空档（接口只给最新的一部分）里可能有主人的私信：取到的这部分里没有主人的，也要说出来（宿主会推送告诉主人）
  none(got.gap ? { gap: true } : {})
}
const last = messages[messages.length - 1]
const result = {
  hit: true, mid: OWNER, name: OWNER_NAME, messages, cover, truncated: moreComing, more: moreComing, maybeMore, gap: Boolean(got.gap), withdrawn,
  self: SELF,                                                                   // 哪个号收到的（宿主跑这一回合之前再核对）
  text: messages.map((m) => m.text).join('\n'), ts: last.ts, key: last.key,     // 旧调用方只看 text / ts / key
}   // 不带 dropped：作废只在作废的那一轮说一次（这一批会存成待交付、可能重投好几次，带着就会每次都推送一遍）
if (PEEK) {
  result.receipt = crypto.randomUUID()
  saveState({ ...st, pending: result })
} else {
  saveState({ ...st, cursor: cover, seen: [...(st.seen ?? []), ...messages.map((m) => m.key)].slice(-SEEN_KEEP), at: new Date().toISOString() })
}
await cleanWithdrawn()
console.log(JSONOUT ? JSON.stringify(result) : hitLine(result))
process.exit(0)
