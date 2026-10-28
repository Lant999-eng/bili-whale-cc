// 视频编号（2026-10-24）：主人私信里分享的视频，常常是 av 号 / av 链接 / b23.tv 短链 / 视频卡片。
//   以前工具只认 BV 号 —— 她只好按标题搜，搜出二十条也不知道主人发的是哪条（主人截图里她只能回「发一下 BV 号？」）。
// 这里把这几种写法都换成 BV 号，工具照旧只拿 BV 号往下走（会拼进文件名、请求、账本）：
//   · BV 号：原样（照旧只认 BV + 10 位字母数字，区分大小写）
//   · av12345 / AV12345 / aid=12345 / B站 视频链接（/video/BV… 或 /video/av…，?bvid= / ?aid=）→ 本地按 B站 公开的 av↔BV 算法换算，不联网
//   · b23.tv 短链 → 问一次 b23.tv 跳到哪（不带 cookie、不跟着跳），跳到的必须是 B站 视频链接，再按上面换算
// 别的写法一律不认：不是整个参数就是一个编号 / 链接的（前后夹着字）、别的网站、带账号密码 / 端口的链接、超出范围的 av 号。
export const BV_RE = /^BV[0-9A-Za-z]{10}$/

// —— av ↔ BV（B站 2024 年起用的算法，覆盖到 2^51 的大 av 号；老 av 号换出来和以前一样） ——
const XOR_CODE = 23442827791579n
const MASK_CODE = 2251799813685247n            // 2^51 - 1
const MAX_AID = 1n << 51n
const BASE = 58n
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'

/** av 号 → BigInt（1 ≤ aid < 2^51，十进制、不带前导 0）；不合法 = null */
function toAid(x) {
  if (typeof x === 'bigint') return x > 0n && x < MAX_AID ? x : null
  if (typeof x === 'number') return Number.isSafeInteger(x) ? toAid(BigInt(x)) : null
  const s = String(x ?? '')
  return /^[1-9]\d{0,15}$/.test(s) ? toAid(BigInt(s)) : null
}

/** av 号 → BV 号；不合法 = null */
export function av2bv(aid) {
  const n = toAid(aid)
  if (n == null) return null
  const out = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0']
  let t = (MAX_AID | n) ^ XOR_CODE
  for (let i = out.length - 1; t > 0n; i -= 1) { out[i] = ALPHABET[Number(t % BASE)]; t /= BASE }
  ;[out[3], out[9]] = [out[9], out[3]]
  ;[out[4], out[7]] = [out[7], out[4]]
  return out.join('')
}

/** BV 号 → av 号（Number，2^51 以内都是精确的）；换不回同一个 BV 的（不是 B站 发的号）= null */
export function bv2av(bvid) {
  if (!BV_RE.test(String(bvid ?? ''))) return null
  const a = Array.from(bvid)
  ;[a[3], a[9]] = [a[9], a[3]]
  ;[a[4], a[7]] = [a[7], a[4]]
  let t = 0n
  for (const c of a.slice(3)) {
    const k = ALPHABET.indexOf(c)
    if (k < 0) return null
    t = t * BASE + BigInt(k)
  }
  const aid = (t & MASK_CODE) ^ XOR_CODE
  return av2bv(aid) === bvid ? Number(aid) : null
}

// —— 认写法（不联网） ——
const AV_RE = /^av([1-9]\d{0,15})$/i
const AID_RE = /^(?:aid|avid)=([1-9]\d{0,15})$/i
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'bili22.cn', 'bili23.cn', 'bili33.cn'])
const SITE_HOST = /^(?:(?:www|m|player)\.)?bilibili\.com$/
const bare = (h) => h.replace(/^www\./, '')
const fromAid = (digits, via) => { const bvid = av2bv(digits); return bvid ? { bvid, aid: Number(digits), via } : null }

/** 只认 http(s)、B站 / 短链的域名、不带账号密码和端口；没写 https:// 的也认（b23.tv/xxx、www.bilibili.com/video/…） */
function asUrl(s) {
  const t = /^https?:\/\//i.test(s) ? s
    : /^(?:(?:www|m)\.)?(?:bilibili\.com|b23\.tv|bili2233\.cn|bili2[23]\.cn|bili33\.cn)\//i.test(s) ? 'https://' + s : null
  if (!t) return null
  let u
  try { u = new URL(t) } catch { return null }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null
  return u
}

/**
 * 一个参数 → { bvid, aid?, via: 'bv' | 'av' | 'link' }；b23.tv 短链（要联网问）→ { short: 'https://b23.tv/<码>' }；不认识 = null。
 * 整个参数必须就是一个编号 / 一个链接（前后不许夹字）。
 */
export function parseVideoRef(input) {
  const s = String(input ?? '').trim()
  if (!s || s.length > 600) return null
  if (BV_RE.test(s)) return { bvid: s, via: 'bv' }
  const m = AV_RE.exec(s) ?? AID_RE.exec(s)
  if (m) return fromAid(m[1], 'av')
  const u = asUrl(s)
  if (!u) return null
  const host = bare(u.hostname.toLowerCase())
  if (SHORT_HOSTS.has(host)) {
    const code = u.pathname.replace(/^\/+|\/+$/g, '')
    if (BV_RE.test(code)) return { bvid: code, via: 'link' }
    const av = AV_RE.exec(code)
    if (av) return fromAid(av[1], 'link')
    return /^[0-9A-Za-z]{1,16}$/.test(code) ? { short: `https://${host}/${code}` } : null
  }
  if (!SITE_HOST.test(host)) return null
  const seg = /^\/(?:s\/)?video\/([^/]+)\/?/.exec(u.pathname)?.[1]
  if (seg != null) {
    if (BV_RE.test(seg)) return { bvid: seg, via: 'link' }
    const av = AV_RE.exec(seg)
    return av ? fromAid(av[1], 'link') : null
  }
  const q = u.searchParams
  if (BV_RE.test(q.get('bvid') ?? '')) return { bvid: q.get('bvid'), via: 'link' }
  const aid = q.get('aid') ?? q.get('avid')
  return /^[1-9]\d{0,15}$/.test(aid ?? '') ? fromAid(aid, 'link') : null
}

/** 不联网：认得出来就给 BV 号，不然 null（短链也是 null —— 要解析短链用 resolveVideoRef） */
export const toBvid = (input) => parseVideoRef(input)?.bvid ?? null

/** 一段话里第一个视频（给私信正文判「分享的是哪条」用）：BV 号 → B站 视频链接里的 av → 单独的 av12345；都没有 = null */
export function findBvid(text) {
  const s = String(text ?? '')
  const bv = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/.exec(s)?.[0]
  if (bv) return bv
  const av = /bilibili\.com\/(?:s\/)?video\/av([1-9]\d{0,15})(?!\d)/i.exec(s) ?? /(?<![0-9A-Za-z])av([1-9]\d{0,15})(?![0-9A-Za-z])/i.exec(s)
  return av ? av2bv(av[1]) : null
}

// —— 联网的那一步：b23.tv 短链 ——
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ch = (...cs) => cs.map((c) => String.fromCharCode(c)).join('')
const CTRL = new RegExp('[' + ch(0) + '-' + ch(0x1f) + ch(0x7f) + '-' + ch(0x9f) + ch(0x2028, 0x2029) + ch(0x202a) + '-' + ch(0x202e) + ch(0x2066) + '-' + ch(0x2069) + ']', 'g')
const clip = (s, n = 60) => { const t = String(s ?? '').replace(CTRL, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

/**
 * 一个参数 → { ok: true, bvid, aid?, via, note }（note：不是 BV 号写的，给她看换成了哪个 BV；BV 号原样 = ''）
 *          或 { ok: false, code, error }（code 2 = 不是视频编号 / 链接；3 = 短链没解析成：网络 / b23.tv 出错）。
 * 短链只问一次 b23.tv（GET、不带 cookie、不跟着跳）：读它回的跳转地址，必须是 B站 视频链接；跳到短链、别的网站、不是视频的页面都不认。
 */
export async function resolveVideoRef(input, { fetch: get = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const r = parseVideoRef(input)
  if (!r) return { ok: false, code: 2, error: `不是 BV 号、av 号或 B站 视频链接：${clip(input)}` }
  if (!r.short) {
    const note = r.via === 'bv' ? '' : r.via === 'av' ? `（av${r.aid} = ${r.bvid}）` : `（这个链接是 ${r.bvid}${r.aid ? `，也就是 av${r.aid}` : ''}）`
    return { ok: true, ...r, note }
  }
  let res
  try {
    res = await get(r.short, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return { ok: false, code: 3, error: `短链 ${r.short} 没解析成（${clip(e?.name === 'TimeoutError' ? '超时' : e?.message ?? e, 80)}）—— 请主人直接发 BV 号或完整的视频链接` }
  }
  try { await res.body?.cancel?.() } catch {}
  const loc = String(res.headers?.get?.('location') ?? '')
  const to = parseVideoRef(loc)
  if (to?.bvid) return { ok: true, bvid: to.bvid, ...(to.aid ? { aid: to.aid } : {}), via: 'short', note: `（短链 ${r.short} → ${to.bvid}）` }
  // 没给跳转：5xx / 拿不到状态 = b23.tv 自己出错（3）；别的（不存在的码 b23.tv 回 200）= 短链失效或抄错了（2）
  if (!loc) {
    const st = Number(res.status) || 0
    return st >= 500 || !st
      ? { ok: false, code: 3, error: `短链 ${r.short} 没解析成（b23.tv 出错，HTTP ${st || '?'}）—— 过一会儿再试，或者请主人直接发 BV 号` }
      : { ok: false, code: 2, error: `短链 ${r.short} 没跳到任何地方（HTTP ${st}）：可能失效了或者抄错了 —— 请主人直接发 BV 号或完整的视频链接` }
  }
  let shown = loc
  try { const u = new URL(loc); shown = u.origin + u.pathname } catch {}
  return { ok: false, code: 2, error: `短链 ${r.short} 跳到的不是 B站 视频：${clip(shown, 80)}` }
}

// —— 私信里的分享卡片（msg_type 7） ——
// 卡片里能用的字段：bvid（有就以它为准）→ url（B站 视频链接、或者 App 的 bilibili://video/<av|BV>）→ id（av 号）。
// 只有 id 没有别的时：source 是 6（专栏）、7（直播间）就不当视频（id 不是 av 号，换算出来会是另一条不相干的视频）；
// 别的 source 照 av 号换算（以前就是这么当的：id 拼成 av 链接），但 source 不是 5（视频）时标上 sure: false，提醒打开后核对标题。
const NOT_VIDEO_SOURCE = new Set([6, 7])
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' '), n)

/** 卡片 JSON → { video: true, bvid, aid, title, author, sure } 或 { video: false, title, author, url, source }；不是对象 = null */
export function shareCard(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const title = oneLine(body.title ?? body.headline ?? body.name ?? '', 80)
  const author = oneLine(body.author ?? body.up_name ?? body.owner ?? '', 40)
  const source = body.source == null || body.source === '' ? null : Number(body.source)
  const urls = [body.url, body.jump_url, body.uri].map((x) => String(x ?? '').trim()).filter(Boolean)
  const done = (bvid, sure) => ({ video: true, bvid, aid: bv2av(bvid), title, author, sure })
  if (BV_RE.test(String(body.bvid ?? ''))) return done(String(body.bvid), true)
  for (const u of urls) {
    const app = /^bilibili:\/\/video\/(BV[0-9A-Za-z]{10}|[1-9]\d{0,15})(?:[/?#]|$)/i.exec(u)?.[1]
    const bvid = app ? (BV_RE.test(app) ? app : av2bv(app)) : parseVideoRef(u)?.bvid   // 短链不联网（这里只认能直接换算的）
    if (bvid) return done(bvid, true)
  }
  const id = String(body.id ?? body.aid ?? body.rid ?? '').trim()
  if (/^[1-9]\d{0,15}$/.test(id) && !NOT_VIDEO_SOURCE.has(source)) {
    const bvid = av2bv(id)
    if (bvid) return done(bvid, source === 5)
  }
  const url = urls.find((u) => /^https?:\/\//i.test(u)) ?? ''
  return { video: false, title, author, url: oneLine(url, 200), source }
}

/** 卡片 → 给她看的几行（私信送进她会话的样子） */
export function renderShareCard(body) {
  const c = shareCard(body)
  if (!c) return '[B站分享]（卡片内容读不出来）'
  const head = `${c.title ? `《${c.title}》` : ''}${c.author ? `${c.title ? ' · ' : ''}UP 主 ${c.author}` : ''}`
  if (!c.video) {
    return `[B站分享（不是视频${c.source != null && Number.isFinite(c.source) ? `，类型 ${c.source}` : ''}）]${head ? ' ' + head : ''}${c.url ? '\n' + c.url : ''}`
  }
  return [
    `[B站视频分享]${head ? ' ' + head : ''}`,
    `BV 号 ${c.bvid}${c.aid ? `（av${c.aid}）` : ''}${c.sure ? '' : ' —— 卡片只给了编号，打开后核对一下标题对不对得上'}`,
    `https://www.bilibili.com/video/${c.bvid}/`,
  ].join('\n')
}
