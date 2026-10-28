// node --import 用：假的评论楼 + 假的 B站 图床（comment-images 的测试）
//   TEST_PICS_FILE：{ root: <楼主那条>, replies: [<楼中楼，按时间正序>], code?: 0, imgs?: { "<图片地址（不含 @…）>": "jpg|png|404|html|big|small404|throw" } }
//   TEST_REQUESTS：每个请求记一行 { url }
//   spec.failFromPage：从第几页开始评论接口回 code=-412；imgs 里还可以有 bignolen（不给长度、实际超大）/ slow（1.5 秒才回，认 abort）
//   TEST_FS_LOG：记下工具直接 writeFileSync / renameSync 了哪些路径（查「先写临时文件再改名」）
//   超过 2^53 的编号：spec 里写成字符串 "#raw:<数字>"，评论接口的回包里就是不带引号的 JSON 数字（和真接口一样，JSON.parse 后会失真）
import fs from 'node:fs'
const rawNums = (s) => s.replace(/"#raw:(\d+)"/g, '$1')
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 2)])
const bin = (status, body, type = 'image/jpeg', len = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(len ?? body.length) : k.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  text: async () => body.toString('latin1'),
  json: async () => JSON.parse(body.toString('utf8')),
})
if (process.env.TEST_FS_LOG) {
  const ow = fs.writeFileSync, or = fs.renameSync, log = process.env.TEST_FS_LOG
  fs.writeFileSync = function (f, ...a) { if (String(f) !== log) fs.appendFileSync(log, JSON.stringify({ op: 'write', f: String(f) }) + '\n'); return ow.call(this, f, ...a) }
  fs.renameSync = function (a, b) { fs.appendFileSync(log, JSON.stringify({ op: 'rename', from: String(a), to: String(b) }) + '\n'); return or.call(this, a, b) }
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (process.env.TEST_REQUESTS) fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ url: u }) + '\n')
  const spec = JSON.parse(fs.readFileSync(process.env.TEST_PICS_FILE, 'utf8'))
  if (u.includes('/x/v2/reply/reply')) {
    const q = new URL(u).searchParams
    if (spec.code && spec.code !== 0) return bin(200, Buffer.from(JSON.stringify({ code: spec.code, message: 'mock error' })), 'application/json')
    // 和真接口一样：root= 不管传的是楼主还是楼中楼的 rpid，data.root 都是楼主那条
    const ids = [spec.root, ...spec.replies].map((r) => String(r.rpid).replace(/^#raw:/, ''))
    if (!ids.includes(q.get('root'))) return bin(200, Buffer.from(JSON.stringify({ code: 12022, message: '已经被删除了' })), 'application/json')
    const pn = Number(q.get('pn')), ps = Number(q.get('ps'))
    if (spec.slowPages) await new Promise((res, rej) => { const t = setTimeout(res, spec.slowPages); opts.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) }) })
    if (spec.failFromPage && pn >= spec.failFromPage) return bin(200, Buffer.from(JSON.stringify({ code: -412, message: 'request was banned' })), 'application/json')
    const data = { root: spec.root, replies: spec.replies.slice((pn - 1) * ps, pn * ps), page: { num: pn, size: ps, count: spec.replies.length } }
    return bin(200, Buffer.from(rawNums(JSON.stringify({ code: 0, data }))), 'application/json')
  }
  if (/hdslb\.com|biliimg\.com/.test(u)) {
    const small = u.includes('@')
    const key = u.replace(/@.*$/, '').replace(/^https:/, 'http:')   // 评论里给的是 http://，工具改成 https 去下
    const how = spec.imgs?.[key] ?? 'jpg'
    if (how === 'throw') throw new Error('socket hang up')
    if (how === '404' || (how === 'small404' && small)) return bin(404, Buffer.from('nope'), 'text/plain')
    if (how === 'html') return bin(200, Buffer.from('<html>blocked</html>'), 'text/html')
    if (how === 'big') return bin(200, JPG, 'image/jpeg', 50 << 20)
    if (how === 'bignolen') { const b = Buffer.concat([JPG, Buffer.alloc(9 << 20)]); const r = bin(200, b); r.headers = { get: () => null }; return r }
    if (how === 'slow') await new Promise((res, rej) => { const t = setTimeout(res, 1500); opts.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) }) })
    return bin(200, (how === 'png' || how === 'small404') && !small ? PNG : JPG)   // 原图是 png、缩小版是 jpg（和真的一样）
  }
  throw new Error('unexpected request ' + u)
}
