// node --import 用（放在别的假 fetch 后面，只接管 b23.tv）：假的短链。
//   TEST_B23：{ "<码>": "<跳转地址>" | 500 | "netfail" }；没列的码 → HTTP 200、不跳（真 b23.tv 对不存在的码就是这样）
//   TEST_REQUESTS：每个 b23.tv 请求记一行 { url, b23: true, redirect, cookie }（cookie：有没有带 cookie 头）
import fs from 'node:fs'
const inner = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname !== 'b23.tv') return inner(url, init)
  if (process.env.TEST_REQUESTS) fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ url: String(url), b23: true, redirect: init.redirect ?? null, cookie: Boolean(init.headers?.cookie) }) + '\n')
  const spec = JSON.parse(process.env.TEST_B23 || '{}')[u.pathname.slice(1)]
  if (spec === 'netfail') throw new TypeError('fetch failed')
  const status = typeof spec === 'string' ? 302 : typeof spec === 'number' ? spec : 200
  const headers = new Headers(typeof spec === 'string' ? { location: spec } : {})
  return { ok: status < 300, status, headers, body: null, text: async () => '', json: async () => ({}) }
}
