// 发言账本（~/.bili-ai/quota.json）的读写和额度判断 —— 发言工具在自己的进程里直接调用（不再起一个 quota.mjs 子进程）。
//
// 为什么改成「预留 → 落账」（2026-10-22，Astra 审查）：
//   以前是「check 额度 → 发网络请求 → 成功了再 record」。同时发两条，两边 check 都看到额度还剩 1 → 都发出去了，账上记两条。
//   现在：发之前在账本锁里「判断 + 先记一条 pending 预留」一步做完 → 别的发言再来判断时已经数上这一条；
//         发成功 commit（落账）；明确失败 release（撤掉预留）；结果不确定（网络异常 / 进程崩了）→ 预留留着，照样占额度。
// 为什么不走 CLI：她能直接跑 `node bili.mjs quota …`，要是 release / record 也能从命令行跑，她就能自己撤掉已经发出去的账。
//   所以改账本的操作只在发言工具的进程里做；命令行在她的会话里只剩只读的 status / check / silence（见 quota.mjs）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config, autoDailyOf, shareDailyOf, capText, shareEnabled, silenceDays, silentDaysOf, reactionUnreadable } from './config.mjs'
import { HOME, isAgent } from './paths.mjs'
import { withFileLock, updateJsonLocked, renameRetry } from './filelock.mjs'

export const QUOTA_FILE = path.join(HOME, '.bili-ai', 'quota.json')
export const FEEDBACK_FILE = path.join(HOME, '.bili-ai', 'feedback.json')
const LOCK = QUOTA_FILE + '.lock'

export const today = () => new Date().toLocaleDateString('sv-SE')
// ⚠️ 账本里的 at 是 UTC ISO 串 → 统一先转成本地日期再比（凌晨 0–8 点不会被算成"昨天"）
export const dayOf = (at) => new Date(at).toLocaleDateString('sv-SE')

/** 读账本。文件存在但坏了 = 状态未知（corrupt）→ 判断一律拒绝、也不覆盖写（以前坏了会被当成"今天没发过"并被重写清零） */
export function loadLedger() {
  let raw = {}
  let corrupt = false
  try { raw = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')) } catch { if (fs.existsSync(QUOTA_FILE)) corrupt = true }
  const q = { daily: config().quota?.daily ?? 2, scope: config().quota?.scope ?? [], shareDaily: config().quota?.shareDaily ?? 3, log: Array.isArray(raw?.log) ? raw.log : [] }
  return { q, corrupt }
}
export function saveLedger(q) {
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true })
  const tmp = QUOTA_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ log: q.log ?? [] }, null, 2) + '\n')
  renameRetry(tmp, QUOTA_FILE)   // Windows 上别的进程（本地面板、主人的编辑器）正读着时改名会短暂 EPERM：重试，别让发出去的那条卡在「预留中」
}
/** 在账本锁里读 → 改 → 写。fn 返回 false 就不写回 */
export function withLedger(fn) {
  return withFileLock(LOCK, () => {
    const { q, corrupt } = loadLedger()
    const r = fn(q, corrupt)
    if (r?.save !== false && !corrupt) saveLedger(q)
    return r
  }, { busy: '发言账本正被占着（另一条发言正在记账），稍后再试' })
}

export const loadFeedback = () => {
  try {
    const j = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ...j, events: Array.isArray(j.events) ? j.events : [] }   // 写坏成 null / 数组：当成没有记录（以前 null 让分享检查和每次叫醒都崩，2026-10-25 审查）
  } catch {}
  return { last: null, events: [] }
}
/**
 * 写反馈记录：在锁里和磁盘上最新的那份合并再原子写回（以前直接覆盖：她的 react --auto 查网络那几秒里主人那边记的表态会被冲掉）。
 * 时间取较新的，事件取并集
 */
export const saveFeedback = (f) => updateJsonLocked(FEEDBACK_FILE, (cur0) => {
  // 文件写坏成 null / 数组 / 一串字、events 不是数组：从空的开始合并（以前 null 让 react —— 修它的那条命令 —— 自己就崩了，第五轮审查）
  const cur = cur0 && typeof cur0 === 'object' && !Array.isArray(cur0) ? cur0 : {}
  const later = (a, b) => ((Date.parse(a ?? '') || 0) >= (Date.parse(b ?? '') || 0) ? a : b) ?? null
  const seen = new Set(), events = []
  for (const e of [...(Array.isArray(cur.events) ? cur.events : []), ...(Array.isArray(f.events) ? f.events : [])]) {
    const k = `${e?.at ?? ''}|${e?.note ?? ''}|${e?.kind ?? ''}`
    if (!seen.has(k)) { seen.add(k); events.push(e) }
  }
  events.sort((a, b) => (Date.parse(a?.at ?? '') || 0) - (Date.parse(b?.at ?? '') || 0))
  const likeT = Math.max(Number(cur.lastLikeTime ?? 0), Number(f.lastLikeTime ?? 0))
  return { ...cur, ...f, last: later(cur.last, f.last), askedAt: later(cur.askedAt, f.askedAt), ...(likeT ? { lastLikeTime: likeT } : {}), events: events.slice(-200) }
}, { last: null, events: [] })

/** 沉默衰减：从来没反馈过就从"第一次分享"算；返回 { days, cap, penalty, band, asked, … }（2026-10-18 主人定：3 天开始降、7 天降到 0） */
export function silence(q) {
  const fb = loadFeedback()
  // 天数写坏了用默认 3 / 7；最后一次表态的时间读不出来（空串、0、乱码）就按「已经停了」算 ——
  // 以前这几种要么算出 NaN、要么当成刚表态过，上限整个失效（2026-10-25 第二、三轮审查）。唤醒提示用同一套（silentDaysOf）
  const { after, stopAt } = silenceDays(config().share)
  const days = silentDaysOf(fb.last, q.log.find((x) => x.share)?.at ?? null, stopAt)
  const baseCap = shareDailyOf(q.shareDaily)   // Infinity = 不限；不是数字按默认的 3（以前 NaN 一路算下去，分享等于不限）
  // 不限的时候沉默也照样降：从默认的 3 条往下降（2026-10-25 主人定：上限放开，沉默衰减保留）
  const decayFrom = Number.isFinite(baseCap) ? baseCap : 3
  let cap
  if (days < after) cap = baseCap
  else if (days >= stopAt) cap = 0
  else cap = Math.min(baseCap, Math.max(1, Math.floor((decayFrom * (stopAt - days)) / (stopAt - after))))
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))
  return { days, last: fb.last, unreadable: reactionUnreadable(fb.last), base: baseCap, penalty: cap === baseCap ? 0 : baseCap - cap, cap, band, asked, askedAt: fb.askedAt ?? null }
}

/** 她的会话里一切发言都按「她自己决定的」算（不带 --auto 也是）；分享型另算 */
export const normalize = (o) => ({ ...o, share: !!o.share, auto: !!o.auto || (isAgent() && !o.share) })

/**
 * 能不能发（只判断，不改账本）。返回 { ok, lines }。规则：
 *   分享型：每天合计 ≤ shareDaily（受沉默衰减）、同一视频 7 天一次、分享总开关
 *   自主发动态：每天 ≤ studio.dynamicDaily
 *   自主评论 / 弹幕：quota.autoDaily > 0 时每天各 ≤ autoDaily
 *   pending（预留中）和 uncertain（结果不确定）的条目都算已用
 */
export function decide(q, corrupt, o) {
  const { type, target = '', auto, share } = normalize(o)
  if (corrupt) return { ok: false, lines: ['✗ 额度账本损坏（quota.json 不是合法 JSON）→ 状态未知，拒绝发言。', `   修法：检查 ${QUOTA_FILE}；确认无误后可删掉它（⚠️ 删 = 当天额度从 0 重算）`] }
  const todays = q.log.filter((x) => dayOf(x.at) === today())
  if (share) {
    if (!shareEnabled(config())) return { ok: false, lines: ['✗ 分享已关闭'] }   // 整段写坏了 / 开关写成「关」也算关（2026-10-25 审查）
    // 上限不是数字（手改配置填成「3条」）就用默认值：以前拿 NaN 去比，永远比不过，等于不限（2026-10-24 审查）
    // 0 = 不限（2026-10-25）；不是数字（「3条」）按默认 3（2026-10-24 审查）—— 同一套读法见 tools/lib/config.mjs shareDailyOf
    const shareDaily = shareDailyOf(q.shareDaily)
    const sil = silence(q)
    const capNow = Math.min(shareDaily, sil.cap)
    const effCap = Number.isNaN(capNow) ? 0 : capNow   // 算不出来就不发（不能当成不限）
    const lines = sil.penalty > 0 ? [sil.unreadable ? '  [沉默衰减] 主人最后一次表态的记录读不出来（feedback.json 坏了）→ 先按已经停了算（已停止分享；日记照常）—— 请主人跑 node host/cli.mjs react 修好' : `  [沉默衰减] ${sil.days} 天没有任何表态 → 分享上限 ${capText(shareDaily)} → ${capText(effCap)}${effCap === 0 ? '（已停止分享；日记照常）' : ''}`] : []
    const usedShare = todays.filter((x) => x.share).length
    if (usedShare >= effCap) return { ok: false, lines: [...lines, `✗ 分享额度已用完：今天已经 @ 了 ${usedShare} 条（有效上限 ${capText(effCap)}）—— 剩下的留给明天，别硬发。`] }
    if (target) {
      const dup = q.log.find((x) => x.share && String(x.target ?? '') === String(target) && Date.now() - new Date(x.at).getTime() < 7 * 86_400_000)
      if (dup) return { ok: false, lines: [...lines, `✗ 这个视频 7 天内已经分享过了：${dup.at}（${dup.target}）`] }
    }
    return { ok: true, lines: [...lines, `✓ 分享额度内（${usedShare}/${capText(effCap)}）${target ? `，target=${target}` : ''} —— 同一视频 7 天内只能一次`] }
  }
  if (auto && type === 'dynamic') {
    const ddNum = Number(config().studio?.dynamicDaily ?? 2)
    const cap = Number.isFinite(ddNum) ? ddNum : 2
    const used = todays.filter((x) => x.auto && x.type === 'dynamic').length
    if (used >= cap) return { ok: false, lines: [`✗ 今天的动态额度用完了（${used}/${cap}）—— 明天再发`] }
  }
  const adRaw = config().quota?.autoDaily   // 没写 = 默认值（autoDailyOf 里给）
  const autoDaily = autoDailyOf(adRaw)   // 和存配置同一套读法（tools/lib/config.mjs）
  // 0 或负数 = 不限（旧版本存的 -1 就是这个意思）；不是数字 = 主人想设上限但写错了：先不发（以前 NaN > 0 不成立，等于不限）
  if (auto && (type === 'comment' || type === 'danmaku') && !Number.isFinite(autoDaily)) {
    return { ok: false, lines: [`✗ 配置里 quota.autoDaily 不是数字（${String(adRaw).slice(0, 20)}）→ 不知道上限是多少，先不发 —— 请主人改成数字（0 = 不限）：node host/cli.mjs config set quota.autoDaily 0`] }
  }
  if (auto && (type === 'comment' || type === 'danmaku') && autoDaily > 0) {
    const used = todays.filter((x) => x.auto && !x.share && x.type === type).length
    if (used >= autoDaily) return { ok: false, lines: [`✗ 今天自己发的${type === 'comment' ? '评论' : '弹幕'}到上限了（${used}/${autoDaily}）—— 明天再说`] }
  }
  if (!auto) return { ok: true, lines: ['（非自主发言：不拦截）主人授权的发言不受限，但照旧 dry→go→复核'] }
  return { ok: true, lines: [`✓ 通过${target ? ` · target=${target}` : ''}`] }
}

/** 只判断（dry 阶段、编辑动态用） */
export function checkSpeech(o) {
  const { q, corrupt } = loadLedger()
  return decide(q, corrupt, o)
}

/** 判断 + 预留，一步在锁里做完。返回 { ok, lines, rid } */
export function reserveSpeech(o) {
  const n = normalize(o)
  return withLedger((q, corrupt) => {
    const d = decide(q, corrupt, n)
    if (!d.ok) return { ...d, save: false }
    const rid = crypto.randomBytes(8).toString('hex')
    q.log.push({ at: new Date().toISOString(), type: n.type, auto: n.auto || n.share, share: n.share, target: n.target ?? null, note: n.note ? String(n.note).slice(0, 40) : null, pending: true, rid })
    return { ...d, rid }
  })
}

/** 发成功：落账（预留找不到了也补记一条 —— 发出去的一定要算上） */
export function commitSpeech(rid, patch = {}) {
  return withLedger((q) => {
    const e = rid ? q.log.find((x) => x.rid === rid) : null
    const fields = Object.fromEntries(Object.entries({ target: patch.target, note: patch.note ? String(patch.note).slice(0, 40) : undefined }).filter(([, v]) => v != null))
    if (e) { delete e.pending; Object.assign(e, fields, { committedAt: new Date().toISOString() }) }
    else q.log.push({ at: new Date().toISOString(), type: patch.type ?? 'unknown', auto: true, share: !!patch.share, target: patch.target ?? null, note: fields.note ?? null })
    return { ok: true }
  })
}

/** 明确没发出去：撤掉预留。uncertain = 不知道发没发出去 → 预留留着照样占额度（只是标记一下） */
export function releaseSpeech(rid, { uncertain = false } = {}) {
  if (!rid) return { ok: true }
  return withLedger((q) => {
    const i = q.log.findIndex((x) => x.rid === rid && x.pending)
    if (i < 0) return { ok: true, save: false }
    if (uncertain) { delete q.log[i].pending; q.log[i].uncertain = true } else q.log.splice(i, 1)
    return { ok: true }
  })
}

/** 直接记一条（主人那边：视频发布等；以及没走预留的老路径） */
export function recordSpeech(o) {
  const n = normalize(o)
  return withLedger((q, corrupt) => {
    if (corrupt) return { ok: false, save: false, lines: ['✗ 额度账本损坏，没记上（不会覆盖坏掉的账本）'] }
    q.log.push({ at: new Date().toISOString(), type: n.type ?? 'unknown', auto: n.auto || n.share, share: n.share, target: n.target ?? null, note: n.note ? String(n.note).slice(0, 40) : null })
    return { ok: true }
  })
}
