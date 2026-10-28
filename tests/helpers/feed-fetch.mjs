// feed.mjs 用的假 B 站（2026-10-25）：记下每个请求；搜索按关键词各回一条，热门回 TEST_FEED_POPULAR 里的标题；别的地址一律拦下
import fs from 'node:fs'
import crypto from 'node:crypto'
const ok = (data) => ({ status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) })
const bv = (s) => 'BV1' + crypto.createHash('md5').update(s).digest('hex').slice(0, 9)
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ path: u.pathname, keyword: u.searchParams.get('keyword') }) + '\n')
  if (u.pathname === '/x/web-interface/nav') {
    return ok({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })
  }
  if (u.pathname === '/x/web-interface/wbi/search/type') {
    if (process.env.TEST_FEED_NO_SEARCH === '1') return ok({ code: 0, data: { result: [] } })   // 只看热门里给的那几条
    const kw = u.searchParams.get('keyword')
    const order = u.searchParams.get('order')
    return ok({ code: 0, data: { result: [{ bvid: bv(kw + order), title: `<em class="keyword">${kw}</em> 搜到的${order}`, duration: '3:20', danmaku: 20, play: 100, author: 'up-' + order }] } })
  }
  if (u.pathname === '/x/web-interface/popular') {
    const titles = JSON.parse(process.env.TEST_FEED_POPULAR || '[]')
    // 每条可以是标题，也可以是 { t: 标题, dm: 弹幕数 }（默认 2000）
    return ok({ code: 0, data: { list: titles.map((x) => { const t = typeof x === 'string' ? x : x.t; return { bvid: bv('hot' + t), title: t, duration: 200, stat: { danmaku: typeof x === 'string' ? 2000 : x.dm, view: 100 }, owner: { name: 'hot-up' } } }) } })
  }
  if (u.pathname === '/x/web-interface/ranking/v2') return ok({ code: 0, data: { list: [] } })
  if (u.pathname === '/x/polymer/web-dynamic/v1/feed/all') return ok({ code: 0, data: { items: [] } })
  throw Error('Network blocked by test: ' + url)
}
