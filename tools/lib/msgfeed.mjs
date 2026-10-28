// lib/msgfeed.mjs —— B 站两个"收件箱"的共用读法（回复我的 / @我的）
//
// ⚠️ 踩过的坑：`/x/msgfeed/reply` 的 `item.title` **不总是**那条新回复的正文
//   （实测多条 item 的 title 是同一句，真正的正文跑到 source_content 去了）。
//   所以**要拿"别人到底说了什么"，必须回读楼层**（resolveLatestReply）。
//   收件箱只用来"发现有人找我们"，正文以楼层为准。
//
// 这条经验同样适用于其它项目：官方收件箱字段语义没文档、别直接当正文用。

// P0-7（Kimi 评审 #7）：这两个值改成从配置读（config.self.mid / config.owner.mid）
import { config } from './config.mjs'
import { walkThread } from './reply-thread.mjs'
export const ME = String(process.env.BILI_ME_MID ?? config().self?.mid ?? '')
export const OWNER = String(process.env.BILI_OWNER_MID ?? config().owner?.mid ?? '')

// 2026-10-23（Astra 评审的同类问题）：收件箱里的 id（user.mid / id / subject_id / root_id / source_id / target_id）是裸的 JSON 数字 ——
//   超过 2^53 时 JSON.parse 会悄悄改掉末几位，comment-images 拿精确的 mid_str 一比，对的人也会被当成「不是 TA」。
//   所以超出安全范围的整数按原文留成字符串；安全范围内的照旧是数字（行为不变）
const HAS_SOURCE = (() => { try { let ok = false; JSON.parse('1', (k, v, c) => { ok = typeof c?.source === 'string'; return v }); return ok } catch { return false } })()
/** 老一点的 Node 没有 reviver 的原文（context.source）：先在原文里给超出安全范围的整数加上引号（跳过字符串里的内容） */
export const quoteUnsafeInts = (text) => text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  (m) => (m[0] !== '"' && /^-?\d+$/.test(m) && !Number.isSafeInteger(Number(m)) ? `"${m}"` : m))
export function parseJsonIds(text, { source = HAS_SOURCE } = {}) {
  if (!source) return JSON.parse(quoteUnsafeInts(text))
  return JSON.parse(text, (k, v, c) => (typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(c?.source ?? '') ? c.source : v))
}
// 没有 text() 的响应对象就照旧 json()
const readIds = async (res) => (typeof res.text === 'function' ? parseJsonIds(await res.text()) : res.json())

export function makeHeaders(cred) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  }
}

// 拉收件箱：kind = 'reply' | 'at'
// since（秒，可选）：只要这个时间之后的。收件箱是新的在前：翻到比它早的就够了，不再往后翻；
//   「只取到一部分」只在这个范围真的没翻全时才说（第 2 页起出错 / 翻页没往前走 / 翻页位置不完整 / 页数用完了还没翻到）——
//   第 1 页已经翻过了范围的开头，后面出错也不缺什么，不能报假警（Astra 第七次审查之后挑错时发现的）。不给 since：不知道要多少，出错 / 卡住才说
export async function pullFeed(kind, { headers, pages = 1, since = null }) {
  const out = [], got = new Set()
  let next = ''   // 下一页的参数（第 1 页没有）
  let lastView = 0
  let partial = null   // 范围没翻全：前面取到的照样给，再说一声（第 1 页就不行才算整个读不到）
  const sinceN = since == null ? null : Number(since)
  for (let p = 0; p < pages; p += 1) {
    const url = `https://api.bilibili.com/x/msgfeed/${kind}?platform=web&build=0&mobi_app=web` + next
    let j
    try {
      j = await readIds(await fetch(url, { headers }))
      if (j.code !== 0) throw new Error(`${kind} code=${j.code} ${j.message}`)
    } catch (e) {
      if (p === 0) throw e
      partial = `第 ${p + 1} 页没取到（${String(e?.message ?? e).slice(0, 80)}），只有前 ${p} 页`
      break
    }
    if (p === 0) lastView = Number(j.data?.last_view_at ?? 0)
    const items = j.data?.items ?? []
    const fresh = items.filter((it) => !got.has(String(it.id))).length
    // 翻页参数要是不对，接口会一直给回同一页：去重会把它藏起来、后面的永远取不到 —— 这种时候停下、说出来
    if (p > 0 && items.length && !fresh) { partial = `第 ${p + 1} 页和前面的一样（翻页没往前走），只有前 ${p} 页`; break }
    for (const it of items) {
      got.add(String(it.id))
      out.push({
        kind,
        id: String(it.id),
        t: Number(it.reply_time ?? it.at_time ?? 0),
        who: it.user?.nickname ?? '?',
        mid: String(it.user?.mid ?? ''),
        // 两个字段都留着（语义不可靠，谁有内容用谁）
        title: String(it.item?.title ?? ''),
        source: String(it.item?.source_content ?? ''),
        target: String(it.item?.target_reply_content ?? ''),
        business: Number(it.item?.business_id ?? 1),
        oid: String(it.item?.subject_id ?? ''),
        root: String(it.item?.root_id ?? ''),
        parent: String(it.item?.source_id ?? ''),
        uri: String(it.item?.uri ?? ''),
      })
    }
    // 已经翻到要的时间范围以前了：更早的用不上，不再翻
    if (sinceN != null && items.some((it) => { const t = Number(it.reply_time ?? it.at_time ?? 0); return t > 0 && t < sinceN })) break
    // 翻页：接口给的 data.cursor 是个对象 { is_end, id, time } —— 以前把它整个拼进网址，第 2 页请求的是 cursor=[object Object]，
    //   拿回来的还是第 1 页（以前「每条都出现两遍」就是这么来的），后面的一条都没取到（Astra 第七次审查）。
    //   现在按「这一页最后一条」的 id + 时间要下一页：回复我的用 reply_time，@我的用 at_time（照公开的接口资料；还没用真号翻过第 2 页）
    const c = j.data?.cursor
    if (!items.length || !c || typeof c !== 'object' || c.is_end) break
    if (p + 1 >= pages) {   // 页数用完了：要了时间范围、又还没翻到它的开头 → 说一声
      if (sinceN != null) partial = `翻了 ${pages} 页还没翻到要的时间范围的开头（更早的没取）`
      break
    }
    if (c.id == null || c.time == null) { partial = `第 ${p + 1} 页给的翻页位置不完整（没有 id / time），只有前 ${p + 1} 页`; break }
    const nn = `&id=${encodeURIComponent(String(c.id))}&${kind === 'at' ? 'at_time' : 'reply_time'}=${encodeURIComponent(String(c.time))}`
    if (nn === next) { partial = `第 ${p + 1} 页给回的翻页位置和上一页一样（翻页没往前走），只有前 ${p + 1} 页`; break }
    next = nn
  }
  // 按 id 去重（万一接口翻页给回重叠的）
  const seen = new Set()
  const uniq = out.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
  return { items: uniq, lastView, ...(partial ? { partial } : {}) }
}

// 回读楼层，取"这个人在这个楼里的那条评论" —— 这才是他真正说的话
// parentRpid 是关键：同一个人在一个楼里可能有好几条评论。调用方给的是收件箱的 source_id（实测 = 他这条评论的 rpid），
// 所以先认 rpid 对上的；以前只拿它去对 parent，几乎对不上，就退回「他最新的一条」—— 他在楼里说过几句时会拿错（Astra 评审同类问题，2026-10-23）
// → { rpid, text, ctime, exact }：exact = 找到的就是那一条；false = 没找到那条，给的是他在这栋楼最新的一条（不一定是这条）
// 2026-10-23 修（Astra 评审的同类问题）：以前从第 1 页往后最多翻 6 页、遇到不满的一页就停 ——
//   楼中楼最老的在前面，超过 120 条的楼里他的新回复根本看不到。现在先看第 1 页，再从最后一页往前翻（最多 10 页、有总时限、走 apiGet）。
//   mid / rpid / parent 优先用字符串形式（mid_str / rpid_str / parent_str）：超过 2^53 的数字会失真
export async function resolveLatestReply({ business, oid, root, mid, parentRpid, headers, budgetMs = 20_000 }) {
  const type = business === 11 ? 11 : 1
  const want = String(parentRpid ?? '')
  // 顶层评论：收件箱给的 root_id 是 0，reply/reply?root=0 什么都查不到 —— 和 comment.mjs 一样，拿他那条当楼主去查（它就是 data.root）
  const top = !root || String(root) === '0'
  if (top && !want) return null
  const isHis = (r) => String(r.mid_str ?? r.mid) === String(mid)
  // 调用方给的 parentRpid 是收件箱的 source_id —— 实测就是「他这条评论」的 rpid（回他时用它当 parent）：rpid 对上 = 正是那一条
  // 只有 rpid 和作者都对上才算「就是这条」；parent 对上的只是回这条的别的评论（比如他自己接着回自己），不算（Astra 第七次审查）
  const isSelf = (r) => Boolean(want) && String(r.rpid_str ?? r.rpid) === want
  const seen = new Map()   // 页码 → 他在这一页的回复
  const w = await walkThread({ type, oid, root: top ? want : root, headers, budgetMs, visit: (data, pn) => {
    const page = (data.replies ?? []).filter(isHis)
    if (pn === 1 && data.root && isSelf(data.root) && isHis(data.root)) page.unshift(data.root)   // 他那条就是楼主那条（顶层评论）
    seen.set(pn, page)
    // 找到他那一条就停；没给 parentRpid 时，往前翻的页上看到他的回复就停（比它新的页已经看过了）
    return page.some(isSelf) || (!want && pn > 1 && page.length > 0)
  } })
  if (w.error) return null
  // 翻到的页按楼里的先后排好（超时 / 楼太长没翻全也一样：用看到的那些）
  const mine = [...seen.keys()].sort((a, b) => a - b).flatMap((pn) => seen.get(pn))
  if (!mine.length) return null
  // ① rpid 对得上（正是收件箱里那一条）才是 exact
  let pick = want ? mine.find(isSelf) ?? null : null
  // ② 退路：他最后一条（不一定是收件箱里那条，exact:false —— 调用方要照实标）
  const exact = Boolean(pick)
  if (!pick) pick = mine[mine.length - 1]
  return { rpid: String(pick.rpid_str ?? pick.rpid), text: String(pick.content?.message ?? ''), ctime: Number(pick.ctime ?? 0), exact }
}
