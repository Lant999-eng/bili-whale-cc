// 看片记录（2026-10-23）：她看过哪条视频、每样素材取没取到、她看懂了什么、对这条视频做了什么。
//
// 参考 chenluQwQ/bilibili-ai-bot 的 watch_log 思路，补上它没有的几件事：
//   ① 每样素材单独记「取到了 / 这条视频没有 / 没取到（为什么）/ 这次没取」—— 不是一句笼统的「看过了」
//   ② 看的范围由工具按记下的素材算，不由她说；取到过的文件不见了、最近一次又没取到、多 P 只取了 P1，都照实标出来
//   ③ 她记理解时，工具把当时的范围一起盖上；什么都没取到时不让记「看懂了什么」—— 不编
//   ④ 只记她自己的会话里取的（主人自己跑工具不算她看过）
//
// 放在 ~/.bili-ai/watch/：主人那边，她的会话读写不了；只有她的工具（debrief / subtitles / watch-video / video / comments）
// 和 `node bili.mjs watched` 改它。记不上（磁盘满、文件坏了）不影响她看片：所有写入都吞掉错误。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { homePath, isAgent } from './paths.mjs'
import { updateJsonLocked } from './filelock.mjs'

export const WATCH_DIR = homePath('.bili-ai', 'watch')
export const BV_RE = /^BV[0-9A-Za-z]{10}$/
export const MATERIALS = { meta: '标题 / 简介', cover: '封面', subtitles: '字幕', danmaku: '弹幕', comments: '评论', frames: '画面（抽帧）', audio: '听写（本机转写的声音）' }
// 听写（2026-10-26，listen）是后加的、可选的：没听过的视频，范围、「还缺什么」都照以前那样说，不多出一样「没取」
const OPTIONAL = new Set(['audio'])
const STATUS = new Set(['ok', 'none', 'failed', 'skipped'])
export const NOTE_MAX = 600
const NOTES_KEPT = 10
const ch = (...cs) => cs.map((c) => String.fromCharCode(c)).join('')
// 控制字符、改方向字符、看不见的方向标记、Unicode 换行 —— 一律换成空格（她写的笔记会被原样打给她自己和主人看，不能借换行冒充工具写的行）
const INVISIBLE = new RegExp('[' + ch(0) + '-' + ch(0x1f) + ch(0x7f) + '-' + ch(0x9f) + ch(0x200e, 0x200f, 0x061c, 0x2028, 0x2029) + ch(0x202a) + '-' + ch(0x202e) + ch(0x2066) + '-' + ch(0x2069) + ']', 'g')
const clean = (s, n) => { const t = String(s ?? '').replace(INVISIBLE, ' ').replace(/ {2,}/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
/** 本地时间（YYYY-MM-DD HH:MM），和面板、账本一样 */
export const localTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '?' : d.toLocaleString('sv-SE', { hour12: false }).slice(0, 16) }
// BV 号区分大小写，Windows 的文件名不区分：文件名后面加一段「哪几个字母是大写」，两条只差大小写的视频不会撞到一个文件
const caseMask = (bv) => BigInt('0b1' + Array.from(bv).map((c) => (c >= 'A' && c <= 'Z' ? '1' : '0')).join('')).toString(36)
const watchFile = (bv) => path.join(WATCH_DIR, `${bv}-${caseMask(bv)}.json`)
const sha1 = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') } catch { return null } }
/** 素材的名字：「标题 / 简介」只在真的给她看了简介时这么说（debrief / video），别的工具只给了标题 */
export const materialName = (k, m) => (k === 'meta' && m && !m.desc && !m.lastTry?.desc ? '标题' : MATERIALS[k])
export const watchFilePath = (bv) => (BV_RE.test(String(bv ?? '')) ? watchFile(bv) : null)

/** 读一条视频的记录；没有 = null，读不出来 = { corrupt: true } */
export function readWatch(bv) {
  if (!BV_RE.test(String(bv ?? ''))) return null
  try {
    const r = JSON.parse(fs.readFileSync(watchFile(bv), 'utf8').replace(new RegExp('^' + ch(0xfeff)), ''))
    return r && typeof r === 'object' && (!r.bvid || r.bvid === bv) ? r : { corrupt: true, bvid: bv }
  } catch (e) {
    return e?.code === 'ENOENT' ? null : { corrupt: true, bvid: bv }
  }
}

/**
 * 工具取素材时记一笔（只在她的会话里记）：kind ∈ MATERIALS；info = { status: ok | none（这条视频本来就没有）| failed（取了没取到）| skipped（这次没取）,
 *   why?, count?, file?, via（哪个工具）, title?, owner?, duration?, aid?, parts?（一共几 P）, part?（取的是第几 P） }
 * 同一样素材：取到过（ok）就不会被后来的失败 / 没取盖掉 —— 以前取到的文件还在，还算有（但会记下最近一次的结果，范围里照实说）
 */
export function recordMaterial(bv, kind, info = {}) {
  if (!isAgent()) return false   // 主人自己跑工具不算她看过
  if (!BV_RE.test(String(bv ?? '')) || !MATERIALS[kind] || !STATUS.has(info.status)) return false
  try {
    fs.mkdirSync(WATCH_DIR, { recursive: true })
    const at = new Date().toISOString()
    updateJsonLocked(watchFile(bv), (rec) => {
      if (rec.bvid && rec.bvid !== bv) throw new Error('记录文件不是这条视频的')
      rec.version = 1
      rec.bvid = bv
      rec.firstAt = rec.firstAt ?? at
      rec.lastAt = at
      if (info.title) rec.title = clean(info.title, 120)
      if (info.owner) rec.owner = clean(info.owner, 60)
      if (/^\d{1,20}$/.test(String(info.aid ?? ''))) rec.aid = String(info.aid)   // 评论记账时可能记的是 oid（av 号）
      if (Number.isFinite(Number(info.duration)) && Number(info.duration) > 0) rec.duration = Number(info.duration)
      if (Number.isInteger(Number(info.parts)) && Number(info.parts) > 0) rec.parts = Number(info.parts)
      rec.materials = rec.materials ?? {}
      const prev = rec.materials[kind]
      const entry = { status: info.status, at, via: clean(info.via, 30) || null }
      if (info.why) entry.why = clean(info.why, 160)
      if (Number.isFinite(Number(info.count))) entry.count = Number(info.count)
      // 听写听了多少秒、有没有听全（只听了前几分钟 / 字数到上限没列完）
      if (kind === 'audio' && Number.isFinite(Number(info.seconds))) entry.seconds = Math.round(Number(info.seconds))
      if (kind === 'audio' && info.partial === true) entry.partial = true
      // 记下文件的指纹：Windows 上只差大小写的两条视频会写到同一个封面 / 字幕文件，指纹对不上就不算这条的
      if (info.file) { entry.file = String(info.file); const h = sha1(info.file); if (h) entry.sha1 = h }
      if (kind === 'meta' && info.desc) entry.desc = true
      if (kind === 'meta' && prev?.status === 'ok' && info.status === 'ok' && prev.desc) entry.desc = true   // 以前给她看过简介的，还算看过
      if (Number.isInteger(Number(info.part)) && Number(info.part) > 0) entry.part = Number(info.part)
      if (prev?.status === 'ok' && info.status !== 'ok') rec.materials[kind] = { ...prev, lastTry: entry }   // 取到过的不被盖掉
      else rec.materials[kind] = entry
      return rec
    }, {})
    return true
  } catch { return false }
}

/** 这样素材「现在手上有」：取到过，而且记下的文件还在（没记文件的按取到算） */
const have = (m) => m?.status === 'ok' && (!m.file || (fs.existsSync(m.file) && (!m.sha1 || sha1(m.file) === m.sha1)))
export { have as onHand }
/** 多 P 视频只查了 P1：「这条视频没有」要说成「P1 没有」 */
export const noneWhy = (rec, x) => { const w = x?.why || '这条视频没有'; return rec?.parts > 1 && x?.part ? w.replace('这条视频', 'P1 ') : w }

/**
 * 看的范围（按记下的素材算，不由她说）→ { key, label, saw: [...], missing: [...], stale: [...] }
 *   key：text+image（字幕 + 画面）· text（只有字幕）· image（只有画面）· thin（只有标题 / 简介 / 封面 / 弹幕 / 评论）· none（什么都没有）
 *   stale：以前取到过、最近一次又没取到的（文件还在，但不是这次取到的）
 */
export function scopeOf(rec) {
  const m = rec?.materials ?? {}
  const ok = (k) => have(m[k])
  const saw = Object.keys(MATERIALS).filter(ok).map((k) => materialName(k, m[k]))
  const why = (k) => {
    const x = m[k]
    if (!x) return '没取'
    if (x.status === 'ok') return '以前取到过，文件不见了 / 被别的视频覆盖了'
    if (x.status === 'none') return noneWhy(rec, x)
    if (x.status === 'skipped') return '这次没取' + (x.why ? '：' + x.why : '')
    return '没取到' + (x.why ? '：' + x.why : '')
  }
  const missing = Object.keys(MATERIALS).filter((k) => !ok(k) && (!OPTIONAL.has(k) || m[k])).map((k) => `${materialName(k, m[k])}（${why(k)}）`)
  const stale = Object.keys(MATERIALS).filter((k) => ok(k) && m[k].lastTry && m[k].lastTry.status !== 'ok').map((k) => materialName(k, m[k]))
  let key, label
  // 说了什么：字幕，没有字幕时她自己听写的也算（标明是听写）
  const words = ok('subtitles') ? '字幕' : ok('audio') ? (m.audio.partial ? '听写（本机转写，只听了一部分）' : '听写（本机转写）') : ''
  if (words && ok('frames')) { key = 'text+image'; label = `${words} + 画面` }
  else if (words) { key = 'text'; label = `只有${words}（画面没看）` }
  else if (ok('frames')) { key = 'image'; label = '只有画面（没有字幕：说了什么只能靠画面、弹幕、评论推测）' }
  else if (saw.length) { key = 'thin'; label = `只有${saw.join('、')}（没字幕、没看画面：内容只能算推测）` }
  else { key = 'none'; label = Object.values(m).some((x) => x?.status === 'failed' || x?.lastTry?.status === 'failed') ? '什么都没取到（加载失败）' : '什么都没取到' }
  // 多 P：字幕 / 画面 / 弹幕不管取到没有，都只查了 P1
  if (rec?.parts > 1 && ['subtitles', 'frames', 'danmaku', 'audio'].some((k) => m[k])) label += `（多 P 视频，共 ${rec.parts} P：${m.audio ? '字幕 / 画面 / 弹幕 / 听写' : '字幕 / 画面 / 弹幕'}只取了 P1）`
  if (stale.length) label += `（其中${stale.join('、')}是以前取到的，最近一次没取到）`
  return { key, label, saw, missing, stale }
}

/** 她记「看懂了什么」：工具盖上当时的范围；什么都没取到 → 不让记 */
export function addNote(bv, text) {
  if (!BV_RE.test(String(bv ?? ''))) return { ok: false, error: '不是 BV 号' }
  const t = clean(text, NOTE_MAX + 1)
  if (!t) return { ok: false, error: '没写内容' }
  if (t.length > NOTE_MAX) return { ok: false, error: `太长了（上限 ${NOTE_MAX} 字）：只记最要紧的` }
  const rec = readWatch(bv)
  if (rec?.corrupt) return { ok: false, error: '这条视频的记录文件读不出来 —— 请主人看一下' }
  const scope = scopeOf(rec)
  if (scope.key === 'none') {
    return { ok: false, error: rec ? `这条视频什么素材都没有（${scope.missing.join('；')}）—— 不能记「看懂了什么」。没看成就是没看成` : '还没取过这条视频的任何素材（先 debrief / subtitles / watch-video）—— 不能记「看懂了什么」' }
  }
  try {
    const at = new Date().toISOString()
    updateJsonLocked(watchFile(bv), (r) => {
      r.notes = [...(r.notes ?? []), { at, text: t, scope: scope.key, label: scope.label }].slice(-NOTES_KEPT)
      return r
    }, {})
    return { ok: true, scope }
  } catch (e) { return { ok: false, error: '没记上：' + clean(e?.message ?? e, 120) } }
}

/**
 * 这条视频她做过什么（只认代码记的账本）：评论 / 分享（额度账本）、私信分享给主人、收藏（收藏记录）。
 * 账本里普通评论的 BV 是她自己标的（只有分享发之前核对过），按 av 号记的也不知道是不是视频评论区 —— 这两种照实标「没核对」。
 * → { items: [...], corrupt: ['额度账本' | '收藏记录'] }
 */
export function actionsFor(bv, { quotaFile = homePath('.bili-ai', 'quota.json'), favFile = homePath('.bili-ai', 'favorites.json'), aid = null } = {}) {
  const items = [], corrupt = []
  const read = (f, name) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { if (e?.code !== 'ENOENT') corrupt.push(name); return null }
  }
  for (const x of read(quotaFile, '额度账本')?.log ?? []) {
    const byBv = x?.target === `BV:${bv}`, byAid = Boolean(aid) && x?.target === `oid:${aid}`
    if (!byBv && !byAid) continue
    const status = x.uncertain ? '结果不确定' : x.pending ? '没落账（可能没发成）' : '发出去了'
    if (x.type === 'comment') {
      const unverified = x.share ? '' : byBv ? '；视频是她自己标的，没核对' : '；按 av 号认的，没核对是不是视频评论区'
      items.push({ at: x.at, what: x.share ? '分享（评论 @主人）' : '评论', note: clean(x.note, 120), status: status + unverified })
    } else if (x.type === 'dm' && x.share) {
      items.push({ at: x.at, what: '私信分享（给主人）', note: clean(x.note, 120), status })
    }
  }
  for (const x of read(favFile, '收藏记录')?.items ?? []) {
    if (x?.bv !== bv) continue
    items.push({ at: x.at, what: '收藏', note: clean(x.reason, 120), status: x.pending ? '没确认（可能没收成）' : '收藏了' })
  }
  return { items: items.sort((a, b) => String(a.at).localeCompare(String(b.at))), corrupt }
}

/** 最后一次真的取到东西是什么时候（面板的「今天看过的」按这个算；只失败了的那次不算看过） */
export function lastOkAt(rec) {
  let best = null
  for (const x of Object.values(rec?.materials ?? {})) {
    if (x?.status === 'ok' && (!best || x.at > best)) best = x.at
    if (x?.lastTry?.status === 'ok' && (!best || x.lastTry.at > best)) best = x.lastTry.at
  }
  return best
}

/** 最近看过的（面板 / watched list 用）：最近一次真的取到东西在 sinceMs 之后的；读不出来的记录按文件修改时间算 */
export function recentWatches(sinceMs) {
  let files = []
  try { files = fs.readdirSync(WATCH_DIR) } catch { return [] }
  const out = []
  for (const f of files) {
    const m = /^(BV[0-9A-Za-z]{10})-([0-9a-z]+)\.json$/.exec(f)
    if (!m || caseMask(m[1]) !== m[2]) continue
    const rec = readWatch(m[1])
    if (!rec) continue
    if (rec.corrupt) {
      let mt = 0
      try { mt = fs.statSync(path.join(WATCH_DIR, f)).mtimeMs } catch {}
      if (mt >= sinceMs) out.push({ ...rec, lastOkAt: new Date(mt).toISOString() })
      continue
    }
    const ok = lastOkAt(rec)
    if (ok && Date.parse(ok) >= sinceMs) out.push({ ...rec, lastOkAt: ok })
  }
  return out.sort((a, b) => String(b.lastOkAt ?? '').localeCompare(String(a.lastOkAt ?? '')))
}

/** 「你之前看过这条」—— 再看同一条时工具先说：上次的范围、她当时怎么理解的（缓存的理解，不用从头再猜） */
export function previouslyLines(bv) {
  const rec = readWatch(bv)
  if (!rec || rec.corrupt || !rec.materials) return []
  const s = scopeOf(rec)
  const lines = [`（你之前看过这条：${localTime(rec.firstAt)} 起，最近 ${localTime(rec.lastAt)}；手上有的范围：${s.label}）`]
  const last = rec.notes?.at(-1)
  if (last) lines.push(`（你当时记的理解（当时的范围：${last.label}）：「${clean(last.text, NOTE_MAX)}」—— 这次取到的素材更全的话，以这次为准）`)
  return lines
}

/** 这一次（startedAt 之后）每样素材的结果：工具收尾时说「这次取到了什么」用 → { got: [...], notGot: [...] } */
export function thisRun(rec, startedAt) {
  const got = [], notGot = []
  for (const [k, name] of Object.entries(MATERIALS)) {
    const m = rec?.materials?.[k]
    if (!m) continue
    const latest = m.lastTry ?? m   // lastTry 一定是最近的那一次（不比时间：时钟可能被调过）
    if (!latest || latest.at < startedAt) continue
    if (latest.status === 'ok') got.push(materialName(k, m))
    else notGot.push(`${materialName(k, m)}（${latest.status === 'none' ? latest.why || '这条视频没有' : latest.status === 'skipped' ? '这次没取' + (latest.why ? '：' + latest.why : '') : '没取到' + (latest.why ? '：' + latest.why : '')}）`)
  }
  return { got, notGot }
}

/**
 * 字幕接口回了「空列表」时，到底是「这条视频没有字幕」还是「没拿到」：
 *   没登录 / 接口说要登录、接口说有 AI 字幕（或还在生成）、接口没正常回话 → 没拿到（failed），不是「没有」
 */
export function subtitleVerdict({ answered, loggedIn, aiStatus, needLogin }) {
  if (!answered) return { status: 'failed', why: '字幕接口没正常回话' }
  if (!loggedIn || needLogin) return { status: 'failed', why: '没登录 / 字幕要登录才给（不是「没有字幕」）' }
  if (Number(aiStatus) === 1) return { status: 'failed', why: '接口说有 AI 字幕，但没给出来' }
  if (Number(aiStatus) === 2) return { status: 'failed', why: 'AI 字幕还在生成' }
  return { status: 'none', why: '这条视频没有字幕轨道' }
}
