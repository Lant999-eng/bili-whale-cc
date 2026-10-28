// 测试用（--import 预加载）：dm.mjs 发私信那几个接口的假回包，不联网。
// 先像真 fetch 一样构造一次 Request（请求头不合法时照样在这里报错），发出去的正文追加到 TEST_DM_SENT
import fs from 'node:fs'
const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, opts = {}) => {
  new Request(String(url), { method: opts.method ?? 'GET', headers: opts.headers })
  const u = String(url)
  if (u.includes('/x/web-interface/nav')) return json({ code: 0, data: { isLogin: true, mid: 111, uname: 'Whale' } })
  if (u.includes('/x/relation')) return json({ code: 0, data: { attribute: 6 } })
  if (u.includes('/web_im/v1/web_im/send_msg')) {
    const content = JSON.parse(new URLSearchParams(String(opts.body)).get('msg[content]')).content
    if (process.env.TEST_DM_SENT) fs.appendFileSync(process.env.TEST_DM_SENT, JSON.stringify({ content }) + '\n')
    return json({ code: 0, data: { msg_key: 1 } })
  }
  return json({ code: -404, message: 'not mocked' })
}
