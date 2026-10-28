// 观众记忆（轻量版）：按 UID、评论线程记住「这个人以前跟她聊过什么」，相关时接上话。
//   · 存在主人那边：~/.bili-ai/memory/<uid>.json（每人一份）+ threads/<线程指纹>.json（线程里最近的几次交流）。
//     她的 Read 读不到 ~/.bili-ai —— 只能经 `node bili.mjs memory …` 取，取的时候按可见范围过滤。
//   · 只按 UID 认人，昵称只是附带显示（同名的不同人不会串）。
//   · 条目：exchange（她回了 TA 的评论：TA 说了什么 / 她回了什么）· said（主人的私信，私密）·
//           inbound（陌生人私信里 TA 发来的一条，私密）·
//           preference（TA 明确说过的偏好，必须指向 TA 自己的一条消息）· guess（她的推测）· todo（答应过的事）。
//   · 纠正 / 删除：旧条目只留指纹（墓碑），同样的内容 / 同一条证据想再写回来会被拒绝 —— 删掉的错误记忆不会被旧记录带回来。
//   · 取的时候先给当前线程近期的交流，再给这个人少量相关的记忆；有长度上限。公开回复的检索默认不含私密条目（主人私信）。
//   · 陌生人私信（2026-10-25 主人定）：陌生人那条路记下的都标 origin: 'sdm'、一律私密、永远不会被改成公开的；
//     只在 TA 自己的私信回合里取得到（scope peer-dm = TA 公开的 + origin sdm 的；主人私信、QQ 上的一条都没有）
//   · 这里出任何错都不该挡住当前消息：调用方一律 try/catch，失败只提示一句。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { updateJsonLocked } from './filelock.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const MEMORY_DIR = path.join(HOME, '.bili-ai', 'memory')
const THREAD_DIR = path.join(MEMORY_DIR, 'threads')

export const NOTE_KINDS = ['preference', 'guess', 'todo']
const MAX_ENTRIES = 200          // 每人最多记多少条（满了先丢最旧的交流记录，笔记保留；QQ 上的聊天有自己的份额，见 trim）
const QQ_CAP = 80                // 满了的时候，QQ 上的聊天超过这么多条的部分先丢
const QQ_KEEP = 30               // 最新的这么多条 QQ 聊天怎么都留着
const MAX_TOMBSTONES = 500
const THREAD_KEEP = 30
const EXCERPT = 200              // 交流记录每段最多留多少字
const NOTE_MAX = 120             // 一条笔记最多多少字

const uidOk = (uid) => /^\d{1,20}$/.test(String(uid ?? ''))
const assertUid = (uid) => { if (!uidOk(uid)) throw new Error(`不是合法的 UID：${String(uid).slice(0, 30)}`); return String(uid) }
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()                    // 存的原文：只收空白，标点照旧
const fold = (s) => norm(s).normalize('NFKC').toLowerCase()                          // 比对用：全角半角、大小写都算一样
const excerpt = (s, n = EXCERPT) => { const t = norm(s); return t.length > n ? t.slice(0, n) + '…' : t }
const fp = (s) => crypto.createHash('sha256').update(fold(s)).digest('hex').slice(0, 24)
const newId = () => `m-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
export const threadKey = (type, oid, root) => (oid ? `${Number(type ?? 1)}:${String(oid)}:${String(root || '0')}` : null)
const userFile = (uid) => path.join(MEMORY_DIR, `${assertUid(uid)}.json`)
const threadFile = (key) => path.join(THREAD_DIR, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`)

// 不收这类信息：手机号 / 长串号码（卡号、证件号）/ 邮箱 / 这几个词（只记有助于交流的事；日期、BV 号不算）
const SENSITIVE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{15,19}(?!\d)|\d{17}[\dXx]|[\w.+-]+@[\w-]+\.[a-z]{2,}|身份证|银行卡|家庭住址|密码/i
// 自动记的原话（评论、私信）里，号码和邮箱换成「[略]」再存
const CONTACT = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{15,19}(?!\d)|(?<!\d)\d{17}[\dXx](?![\dXx])|[\w.+-]+@[\w-]+\.[a-z]{2,}/gi
const redact = (s) => String(s ?? '').replace(CONTACT, '[略]')
const NOTE_CAP = 40              // 每人最多多少条还有效的笔记（偏好 / 推测 / 没做完的待办）

function checkUserDoc(doc, uid) {
  const ok = doc && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.entries) && Array.isArray(doc.tombstones ?? [])
  if (!ok) throw new Error(`观众记忆 ${uid} 结构不对`)
  return doc
}
const emptyDoc = (uid) => ({ version: 1, uid: String(uid), names: [], entries: [], tombstones: [] })

/** 读一个人的记忆（不存在 = 空；读不出来 / 结构不对 = 抛错，调用方决定怎么办） */
export function loadUser(uid) {
  const f = userFile(uid)
  let raw
  try { raw = fs.readFileSync(f, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return emptyDoc(uid); throw new Error(`观众记忆 ${uid} 读不了（${e?.code ?? e}）`) }
  let doc
  try { doc = JSON.parse(raw) } catch { throw new Error(`观众记忆 ${uid} 坏了（不是完整的 JSON）`) }
  return checkUserDoc(doc, uid)
}

/** 在锁里读改写一个人的记忆；fn 的返回值原样带出来（不写进文件） */
function updateUser(uid, fn) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  let ret
  updateJsonLocked(userFile(uid), (doc) => {
    checkUserDoc(doc, uid)
    const had = new Set(doc.entries.map((e) => e.id))
    ret = fn(doc)
    // 这一次刚记下的不丢（以前满了的时候新记的 QQ 那条当场就被丢掉，调用方还说「记下了」，之后据它记笔记也找不到，2026-10-25 第二轮审查）
    trim(doc, new Set(doc.entries.filter((e) => !had.has(e.id)).map((e) => e.id)))
    return doc
  }, emptyDoc(uid))
  return ret
}
const qqChat = (e) => (e.kind === 'exchange' || e.kind === 'said') && e.channel === 'qq'
const gone = (e) => ['deleted', 'superseded', 'done'].includes(e.status)
// 原话一类的条目（交流记录、主人私信、陌生人私信里 TA 发来的）：满了先丢它们；--evidence 指的就是它们的编号
const isLog = (k) => k === 'exchange' || k === 'said' || k === 'inbound'
/** 陌生人那条路记下的（sdm-await 记的 TA 的私信、她回 TA 之后的交流、在 TA 的私信回合里记的笔记） */
const isSdm = (e) => e?.origin === 'sdm'
/**
 * 陌生人私信回合里看得到的（peer-dm）：这个人公开的，加上陌生人那条路记下的。
 * 主人私信（said）、QQ 上的一律没有 —— 哪怕主人换过 mid、这个 UID 的文件里存着主人当时的私信（审查 #6）
 */
const peerVisible = (e) => e.kind !== 'said' && e.channel !== 'qq' && (e.visibility === 'public' || isSdm(e))
/**
 * 满了（超过 MAX_ENTRIES）先丢最旧的交流记录、已经作废 / 做完的；还有效的笔记（偏好、推测、没做完的待办）和 fresh（这一次刚记下的）留着。
 * QQ 上的聊天（主人在 QQ 上说的、她在 QQ 上回的）有份额，不是谁先丢谁（2026-10-25 第二轮审查）：
 *   ① QQ 聊天超过 QQ_CAP 条的部分先丢（从旧到新）—— QQ 是拿来闲聊的，量大，不能让它把主人在评论区的来回、B站 私信挤掉
 *      （评论区的交流记录一没，线程索引就指了个空，那条线程里回复时就接不上话了）
 *   ② 还多就不分渠道、从最旧的丢起 —— 但最新的 QQ_KEEP 条 QQ 聊天怎么都留着：以前 QQ 的一律先丢，
 *      主人在 B站 私信 / 评论区攒满 200 条以后，新记的 QQ 聊天当场就被丢掉，一条都留不住
 */
function trim(doc, fresh = new Set()) {
  // 墓碑上限只管她自己留下的；主人的、工具的（撤回之类）一条都不丢 —— 她刷再多也挤不掉主人的删除 / 纠正
  const tomb = doc.tombstones ?? []
  doc.tombstones = [...tomb.filter((x) => x.by !== 'her'), ...tomb.filter((x) => x.by === 'her').slice(-MAX_TOMBSTONES)]
  let over = doc.entries.length - MAX_ENTRIES
  if (over <= 0) return
  const keep = new Set([...fresh, ...doc.entries.filter((e) => qqChat(e) && !gone(e)).slice(-QQ_KEEP).map((e) => e.id)])
  const droppable = doc.entries.filter((e) => !keep.has(e.id) && (isLog(e.kind) || gone(e)))   // 从旧到新
  const drop = new Set()
  let qqOver = doc.entries.filter(qqChat).length - QQ_CAP
  for (const e of droppable) {
    if (over <= 0 || qqOver <= 0) break
    if (!qqChat(e)) continue
    drop.add(e.id); over -= 1; qqOver -= 1
  }
  for (const e of droppable) {
    if (over <= 0) break
    if (drop.has(e.id)) continue
    drop.add(e.id); over -= 1
  }
  doc.entries = doc.entries.filter((e) => !drop.has(e.id))
}
const remember = (doc, name) => {
  const n = norm(name).slice(0, 40)
  if (!n) return
  doc.names = [...(doc.names ?? []).filter((x) => x.name !== n), { name: n, at: new Date().toISOString() }].slice(-5)
}
const isNote = (k) => NOTE_KINDS.includes(k)
// 每人一个递增序号：条目、墓碑记下时各取一个（判断「证据是不是删掉之后才记下的」用它，不靠毫秒时间）
const tick = (doc) => (doc.seq = Number(doc.seq ?? 0) + 1)
const newer = (ev, x) => (ev?.n != null && x?.n != null ? ev.n > x.n : String(ev?.at ?? '') > String(x?.at ?? ''))
// 「TA 后来又说了一次」：证据是删掉之后才记下的一条，而且那条原话确实把这条笔记说了一遍 ——
//   笔记里去掉常见字词（喜欢、视频、这个、ta…）之后，大部分（≥ 60%，至少 2 处）都出现在原话里；
//   主人亲手删掉 / 纠正的，她不能再记回来（要记请主人自己记）
const COMMON = new Set(['喜欢', '视频', '这个', '那个', '什么', '一个', '我们', '你们', '他们', '她们', '就是', '不是', '没有', '可以', '还是', '真的', '觉得', '这期', '主人', '时候', '有点', '一下', '知道', '现在'])
const covers = (note, said) => {
  const want = [...grams(note)].filter((g) => !COMMON.has(g) && !/^[a-z]{1,2}$|^\d+$/.test(g))
  if (!want.length) return false
  const have = grams(said)
  const hit = want.filter((g) => have.has(g)).length
  return hit >= Math.min(2, want.length) && hit / want.length >= 0.6
}
const restated = (t, x) => Boolean(t.ev && t.text && (x.by !== 'owner' || t.by === 'owner') && newer(t.ev, x) && covers(t.text, t.ev.text ?? ''))
/** 这条会不会把删掉 / 纠正过的东西带回来（t.ev = 证据那一条，t.text = 笔记原文） */
const buried = (doc, t) => (doc.tombstones ?? []).some((x) =>
  // 同一条消息的交流记录 / 私信：删掉过就不再记
  (x.kind === t.kind && t.msgId && x.msgId && x.msgId === t.msgId && isLog(t.kind)) ||
  // 同样的内容：删掉 / 纠正过的笔记就不再记，换个类型（偏好 / 推测 / 待办）也不行；唯一例外：TA 后来又说了一次（见 restated）
  (t.hash && x.hash === t.hash && isNote(x.kind) && isNote(t.kind) && !restated(t, x)) ||
  // 同一条证据：据它记过的笔记被删 / 纠正过 → 不能再据它记回来（换个说法、换个类型都不行）
  (t.evidence && x.evidence && x.evidence === t.evidence && isNote(x.kind) && isNote(t.kind)))
/** 据哪些消息记过的笔记被删 / 纠正过（取记忆时给那几条原话标一句，别再据它下结论） */
const disputedOf = (doc) => new Set((doc.tombstones ?? []).filter((x) => NOTE_KINDS.includes(x.kind) && x.evidence).map((x) => x.evidence))

/**
 * 她回了某人的评论（或别的公开交流）：记下 TA 说了什么、她回了什么。
 * theirMsgIds：她这一次回的是 TA 连着发的好几条（QQ 一回合）—— 每一条的编号都记上，其中哪条后来被撤回，这条交流记录一并删掉
 * origin 'sdm'（陌生人私信，sdm reply 发出去以后记）：一律私密、channel dm、不进任何评论线程 —— 传进来的 visibility / thread 不算数
 */
export function recordExchange({ uid, name, theirText, theirMsgId, theirMsgIds, herText, herMsgId, thread, target, channel = 'comment', visibility = 'public', origin = '' }) {
  assertUid(uid)
  const sdm = origin === 'sdm'
  const entry = {
    id: newId(), kind: 'exchange', uid: String(uid), at: new Date().toISOString(), channel: sdm ? 'dm' : channel, visibility: sdm ? 'private' : visibility,
    msgId: theirMsgId ? String(theirMsgId) : null, herMsgId: herMsgId ? String(herMsgId) : null,
    thread: sdm ? null : thread ?? null, target: sdm ? null : target ?? null, text: excerpt(redact(theirText)), her: excerpt(redact(herText)), status: 'active', by: 'tool',
  }
  if (sdm) entry.origin = 'sdm'
  const ids = Array.isArray(theirMsgIds) ? [...new Set(theirMsgIds.filter((x) => x != null && x !== '').map(String))].slice(0, 50) : []
  if (ids.length) entry.theirMsgIds = ids
  const saved = updateUser(uid, (doc) => {
    remember(doc, name)
    // 其中任何一条撤回过（墓碑在）：整条不记 —— 撤回的话不能跟着她的回复一起留下来。
    // QQ 的还要看「主人私信」的墓碑：主人刚好在她回完、记下来之前撤回（那时还没有交流记录可删）；
    // 陌生人私信同理：TA 在她回之前就撤回了其中一条（withdrawSaid 那时只留下了 said 的墓碑）
    const withdrawn = (m) => buried(doc, { kind: 'exchange', msgId: m }) || ((entry.channel === 'qq' || sdm) && doc.tombstones.some((x) => x.kind === 'said' && x.msgId === m))
    if ([entry.msgId, ...ids].some((m) => m && withdrawn(m))) return 'buried'
    if (entry.msgId && doc.entries.some((e) => e.kind === 'exchange' && e.msgId === entry.msgId && e.herMsgId === entry.herMsgId)) return 'dup'
    entry.n = tick(doc)
    doc.entries.push(entry)
    return 'ok'
  })
  if (saved === 'ok' && entry.thread) {
    fs.mkdirSync(THREAD_DIR, { recursive: true })
    updateJsonLocked(threadFile(entry.thread), (t) => {
      if (!t || typeof t !== 'object' || !Array.isArray(t.refs)) throw new Error('线程索引结构不对')
      t.key = entry.thread
      t.refs = [...t.refs, { uid: entry.uid, id: entry.id, at: entry.at }].slice(-THREAD_KEEP)
      return t
    }, { key: entry.thread, refs: [] })
  }
  return { result: saved, id: entry.id }
}

/** 主人的私信（私密）：只在主人自己的私信里用得上，永远不进公开回复的检索。channel：dm（B站 私信）· qq（主人在 QQ 上说的） */
export function recordOwnerDm({ uid, name, text, msgId, at, channel = 'dm' }) {
  assertUid(uid)
  const entry = { id: newId(), kind: 'said', uid: String(uid), at: at ?? new Date().toISOString(), channel: String(channel || 'dm'), visibility: 'private',
    msgId: msgId ? String(msgId) : null, thread: null, target: null, text: excerpt(redact(text)), status: 'active', by: 'tool' }
  const saved = updateUser(uid, (doc) => {
    remember(doc, name)
    if (buried(doc, { kind: 'said', msgId: entry.msgId })) return 'buried'
    if (entry.msgId && doc.entries.some((e) => e.kind === 'said' && e.msgId === entry.msgId)) return 'dup'
    entry.n = tick(doc)
    doc.entries.push(entry)
    return 'ok'
  })
  return { result: saved, id: entry.id }
}

/**
 * 陌生人私信里 TA 发来的一条（sdm-await 确认交付时记）：这个人的私密条目（kind inbound、origin sdm），只在 TA 自己的私信回合里取得到。
 * 记下 msgId：她据它记偏好时 --evidence 用它（审查 #12）；TA 撤回 → withdrawSaid 按编号删掉。没有编号的不记（撤回时删不掉）
 */
export function recordPeerDm({ uid, name, text, msgId, at }) {
  assertUid(uid)
  const k = msgId ? String(msgId) : ''
  const t = excerpt(redact(text))
  if (!k || !t) return { result: 'skip' }
  const when = at && !isNaN(new Date(at)) ? new Date(at).toISOString() : new Date().toISOString()
  const entry = { id: newId(), kind: 'inbound', uid: String(uid), at: when, channel: 'dm', visibility: 'private', origin: 'sdm',
    msgId: k, thread: null, target: null, text: t, status: 'active', by: 'tool' }
  const saved = updateUser(uid, (doc) => {
    remember(doc, name)
    // 删掉过（她 / 主人 forget 的）、TA 已经撤回了（withdrawSaid 留的 said 墓碑）：不再记
    if (buried(doc, { kind: 'inbound', msgId: k }) || doc.tombstones.some((x) => x.kind === 'said' && x.msgId === k)) return 'buried'
    if (doc.entries.some((e) => e.kind === 'inbound' && e.msgId === k)) return 'dup'
    entry.n = tick(doc)
    doc.entries.push(entry)
    return 'ok'
  })
  return { result: saved, id: entry.id }
}

/**
 * 主人撤回了一条私信：那条「主人私信」和据它记的笔记一并删掉（只留墓碑；之后同一条再来也记不回来）。
 * 她回那条（或回连着几条、其中有它）的交流记录也一并删掉（QQ 上她回的是一批，撤回其中一条，整条交流记录就不留了）。
 * 陌生人撤回（sdm-await 调，reason「TA 撤回了」）同样处理：TA 那一条（inbound）、她回的那次交流、据它记的笔记一起删掉
 */
export function withdrawSaid({ uid, msgId, by = 'tool', reason = '主人撤回了' }) {
  assertUid(uid)
  const k = String(msgId ?? '')
  if (!k) return { result: 'skip' }
  const why = norm(reason).slice(0, 40) || '主人撤回了'
  updateUser(uid, (doc) => {
    const at = new Date().toISOString()
    if (!doc.tombstones.some((x) => x.kind === 'said' && x.msgId === k)) doc.tombstones.push({ n: tick(doc), kind: 'said', hash: null, msgId: k, evidence: null, at, by, reason: why })
    const hits = doc.entries.filter((e) => e.kind === 'exchange' && e.status !== 'deleted' && (e.msgId === k || (Array.isArray(e.theirMsgIds) && e.theirMsgIds.includes(k))))
    // 交流记录的墓碑和「主人私信」那条一样：之后她再记同一条（或连着几条里有它）也记不回来
    if (hits.length && !doc.tombstones.some((x) => x.kind === 'exchange' && x.msgId === k)) doc.tombstones.push({ n: tick(doc), kind: 'exchange', hash: null, msgId: k, evidence: null, at, by, reason: why })
    for (const e of hits) Object.assign(e, { status: 'deleted', text: '', her: '', deletedAt: at, deletedBy: by })
    for (const e of doc.entries) {
      if (e.status === 'deleted' || e.status === 'superseded') continue
      if ((e.kind === 'said' || e.kind === 'inbound') && e.msgId === k) Object.assign(e, { status: 'deleted', text: '', deletedAt: at, deletedBy: by })
      else if (isNote(e.kind) && e.evidence === k) {
        doc.tombstones.push({ n: tick(doc), kind: e.kind, hash: fp(e.text), msgId: null, evidence: k, at, by, reason: '依据的私信被撤回了' })
        Object.assign(e, { status: 'deleted', text: '', deletedAt: at, deletedBy: by })
      }
    }
  })
  return { result: 'ok' }
}

/**
 * 她记一条笔记：preference（TA 明确说过的偏好，--evidence 必须是 TA 自己那条消息的编号，已经在记录里）·
 * guess（她的推测，会标成「推测」）· todo（答应过的事）。删掉 / 纠正过的同样内容不会再收
 * 私密：证据是私密条目（主人私信）→ 私密；记在主人身上、又不是出自一条公开评论的 → 也私密（owner = 主人的 UID）
 * origin 'sdm'（在陌生人私信回合里记的）：一律私密、标 origin sdm；证据只认这个回合看得到的（TA 公开的、陌生人那条路记下的）。
 * 证据是陌生人私信里的一条 → 笔记也标 origin sdm（只在 TA 的私信里取得到）。origin sdm 的笔记永远不会被改成公开的（审查 #6）
 */
export function addNote({ uid, kind, text, evidence, thread, by = 'her', owner = '', origin = '' }) {
  assertUid(uid)
  if (!NOTE_KINDS.includes(kind)) throw new Error(`类型只能是 ${NOTE_KINDS.join(' / ')}`)
  const t = norm(text)
  if (!t) throw new Error('笔记是空的')
  if (t.length > NOTE_MAX) throw new Error(`一条笔记最多 ${NOTE_MAX} 字：写成一句话的要点`)
  if (SENSITIVE.test(fold(t))) throw new Error('不记联系方式、证件号、住址这类信息')
  const sdm = origin === 'sdm'
  const entry = { id: newId(), kind, uid: String(uid), at: new Date().toISOString(), channel: 'note', visibility: sdm ? 'private' : 'public',
    evidence: evidence ? String(evidence) : null, thread: sdm ? null : thread ?? null, text: t, status: kind === 'todo' ? 'open' : 'active', by }
  if (sdm) entry.origin = 'sdm'
  const saved = updateUser(uid, (doc) => {
    // 给了证据就一定要在这个人自己的记录里找得到（偏好必须给）；陌生人私信回合里只认那个回合看得到的
    const ev = entry.evidence ? doc.entries.find((e) => isLog(e.kind) && e.msgId && e.msgId === entry.evidence && e.status === 'active' && (!sdm || peerVisible(e))) : null
    if (kind === 'preference' && !ev) return 'no-evidence'
    if (entry.evidence && !ev) return 'bad-evidence'
    if (ev?.visibility === 'private' || (owner && String(uid) === String(owner) && ev?.visibility !== 'public')) entry.visibility = 'private'
    if (isSdm(ev)) Object.assign(entry, { visibility: 'private', origin: 'sdm' })
    if (buried(doc, { kind, hash: fp(t), evidence: entry.evidence, ev, text: t, by })) return 'buried'
    // 同样的内容已经有一条还有效的：不再记；只有原来那条是私密的、这次出自一条公开评论时，把它改成公开的。
    // 陌生人那条路的笔记两边分开比：私信里记的只和这个回合看得到的比（看不到的私密条目不能借「已经记过」探出来）；
    // 公开记的不和私信里记的比 —— 私信里那条永远不改成公开的，公开的另记一条
    const same = doc.entries.find((e) => e.kind === kind && (e.status === 'active' || e.status === 'open') && fp(e.text) === fp(t) &&
      (isSdm(entry) ? peerVisible(e) : !isSdm(e)))
    if (same) {
      if (same.visibility !== 'private' || entry.visibility !== 'public' || isSdm(same)) return 'dup'
      Object.assign(same, { visibility: 'public', evidence: entry.evidence, madePublicAt: new Date().toISOString() })
      entry.id = same.id
      return 'public'
    }
    if (doc.entries.filter((e) => NOTE_KINDS.includes(e.kind) && (e.status === 'active' || e.status === 'open')).length >= NOTE_CAP) return 'full'
    entry.n = tick(doc)
    doc.entries.push(entry)
    return 'ok'
  })
  if (saved === 'full') throw new Error(`这个人的笔记已经有 ${NOTE_CAP} 条了：先整理（forget / correct / done）再记`)
  if (saved === 'no-evidence') throw new Error('「偏好」要指向 TA 自己说过的那条消息（--evidence <rpid 或私信编号>），记录里没找到；拿不准就记成 guess')
  if (saved === 'bad-evidence') throw new Error('--evidence 指的那条消息在 TA 的记录里没找到（不确定就别带 --evidence）')
  if (saved === 'buried') throw new Error('这条（或据同一条消息记的笔记）之前被删掉或纠正过，不再记（主人删 / 改的你不能再记回来；你自己删的，等 TA 后来又明明白白说一次、用那条新消息作证据）')
  return { result: saved, id: entry.id }
}

// 陌生人私信回合里（origin 'sdm'）：forget / correct / done 只能动陌生人那条路记下的；别的（TA 公开的、主人那边留下的）这里不能改（审查 #1）
const NOT_SDM = '这条不是在和 TA 的私信里记的 —— 陌生人私信回合里只能改在私信里记的'

/** 删掉一条：只留墓碑（指纹 + 证据 / 消息编号），原文清掉。origin 'sdm' = 在陌生人私信回合里删（只能删陌生人那条路记下的） */
export function forget({ uid, id, reason = '', by = 'her', origin = '' }) {
  assertUid(uid)
  const saved = updateUser(uid, (doc) => {
    const e = doc.entries.find((x) => x.id === id)
    if (!e) return 'missing'
    if (origin === 'sdm' && !isSdm(e)) return 'not-sdm'
    if (e.status === 'deleted' || e.status === 'superseded') return 'gone'      // 删过的不再删一次（不然一直删就能把墓碑刷掉）
    doc.tombstones.push({ n: tick(doc), kind: e.kind, hash: e.text ? fp(e.text) : null, msgId: e.msgId ?? null, evidence: e.evidence ?? null, at: new Date().toISOString(), by, reason: norm(reason).slice(0, 80) })
    Object.assign(e, { status: 'deleted', text: '', her: '', deletedAt: new Date().toISOString(), deletedBy: by })
    return 'ok'
  })
  if (saved === 'missing') throw new Error('没有这条记忆')
  if (saved === 'not-sdm') throw new Error(NOT_SDM)
  if (saved === 'gone') throw new Error('这条已经删掉或纠正过了')
  return { result: 'ok' }
}

/**
 * 纠正一条笔记：旧的作废（只留墓碑），新的接上（记着它纠正的是哪一条）。
 * 私密：原来私密的照旧私密；她改主人身上的笔记 → 改正的内容多半来自私信，一律私密（主人自己改的照原样）。
 * 陌生人那条路记下的（origin sdm）改完照旧私密、照旧标 origin sdm；origin 'sdm' = 在陌生人私信回合里改（只能改那条路记下的，审查 #1）
 */
export function correct({ uid, id, text, by = 'her', owner = '', origin = '' }) {
  assertUid(uid)
  const t = norm(text)
  if (!t || t.length > NOTE_MAX) throw new Error(`纠正后的内容要是一句话（最多 ${NOTE_MAX} 字）`)
  if (SENSITIVE.test(fold(t))) throw new Error('不记联系方式、证件号、住址这类信息')
  const neu = { id: newId(), uid: String(uid), at: new Date().toISOString(), channel: 'note', text: t, by }
  const saved = updateUser(uid, (doc) => {
    const e = doc.entries.find((x) => x.id === id)
    if (!e || !NOTE_KINDS.includes(e.kind)) return 'missing'
    if (origin === 'sdm' && !isSdm(e)) return 'not-sdm'
    if (e.status === 'deleted' || e.status === 'superseded') return 'gone'
    if (fp(t) === fp(e.text)) return 'same'
    if (buried(doc, { kind: e.kind, hash: fp(t) })) return 'buried'          // 不能「纠正」回删掉 / 纠正过的内容
    doc.tombstones.push({ n: tick(doc), kind: e.kind, hash: fp(e.text), msgId: null, evidence: e.evidence ?? null, at: new Date().toISOString(), by, reason: '已纠正' })
    const vis = isSdm(e) || e.visibility === 'private' || (owner && String(uid) === String(owner) && by !== 'owner') ? 'private' : e.visibility
    Object.assign(neu, { kind: e.kind, visibility: vis, evidence: e.evidence ?? null, thread: e.thread ?? null, status: e.kind === 'todo' ? 'open' : 'active', corrects: e.id })
    if (isSdm(e)) neu.origin = 'sdm'
    Object.assign(e, { status: 'superseded', text: '', supersededBy: neu.id, supersededAt: new Date().toISOString() })
    neu.n = tick(doc)
    doc.entries.push(neu)
    return 'ok'
  })
  if (saved === 'missing') throw new Error('没有这条笔记（交流记录不能改，只能删）')
  if (saved === 'not-sdm') throw new Error(NOT_SDM)
  if (saved === 'gone') throw new Error('这条已经删掉或纠正过了')
  if (saved === 'same') throw new Error('改正后的内容和原来一样')
  if (saved === 'buried') throw new Error('不能改回删掉或纠正过的内容')
  return { result: 'ok', id: neu.id }
}

/** 待办做完了。origin 'sdm' = 在陌生人私信回合里（只能动那条路记下的） */
export function closeTodo({ uid, id, origin = '' }) {
  assertUid(uid)
  const saved = updateUser(uid, (doc) => {
    const e = doc.entries.find((x) => x.id === id && x.kind === 'todo')
    if (!e) return 'missing'
    if (origin === 'sdm' && !isSdm(e)) return 'not-sdm'
    e.status = 'done'; e.doneAt = new Date().toISOString()
    return 'ok'
  })
  if (saved === 'missing') throw new Error('没有这条待办')
  if (saved === 'not-sdm') throw new Error(NOT_SDM)
  return { result: 'ok' }
}

// 简单的关键词重合：中文按两个字一组、英文按词
const grams = (s) => {
  const t = fold(s)
  const out = new Set()
  for (const w of t.match(/[a-z0-9]{2,}/g) ?? []) out.add(w)
  const han = t.replace(/[^\p{Script=Han}]/gu, '')
  for (let i = 0; i + 1 < han.length; i += 1) out.add(han.slice(i, i + 2))
  return out
}
const overlap = (a, b) => { let n = 0; for (const g of a) if (b.has(g)) n += 1; return n }
const label = { exchange: '以前聊过', said: '主人私信', inbound: 'TA 私信说', preference: 'TA 说过的偏好', guess: '推测·没确认', todo: '答应过的事' }
// 主人在 QQ 上说的：标成「主人QQ」；她在 QQ 上回过的交流记录：日期后面加「 · QQ」
const labelOf = (e) => (e.kind === 'said' && e.channel === 'qq' ? '主人QQ' : label[e.kind] ?? e.kind)
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }   // 本地日期
const where = (e) => e.target?.bvid ? ` · ${e.target.bvid}` : e.target?.dyn ? ` · 动态 ${e.target.dyn}` : ''
// 放在行首（行太长被截断时也还在）
const DISPUTED = '（⚠ 据这条记过的笔记被纠正 / 删掉过，别再据它下结论）'
// 存下来的原话是别人写的：括号一律换成圆括号、引号换成『』—— 一段旧评论既跳不出「」，也拼不出「[标签 · 日期]」或【标题】
const safe = (s) => String(s ?? '').replace(/[【〖［[]/g, '（').replace(/[】〗］\]]/g, '）').replace(/「/g, '『').replace(/」/g, '』')
const line = (e, disputed = new Set()) => (e.msgId && disputed.has(e.msgId) ? DISPUTED : '') + (e.kind === 'exchange'
  ? `[${label.exchange} · ${day(e.at)}${e.channel === 'qq' ? ' · QQ' : isSdm(e) ? ' · 私信' : ''}${where(e)}] TA：「${safe(e.text)}」${e.her ? ` / 你回：「${safe(e.her)}」` : ''}`
  : `[${labelOf(e)} · ${day(e.at)}] ${safe(e.text)}`)
/** 按长度上限装行：放不下的那行截断（不整条丢）；剩下的地方太小就停 */
function fit(cands, budget) {
  const lines = []
  let used = 0, truncated = false
  for (const l of cands) {
    const room = budget - used - 1
    if (room < 24) { truncated = true; break }
    const s = l.length > room ? l.slice(0, room - 1) + '…' : l
    if (s !== l) truncated = true
    lines.push(s); used += s.length + 1
  }
  return { lines, used, truncated }
}

/**
 * 回复前取记忆：先当前线程近期的交流（各人的，只要公开的），再这个人少量相关的记忆。
 * scope：public（默认，公开回复用，不含私密）· owner-dm（只对主人本人、在私信里用，含私信）·
 *        peer-dm（陌生人私信回合：peer 必须就是 uid、不是主人；TA 公开的 + 陌生人那条路记下的，没有线程那一段，主人私信、QQ 上的一条都没有）
 * 返回 { text, lines, truncated }；text 不超过 maxChars
 */
export function recall({ uid, thread = null, q = '', scope = 'public', owner = '', peer = '', maxChars = 1200, maxThread = 6, maxUser = 5, logsBefore = null }) {
  assertUid(uid)
  if (scope !== 'public' && scope !== 'owner-dm' && scope !== 'peer-dm') throw new Error('scope 只能是 public / owner-dm / peer-dm')
  if (scope === 'owner-dm' && (!owner || String(uid) !== String(owner))) throw new Error('私信范围只能用在主人本人身上')
  // peer-dm 认不准就不给（fail-closed）：认不出主人、peer 不是这个人、这个人就是主人 —— 都不取
  if (scope === 'peer-dm' && (!owner || !peer || String(peer) !== String(uid) || String(uid) === String(owner))) throw new Error('陌生人私信范围只能用在宿主绑定的那个人身上（不是主人）')
  const alive = (e) => e.status !== 'deleted' && e.status !== 'superseded' && e.status !== 'done'
  const visible = (e) => alive(e) && (scope === 'owner-dm' || (scope === 'peer-dm' ? peerVisible(e) : e.visibility === 'public' && !isSdm(e)))
  const qg = grams(q)
  // ① 当前线程最近的交流（各人的，只要公开的；从新往旧挑，最后按时间顺序给）—— 陌生人私信回合没有这一段
  const threadCands = []
  if (thread && scope !== 'peer-dm') {
    let refs = []
    try { refs = JSON.parse(fs.readFileSync(threadFile(thread), 'utf8')).refs ?? [] } catch {}
    const cache = new Map()
    const docOf = (u) => { if (!cache.has(u)) { try { cache.set(u, loadUser(u)) } catch { cache.set(u, emptyDoc(u)) } } return cache.get(u) }
    for (const r of refs.slice(-maxThread * 3).reverse()) {
      if (!uidOk(r.uid)) continue
      const d = docOf(r.uid)
      const e = d.entries.find((x) => x.id === r.id)
      if (e && visible(e) && e.visibility === 'public') threadCands.push({ id: e.id, text: `(这条线程) ${String(e.uid) === String(uid) ? '' : `UID ${e.uid} · `}${line(e, disputedOf(d))}` })
      if (threadCands.length >= maxThread) break
    }
  }
  // ② 这个人：偏好（最要紧：过敏、忌讳这类 —— 单独排在最前，后来的待办再多也挤不掉）、待办、推测、以前的交流，
  //    各自按「和眼前这条有多相关 + 多新」排
  const doc = loadUser(uid)
  const dis = disputedOf(doc)
  const rank = (arr, text) => arr.map((e, i) => ({ e, s: overlap(qg, grams(text(e))) * 10 + i / Math.max(1, arr.length) })).sort((a, b) => b.s - a.s).map((x) => x.e)
  const mineFor = (exclude) => {
    const live = doc.entries.filter((e) => visible(e) && !exclude.has(e.id))
    const prefs = rank(live.filter((e) => e.kind === 'preference'), (e) => e.text).slice(0, 3)
    const todos = rank(live.filter((e) => e.kind === 'todo'), (e) => e.text).slice(0, Math.max(1, maxUser - prefs.length))
    const guesses = rank(live.filter((e) => e.kind === 'guess'), (e) => e.text).slice(0, 2)
    // logsBefore：只要这个时间以前的交流 / 私信（刚聊过的已经在她的会话里，再给一遍容易被当成新消息又回一次）。
    // 陌生人私信里 TA 发来的那条（inbound）已经在她回过的交流记录里了 → 不重复给
    const answered = new Set(live.filter((e) => e.kind === 'exchange').flatMap((e) => [e.msgId, ...(Array.isArray(e.theirMsgIds) ? e.theirMsgIds : [])]).filter(Boolean))
    const logs = rank(live.filter((e) => isLog(e.kind) && !(e.kind === 'inbound' && answered.has(e.msgId)) && (!logsBefore || String(e.at) < String(logsBefore))),
      (e) => `${e.text} ${e.her ?? ''}`).slice(0, Math.max(2, maxUser - prefs.length - todos.length))
    // 陌生人私信回合（peer-dm）：私信里记的那几条行首带编号 —— 每回合是新会话，记的时候打印的编号早就没了，forget / correct / done 只能从这里拿
    return [...prefs, ...todos, ...guesses, ...logs].map((e) => (scope === 'peer-dm' && isSdm(e) ? `${e.id} ` : '') + line(e, dis))
  }
  // 长度上限：这个人自己的记忆至少留一半地方（地方很小时至少 80 字），线程用剩下的；
  // 线程里没放进来的那几条（包括这个人自己在这条线程里说过的）照样可以出现在这个人的旧交流里
  const reserve = threadCands.length ? fit(mineFor(new Set()), Math.min(maxChars, Math.max(Math.floor(maxChars / 2), 80))).used : 0
  const th = fit(threadCands.map((c) => c.text), maxChars - reserve)
  const mine = fit(mineFor(new Set(threadCands.slice(0, th.lines.length).map((c) => c.id))), maxChars - th.used)
  const lines = [...th.lines.reverse(), ...mine.lines]
  return { lines, text: lines.join('\n'), truncated: mine.truncated || th.truncated, names: (doc.names ?? []).map((x) => x.name) }
}

/** 给主人 / 调试看：一个人的全部条目（不过滤；删掉的只剩墓碑） */
export function showUser(uid) { return loadUser(uid) }
