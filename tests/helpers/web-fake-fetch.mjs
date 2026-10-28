// 假的 fetchPage：网页从 TEST_WEB_PAGES（{ 网址: { body, type } }）里拿，每次调用记一行到 TEST_WEB_LOG；没有的网址 = 404。
//   和真的一样：每一跳之前调 opts.beforeHop（抛错 → ESTOPPED）；页面写了 redirectTo → 算一跳跳转，再调一次 beforeHop。记下 allowTun 有没有传
import fs from 'node:fs'
export async function fetchPage(url, opts = {}) {
  if (process.env.TEST_WEB_LOG) fs.appendFileSync(process.env.TEST_WEB_LOG, JSON.stringify({ url, block: opts.block ?? null, allowTun: opts.allowTun ?? null, beforeHop: typeof opts.beforeHop === 'function' }) + '\n')
  let pages = {}
  try { pages = JSON.parse(fs.readFileSync(process.env.TEST_WEB_PAGES, 'utf8')) } catch {}
  let cur = url
  for (let hops = 0; hops <= 5; hops += 1) {
    if (typeof opts.beforeHop === 'function') {
      try { opts.beforeHop() } catch (e) { return { ok: false, why: String(e?.message ?? e).slice(0, 120), code: 'ESTOPPED' } }
    }
    const p = pages[cur]
    if (!p) return { ok: false, why: 'HTTP 404', code: 'EHTTP', status: 404 }
    if (p.redirectTo) { cur = p.redirectTo; continue }
    return { ok: true, url: p.finalUrl ?? cur, status: 200, contentType: p.type ?? 'text/html; charset=utf-8', charset: 'utf-8', text: p.body, bytes: p.body.length, redirects: hops, ms: 1 }
  }
  return { ok: false, why: '跳转太多次', code: 'EREDIRECT' }
}
