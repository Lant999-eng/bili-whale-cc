// lib/reply-thread.mjs —— 在一栋楼（root 那条评论下面的楼中楼）里翻页找东西（reply-draft 找要回的那条、msgfeed 找他的新回复）
//
// 2026-10-23（Astra 评审，和 comment.mjs 的 parentAuthor 同一类问题）：以前都是从第 1 页往后只翻几页 ——
//   楼中楼按时间正序排（最老的在第 1 页，最新的在最后一页），长楼里新回复全在后面，翻不到就当「没有」。
//   现在：先看第 1 页（顺便拿总条数），再从最后一页往前翻；最多 maxPages 页、有总时限。
//   走 apiGet：节流、风控熔断照常（翻的页比以前多，不能贴脸连打）。comment.mjs 里那份找法是同一个思路，先不动它。
import { apiGet } from './bili-api.mjs'

export const THREAD_PAGES = 10

/**
 * visit(data, pn)：每拿到一页调一次（第 1 页最先，然后是最后一页、倒数第二页……），返回 true = 找到了，不再往下翻。
 * 返回 { found } / { done, long, count }（翻完了也没找到；long = 楼太长、没翻全）/ { late, why }（超时）/ { error, why }（接口出错）
 */
export async function walkThread({ type, oid, root, headers = {}, budgetMs = 30_000, maxPages = THREAD_PAGES, visit }) {
  const start = Date.now(), deadline = start + budgetMs
  let asked = 0   // 真的请求过的最后一页（超时的时候照实说翻到哪了）
  const late = () => ({ late: true, why: `翻楼超时（${Math.round((Date.now() - start) / 1000)} 秒还没找到${asked ? `，翻到第 ${asked} 页` : ''}）` })
  const page = async (pn) => {
    if (Date.now() >= deadline) return late()
    asked = pn
    const j = await apiGet(`https://api.bilibili.com/x/v2/reply/reply?type=${encodeURIComponent(type)}&oid=${encodeURIComponent(oid)}&root=${encodeURIComponent(root)}&pn=${pn}&ps=20`,
      headers, { noCache: true, timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())) })
    if (j?.code === 0) return { data: j.data ?? {} }
    const msg = String(j?.message ?? '')
    if (Date.now() >= deadline || /超时/.test(msg)) return late()
    // apiGet 断网时的说法带着「WBI 签名」—— 这个接口不签名，说「网络出错」就好
    return { error: true, why: `查楼层时接口出错（第 ${pn} 页）：${j?.code === -1 && /网络异常/.test(msg) ? '网络出错' : `code=${j?.code ?? '?'} ${msg.slice(0, 80)}`}` }
  }
  const first = await page(1)
  if (!first.data) return first
  if (visit(first.data, 1)) return { found: true }
  // 从最后一页往前翻（接口没给总条数、第 1 页又是满的 → 按最多页数往前翻）
  const list = first.data.replies ?? []
  const size = Number(first.data.page?.size) > 0 ? Number(first.data.page.size) : 20
  const count = Number(first.data.page?.count ?? 0)
  const last = count > 0 ? Math.min(Math.ceil(count / size), 1000) : (list.length >= size ? maxPages : 1)
  for (let pn = last, n = 1; pn > 1 && n < maxPages; pn -= 1, n += 1) {
    const p = await page(pn)
    if (!p.data) return p
    if (visit(p.data, pn)) return { found: true }
  }
  return { done: true, long: last > maxPages, count }
}
