// 取网页（tools/lib/webfetch.mjs）：只连本机 127.0.0.1 上的假服务器，靠测试专用的 policyOverride 放行「这个地址 + 这个端口」，别的照严格的笼子。
//   跳转（次数上限、跳到内网 IP / 别的端口 / localhost / [::1] 都拒）、大小上限（原始、gzip 炸弹）、慢慢滴的服务器撞上总时限、
//   不是文字的类型、GBK / Big5 / BOM 解码、连上时再查一次地址、假 DNS 走 lookup 那一关。不联网
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { fetchPage, pickDecoder } = await import(pathToFileURL(path.join(root, 'tools/lib/webfetch.mjs')).href)

// 起一个假服务器：handler(req, res)；记下收到的每个请求
async function server(t, handler) {
  const seen = []
  const srv = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()) }))
  const port = srv.address().port
  return { port, seen, base: `http://127.0.0.1:${port}` }
}
// 只放行 127.0.0.1 和这个端口
const ov = (port, extra = {}) => ({ addrs: ['127.0.0.1'], ports: [port], ...extra })
const html = (res, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(200, { 'Content-Type': type, ...extra }); res.end(body) }

test('普通网页：文字、编码、请求头（没有 cookie / Referer，要求别压缩）', async (t) => {
  const s = await server(t, (req, res) => html(res, '<html><title>你好</title><p>正文</p></html>'))
  const r = await fetchPage(`${s.base}/a?b=1#frag`, { policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(r.ok, true, r.why)
  assert.equal(r.status, 200)
  assert.equal(r.contentType, 'text/html')
  assert.equal(r.charset, 'utf-8')
  assert.match(r.text, /正文/)
  assert.equal(r.redirects, 0)
  assert.equal(r.url, `${s.base}/a?b=1#frag`)
  assert.equal(s.seen[0].url, '/a?b=1')
  const h = s.seen[0].headers
  assert.equal(h.cookie, undefined)
  assert.equal(h.referer, undefined)
  assert.equal(h['accept-encoding'], 'identity')
  assert.match(h['user-agent'], /Mozilla/)
  assert.match(h.accept, /text\/html/)
  assert.match(h['accept-language'], /zh-CN/)
  assert.equal(h.host, `127.0.0.1:${s.port}`)
})

test('不传 policyOverride 就是严格的笼子：127.0.0.1 连都不连', async (t) => {
  const s = await server(t, (req, res) => html(res, 'x'))
  const r = await fetchPage(`${s.base}/`)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EWEBCAGE')
  const r2 = await fetchPage(`http://127.0.0.1/`, { localAddrs: [] })
  assert.equal(r2.code, 'EWEBCAGE')
  // 只放端口、不放地址也不行
  const r3 = await fetchPage(`${s.base}/`, { policyOverride: { ports: [s.port] }, localAddrs: [] })
  assert.equal(r3.code, 'EWEBCAGE')
  assert.equal(s.seen.length, 0)
})

test('跳转：最多 5 次（传更大的也是 5），相对地址能跟', async (t) => {
  const s = await server(t, (req, res) => {
    const m = /^\/r\/(\d+)$/.exec(req.url)
    if (m && Number(m[1]) > 0) { res.writeHead(302, { Location: `/r/${Number(m[1]) - 1}` }); return res.end() }
    html(res, '<p>到了</p>')
  })
  const ok = await fetchPage(`${s.base}/r/5`, { policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(ok.ok, true, ok.why)
  assert.equal(ok.redirects, 5)
  assert.equal(ok.url, `${s.base}/r/0`)
  const tooMany = await fetchPage(`${s.base}/r/6`, { policyOverride: ov(s.port), localAddrs: [], maxRedirects: 99 })
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.code, 'EREDIRECT')
  const fewer = await fetchPage(`${s.base}/r/2`, { policyOverride: ov(s.port), localAddrs: [], maxRedirects: 1 })
  assert.equal(fewer.code, 'EREDIRECT')
})

test('跳转到内网 IP / 别的端口 / localhost / [::1] / file: 都拒（测试口子只放第一跳的那个地址和端口）', async (t) => {
  const targets = {
    '/lan': 'http://192.168.178.1/', '/lan-int': 'http://3232281089/', '/port': 'http://127.0.0.1:1/', '/name': null,
    '/v6': null, '/file': 'file:///C:/Windows/win.ini', '/meta': 'http://169.254.169.254/latest/', '/bili': 'https://www.bilibili.com/',
  }
  const s = await server(t, (req, res) => {
    const to = targets[req.url] ?? (req.url === '/name' ? `http://localhost:${s.port}/` : `http://[::1]:${s.port}/`)
    res.writeHead(301, { Location: to })
    res.end()
  })
  for (const p of Object.keys(targets)) {
    const r = await fetchPage(`${s.base}${p}`, { policyOverride: ov(s.port), localAddrs: [] })
    assert.equal(r.ok, false, p)
    assert.equal(r.code, 'EWEBCAGE', p)
    assert.match(r.why, /跳转/)
  }
  // 每个只有第一跳到了服务器
  assert.equal(s.seen.length, Object.keys(targets).length)
})

test('大小上限：原始超过 2 MB（有 / 没有 Content-Length）、gzip 炸弹；正常的 gzip / deflate / br 能解', async (t) => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
  const bomb = zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024))
  const body = Buffer.from('<p>压缩过的正文</p>'.repeat(50))
  const s = await server(t, (req, res) => {
    if (req.url === '/big') return html(res, big)
    if (req.url === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      let n = 0
      const tick = () => { if (n++ < 60) { res.write(Buffer.alloc(64 * 1024, 0x62)); setImmediate(tick) } else res.end() }
      return tick()
    }
    if (req.url === '/bomb') return html(res, bomb, 'text/html', { 'Content-Encoding': 'gzip' })
    if (req.url === '/gzip') return html(res, zlib.gzipSync(body), 'text/html; charset=utf-8', { 'Content-Encoding': 'gzip' })
    if (req.url === '/deflate') return html(res, zlib.deflateSync(body), 'text/html; charset=utf-8', { 'Content-Encoding': 'deflate' })
    if (req.url === '/rawdeflate') return html(res, zlib.deflateRawSync(body), 'text/html; charset=utf-8', { 'Content-Encoding': 'deflate' })
    if (req.url === '/br') return html(res, zlib.brotliCompressSync(body), 'text/html; charset=utf-8', { 'Content-Encoding': 'br' })
    if (req.url === '/weird') return html(res, body, 'text/html', { 'Content-Encoding': 'zstd' })
  })
  const o = { policyOverride: ov(s.port), localAddrs: [] }
  for (const p of ['/big', '/chunked', '/bomb']) {
    const r = await fetchPage(`${s.base}${p}`, o)
    assert.equal(r.ok, false, p)
    assert.equal(r.code, 'ETOOBIG', p)
  }
  for (const p of ['/gzip', '/deflate', '/rawdeflate', '/br']) {
    const r = await fetchPage(`${s.base}${p}`, o)
    assert.equal(r.ok, true, `${p}: ${r.why}`)
    assert.equal(r.text, body.toString('utf8'))
    assert.equal(r.bytes, body.length)
  }
  assert.equal((await fetchPage(`${s.base}/weird`, o)).code, 'EENCODING')
  // 只能调小：maxBytes 传 100 → 100 字节就算太大
  const small = await fetchPage(`${s.base}/gzip`, { ...o, maxBytes: 100 })
  assert.equal(small.code, 'ETOOBIG')
})

test('总时限：一个计时器管连接 + 响应头 + 全部内容（慢慢滴的、一直不回的都撞上）', async (t) => {
  const s = await server(t, (req, res) => {
    if (req.url === '/drip') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      const iv = setInterval(() => res.write('a'), 30)
      res.on('close', () => clearInterval(iv))
      return
    }
    // /hang：什么都不回
  })
  const o = { policyOverride: ov(s.port), localAddrs: [], deadlineMs: 300 }
  for (const p of ['/drip', '/hang']) {
    const t0 = Date.now()
    const r = await fetchPage(`${s.base}${p}`, o)
    const ms = Date.now() - t0
    assert.equal(r.code, 'ETIMEDOUT', p)
    assert.ok(ms >= 250 && ms < 2000, `${p} 用了 ${ms} ms`)
  }
  // 取消
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  const a = await fetchPage(`${s.base}/hang`, { policyOverride: ov(s.port), localAddrs: [], signal: ac.signal })
  assert.equal(a.code, 'EABORT')
})

test('只收文字类型；HTTP 错误码', async (t) => {
  const s = await server(t, (req, res) => {
    if (req.url === '/png') return html(res, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    if (req.url === '/json') return html(res, '{}', 'application/json')
    if (req.url === '/none') { res.writeHead(200); return res.end('<p>x</p>') }
    if (req.url === '/plain') return html(res, '纯文字', 'text/plain; charset=utf-8')
    if (req.url === '/xhtml') return html(res, '<p>x</p>', 'application/xhtml+xml')
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('nope')
  })
  const o = { policyOverride: ov(s.port), localAddrs: [] }
  for (const p of ['/png', '/json', '/none']) {
    const r = await fetchPage(`${s.base}${p}`, o)
    assert.equal(r.ok, false, p)
    assert.equal(r.why, '不是文字网页')
  }
  const plain = await fetchPage(`${s.base}/plain`, o)
  assert.equal(plain.contentType, 'text/plain')
  assert.equal(plain.text, '纯文字')
  assert.equal((await fetchPage(`${s.base}/xhtml`, o)).ok, true)
  const nf = await fetchPage(`${s.base}/missing`, o)
  assert.equal(nf.code, 'EHTTP')
  assert.match(nf.why, /404/)
})

test('编码：Content-Type 里的 GBK / GB2312 / GB18030、<meta> 里的 Big5、BOM、默认 UTF-8', async (t) => {
  const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])     // 中文
  const BIG5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])    // 中文
  const s = await server(t, (req, res) => {
    if (req.url === '/gbk') return html(res, Buffer.concat([Buffer.from('<p>'), GBK, Buffer.from('</p>')]), 'text/html; charset=GBK')
    if (req.url === '/gb2312') return html(res, GBK, 'text/html; charset="gb2312"')
    if (req.url === '/gb18030') return html(res, GBK, 'text/html;charset=gb18030')
    if (req.url === '/big5') return html(res, Buffer.concat([Buffer.from('<html><head><meta charset="big5"></head><body>'), BIG5]), 'text/html')
    if (req.url === '/equiv') return html(res, Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'), GBK]), 'text/html')
    if (req.url === '/bom') return html(res, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文')]), 'text/html; charset=gbk')
    html(res, Buffer.from('中文'), 'text/html')
  })
  const o = { policyOverride: ov(s.port), localAddrs: [] }
  const get = (p) => fetchPage(`${s.base}${p}`, o)
  const gbk = await get('/gbk')
  assert.equal(gbk.charset, 'gbk')
  assert.equal(gbk.text, '<p>中文</p>')
  assert.equal((await get('/gb2312')).charset, 'gbk')
  assert.equal((await get('/gb2312')).text, '中文')
  assert.equal((await get('/gb18030')).charset, 'gb18030')
  const b5 = await get('/big5')
  assert.equal(b5.charset, 'big5')
  assert.match(b5.text, /中文$/)
  assert.match((await get('/equiv')).text, /中文$/)
  const bom = await get('/bom')
  assert.equal(bom.charset, 'utf-8')
  assert.equal(bom.text, '中文')
  const def = await get('/default')
  assert.equal(def.charset, 'utf-8')
  assert.equal(def.text, '中文')
  // 认不得的标签 → UTF-8
  assert.equal(pickDecoder(Buffer.from('x'), 'text/html; charset=bogus-xyz').decoder.encoding, 'utf-8')
})

test('连上时再查一次：绕过 DNS 那一关（测试专用 lookup）连到 127.0.0.1 也会在发请求之前断开', async (t) => {
  const s = await server(t, (req, res) => html(res, 'secret'))
  const rawLookup = (host, opts, cb) => {
    if (typeof opts === 'function') cb = opts
    if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }])
    else cb(null, '127.0.0.1', 4)
  }
  const r = await fetchPage(`http://evil.example:${s.port}/`, { policyOverride: { addrs: [], ports: [s.port], lookup: rawLookup }, localAddrs: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'EWEBCAGE')
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(s.seen.length, 0)
  // 对照：同一条路，把 127.0.0.1 放进口子 → 真的连上了（说明上面是连上时那一道挡下的，不是别处）
  const ctl = await fetchPage(`http://evil.example:${s.port}/`, { policyOverride: { addrs: ['127.0.0.1'], ports: [s.port], lookup: rawLookup }, localAddrs: [] })
  assert.equal(ctl.ok, true, ctl.why)
  assert.equal(s.seen.length, 1)
})

test('写域名的走 lookup：假 DNS 回 127.0.0.1 → 放行（测试口子）；混着一个内网地址 → 整个不连', async (t) => {
  const s = await server(t, (req, res) => html(res, '<p>ok</p>'))
  const one = await fetchPage(`http://site.example:${s.port}/p`, { resolve: async () => [{ address: '127.0.0.1', family: 4 }], policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(one.ok, true, one.why)
  assert.equal(s.seen[0].headers.host, `site.example:${s.port}`)
  const mixed = await fetchPage(`http://site.example:${s.port}/p`, { resolve: async () => ['127.0.0.1', '10.0.0.1'], policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(mixed.code, 'EWEBCAGE')
  const fakeip = await fetchPage(`http://site.example:${s.port}/p`, { resolve: async () => ['198.18.0.9'], policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(fakeip.code, 'EWEBCAGE')
  assert.match(fakeip.why, /TUN|fake-ip/)
  const nx = await fetchPage(`http://site.example:${s.port}/p`, { resolve: async () => [], policyOverride: ov(s.port), localAddrs: [] })
  assert.equal(nx.code, 'ENOTFOUND')
  assert.equal(s.seen.length, 1)
})

test('https 也一样：连上时那一道在 TLS 握手（ClientHello）之前就断开，对面一个字节都收不到', async (t) => {
  const net = await import('node:net')
  let bytes = 0, conns = 0
  const srv = net.createServer((sock) => { conns++; sock.on('data', (d) => { bytes += d.length }); sock.on('error', () => {}) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => srv.close(() => r())))
  const port = srv.address().port
  const rawLookup = (host, opts, cb) => {
    if (typeof opts === 'function') cb = opts
    if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }])
    else cb(null, '127.0.0.1', 4)
  }
  const r = await fetchPage(`https://evil.example:${port}/`, { policyOverride: { addrs: [], ports: [port], lookup: rawLookup }, localAddrs: [] })
  assert.equal(r.code, 'EWEBCAGE')
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(conns, 1)
  assert.equal(bytes, 0)
  // 对照：放行 127.0.0.1 时真的发了 ClientHello（对面不是 TLS，握手失败）
  const ctl = await fetchPage(`https://evil.example:${port}/`, { policyOverride: { addrs: ['127.0.0.1'], ports: [port], lookup: rawLookup }, localAddrs: [], deadlineMs: 500 })
  assert.equal(ctl.ok, false)
  await new Promise((res) => setTimeout(res, 100))
  assert.ok(bytes > 0)
})

test('每一跳之前问一次 beforeHop（跳转也问）：抛错就停、后面不再连；像 TUN 代理的网卡 → 一个字节都不连（主人设了 allowTun 才连）', async (t) => {
  const s = await server(t, (req, res) => {
    if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); return res.end() }
    html(res, '<p>到了</p>')
  })
  let asked = 0
  const ok = await fetchPage(`${s.base}/a`, { policyOverride: ov(s.port), localAddrs: [], ifaces: {}, beforeHop: () => { asked += 1 } })
  assert.equal(ok.ok, true, ok.why); assert.equal(asked, 2, '第一跳和跳转后各一次')
  // 第一跳之后被停下：跳转的目标不再连
  const before = s.seen.length
  let n = 0
  const stopped = await fetchPage(`${s.base}/a`, { policyOverride: ov(s.port), localAddrs: [], ifaces: {}, beforeHop: () => { n += 1; if (n > 1) throw new Error('主人停下了这一轮') } })
  assert.equal(stopped.ok, false); assert.equal(stopped.code, 'ESTOPPED'); assert.match(stopped.why, /停下/)
  assert.deepEqual(s.seen.slice(before).map((x) => x.url), ['/a'])
  // TUN：连都不连
  const n0 = s.seen.length
  const tun = await fetchPage(`${s.base}/b`, { policyOverride: ov(s.port), localAddrs: [], ifaces: { 'Clash': [{ address: '198.18.0.1' }] } })
  assert.equal(tun.ok, false); assert.equal(tun.code, 'ETUN'); assert.match(tun.why, /allowTun/)
  assert.equal(s.seen.length, n0)
  const allowed = await fetchPage(`${s.base}/b`, { policyOverride: ov(s.port), localAddrs: [], ifaces: { 'Clash': [] }, allowTun: true })
  assert.equal(allowed.ok, true, allowed.why)
})
