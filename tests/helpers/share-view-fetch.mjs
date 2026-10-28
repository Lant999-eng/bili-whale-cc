// 测试用（NODE_OPTIONS=--import 预加载）：分享评论发之前查视频那一步 —— 照 2026-10-25 真接口的样子：
//   不签名、不带登录的旧 /x/web-interface/view → HTTP 412 风控页（HTML，不是 JSON）
//   签名的 /x/web-interface/wbi/view（带 w_rid）→ SHARE_VIEW=ok 回 aid = VIEW_AID；SHARE_VIEW=html412 也回 412 风控页
//   nav 给出登录信息和 WBI 密钥；reply/add 回 code 0（每发一次往 REPLY_LOG 追加一行）；TEST_REQUESTS：每个请求记一行
import fs from 'node:fs'

const RISK_PAGE = '<!DOCTYPE html><html><head><title>出错啦! - bilibili.com</title></head><body>412 风控</body></html>'
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url))
  if (process.env.TEST_REQUESTS) fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ path: u.pathname, signed: u.searchParams.has('w_rid'), method: opts.method ?? 'GET' }) + '\n')
  if (u.pathname === '/x/web-interface/nav') {
    return json({ code: 0, data: { isLogin: true, uname: '测试角色', mid: 999999001, mobile_verified: 1, money: 0,
      wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })
  }
  if (u.pathname === '/x/web-interface/view') return new Response(RISK_PAGE, { status: 412, headers: { 'content-type': 'text/html' } })
  if (u.pathname === '/x/web-interface/wbi/view') {
    if (!u.searchParams.has('w_rid')) return new Response(RISK_PAGE, { status: 412, headers: { 'content-type': 'text/html' } })
    if (process.env.SHARE_VIEW === 'html412') return new Response(RISK_PAGE, { status: 412, headers: { 'content-type': 'text/html' } })
    return json({ code: 0, data: { aid: Number(process.env.VIEW_AID), bvid: u.searchParams.get('bvid'), title: '过了', owner: { mid: 42, name: '某导演' } } })
  }
  if (u.pathname === '/x/v2/reply/add') {
    if (process.env.REPLY_LOG) fs.appendFileSync(process.env.REPLY_LOG, `${process.pid}\n`)
    return json({ code: 0, data: { rpid: 12345 } })
  }
  return json({ code: 0, data: {} })
}
