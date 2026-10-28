// 文字浏览器取网页：只 GET、只收文字，每一跳都过网络笼子（tools/lib/webcage.mjs），连上时再查一次对面的地址。
//   · 自己建连接（不用 Node 全局的连接池和代理），不带 cookie、不带 Referer，先要求服务器别压缩（还是认 gzip / deflate / br）
//   · 上限：原始 2 MB、解压后 2 MB、每个请求 20 秒（连接、等响应、收完全部共用一个计时器）、最多跳 5 次
//   · 编码：Content-Type → BOM → 前 4 KB 里的 <meta charset> → UTF-8；GBK / GB2312 / GB18030 / Big5 用 TextDecoder 解
//   · opts 里的上限只能调小不能调大；policyOverride 只给测试（见 webcage.mjs），默认就是严格的笼子
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { checkUrl, makeLookup, makeAddrCheck, normalizeHost, cageErr, tunSuspect } from './webcage.mjs'

export const MAX_BYTES = 2 * 1024 * 1024
export const DEADLINE_MS = 20_000
export const MAX_REDIRECTS = 5
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain'])
const REDIRECT = new Set([301, 302, 303, 307, 308])
const ENCODINGS = new Set(['', 'identity', 'gzip', 'x-gzip', 'deflate', 'br'])
export const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'identity',
  Connection: 'close',
})

const fail = (why, code) => ({ ok: false, why, code })
// 数字参数只能比默认小（传大了、传错了都按默认）
const capped = (v, lo, max) => (Number.isFinite(v) && v >= lo && v <= max ? v : max)

/**
 * 取一个网页 → { ok: true, url（最后落到的）, status, contentType, charset, text, bytes, redirects, ms } 或 { ok: false, why, code }。
 * opts：block（屏蔽名单，和 B站 全家合并）、signal（取消）、deadlineMs / maxBytes / maxRedirects（只能调小）、
 *       resolve / localAddrs / now（测试用的假 DNS、假网卡、假时钟）、policyOverride（只给测试，见 webcage.mjs）、
 *       allowTun（主人的 web.allowTun：开着 TUN 代理也照样连）、ifaces（测试用的假网卡清单，给 tunSuspect）、
 *       beforeHop()（每一跳之前调一次，包括跳转：抛错就停 —— 读书回合用它确认主人没停下这一轮、没关读书）
 */
export async function fetchPage(url, opts = {}) {
  const now = opts.now ?? Date.now
  const t0 = now()
  const tun = opts.allowTun === true ? null : tunSuspect(opts.ifaces)
  if (tun) return fail(`这台电脑开着代理的 TUN 模式（${String(tun).slice(0, 40)}）：网络笼子查过的地址不一定是真连上的地址，读书先不上网（主人可以设 web.allowTun true）`, 'ETUN')
  const cage = { block: opts.block, localAddrs: opts.localAddrs, policyOverride: opts.policyOverride }
  const lim = {
    deadlineMs: capped(opts.deadlineMs, 1, DEADLINE_MS),
    maxBytes: capped(opts.maxBytes, 1, MAX_BYTES),
    signal: opts.signal,
    check: makeAddrCheck(cage),
    lookup: opts.policyOverride?.lookup ?? makeLookup({ resolve: opts.resolve, ...cage }),
  }
  const maxRedirects = capped(opts.maxRedirects, 0, MAX_REDIRECTS)
  let cur = url, redirects = 0
  for (;;) {
    const c = checkUrl(cur, cage)
    if (!c.ok) return fail(redirects ? `跳转的目标不能去：${c.why}` : c.why, 'EWEBCAGE')
    if (typeof opts.beforeHop === 'function') {
      try { opts.beforeHop() } catch (e) { return fail(String(e?.message ?? e).slice(0, 120) || '停下了', 'ESTOPPED') }
    }
    const r = await hop(c.url, lim)
    if (!r.ok) return r
    if (r.redirect) {
      if (redirects >= maxRedirects) return fail(`跳转太多次（最多 ${maxRedirects} 次）`, 'EREDIRECT')
      redirects++
      cur = r.redirect
      continue
    }
    return { ...r, url: c.url, redirects, ms: now() - t0 }
  }
}

// 网络错误 → 给她看的一句话
function netWhy(e) {
  if (e?.code === 'EWEBCAGE') return e.message
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return '找不到这个网站（域名解析不出来）'
  if (e?.code === 'ECONNREFUSED') return '连不上（对方拒绝连接）'
  if (e?.code === 'ECONNRESET') return '连接被对方断开了'
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(String(e?.code ?? ''))) return '网站的证书不对，不连'
  return `打不开（${e?.code ?? '网络错误'}）`
}

// 一跳：一个请求、一个计时器
function hop(href, { deadlineMs, maxBytes, signal, check, lookup }) {
  return new Promise((resolve) => {
    const u = new URL(href)
    const secure = u.protocol === 'https:'
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname
    const port = Number(u.port) || (secure ? 443 : 80)
    let settled = false, req = null
    const end = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(r)
      req?.destroy()
    }
    const timer = setTimeout(() => end(fail(`超时了（${Math.round(deadlineMs / 1000)} 秒内没读完）`, 'ETIMEDOUT')), deadlineMs)
    const onAbort = () => end(fail('被取消了', 'EABORT'))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })

    // 自己建连接：连上的那一刻（任何字节发出去之前）先查对面的地址，不合规就断
    const createConnection = () => {
      const o = { host, port, lookup }
      const s = secure
        ? tls.connect({ ...o, servername: net.isIP(host) ? undefined : normalizeHost(host), ALPNProtocols: ['http/1.1'] })
        : net.connect(o)
      s.prependListener('connect', () => {
        if (!check(s.remoteAddress)) s.destroy(cageErr('连上的地址不在允许范围里（内网、本机或特殊用途），断开'))
      })
      return s
    }
    try {
      req = (secure ? https : http).request({
        method: 'GET', host, port, path: u.pathname + u.search, createConnection,
        headers: { ...HEADERS, Host: u.host }, insecureHTTPParser: false,
      })
    } catch (e) { return end(fail(netWhy(e), e?.code ?? 'EREQUEST')) }
    req.on('error', (e) => end(fail(netWhy(e), e?.code ?? 'ENET')))
    req.on('response', (res) => {
      if (settled) return res.destroy()
      // 再查一次（防万一）
      if (!check(res.socket?.remoteAddress)) return end(fail('连上的地址不在允许范围里（内网、本机或特殊用途），断开', 'EWEBCAGE'))
      const status = res.statusCode
      if (REDIRECT.has(status)) {
        const loc = String(res.headers.location ?? '')
        let next = null
        try { if (loc && loc.length <= 4096) next = new URL(loc, href).href } catch { /* 下面报错 */ }
        return end(next ? { ok: true, redirect: next } : fail(`跳转（HTTP ${status}）没给出能用的地址`, 'EREDIRECT'))
      }
      if (status < 200 || status > 299) return end(fail(`网页打不开（HTTP ${status}）`, 'EHTTP'))
      const ctRaw = String(res.headers['content-type'] ?? '')
      const contentType = ctRaw.split(';')[0].trim().toLowerCase()
      if (!TEXT_TYPES.has(contentType)) return end(fail('不是文字网页', 'ETYPE'))
      const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
      if (!ENCODINGS.has(enc)) return end(fail(`网页用了认不得的压缩方式（${enc.slice(0, 20)}）`, 'EENCODING'))
      const cl = Number(res.headers['content-length'])
      if (Number.isFinite(cl) && cl > maxBytes) return end(fail(`网页太大（超过 ${maxBytes / 1048576} MB）`, 'ETOOBIG'))
      const chunks = []
      let total = 0
      res.on('data', (c) => {
        if (settled) return
        total += c.length
        if (total > maxBytes) return end(fail(`网页太大（超过 ${maxBytes / 1048576} MB）`, 'ETOOBIG'))
        chunks.push(c)
      })
      res.on('error', (e) => end(fail(netWhy(e), e?.code ?? 'ENET')))
      res.on('aborted', () => end(fail('网页没传完就断了', 'ECONNRESET')))
      res.on('end', () => {
        if (settled) return
        if (!res.complete) return end(fail('网页没传完就断了', 'ECONNRESET'))
        let body = Buffer.concat(chunks, total)
        try { body = inflate(body, enc, maxBytes) } catch (e) {
          return end(e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError
            ? fail(`网页解压以后太大（超过 ${maxBytes / 1048576} MB）`, 'ETOOBIG')
            : fail('网页的压缩数据坏了', 'EDECODE'))
        }
        const { decoder } = pickDecoder(body, ctRaw)
        end({ ok: true, status, contentType, charset: decoder.encoding, text: decoder.decode(body), bytes: body.length })
      })
    })
    req.end()
  })
}

// 解压（原始数据已经不超过 2 MB；解出来的超过上限就抛 ERR_BUFFER_TOO_LARGE，不会先把全部解出来）
function inflate(buf, enc, max) {
  if (!buf.length || enc === '' || enc === 'identity') return buf
  const o = { maxOutputLength: max }
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, o)
  if (enc === 'br') return zlib.brotliDecompressSync(buf, o)
  // deflate：按规范是带 zlib 头的，有的服务器发的是裸的
  try { return zlib.inflateSync(buf, o) } catch (e) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw e
    return zlib.inflateRawSync(buf, o)
  }
}

// 编码标签 → TextDecoder（WHATWG 的标签：gb2312 / x-gbk 会归到 gbk）；认不得 → null
function decoderFor(label) {
  const l = String(label ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (!l) return null
  try { return new TextDecoder(l, { fatal: false }) } catch { return null }
}

/** 选编码：BOM → Content-Type 的 charset → 前 4 KB 里的 <meta charset> / http-equiv → UTF-8 */
export function pickDecoder(buf, contentTypeHeader = '') {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 'utf-8'
    : buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le'
      : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : ''
  if (bom) return { decoder: new TextDecoder(bom), from: 'bom' }
  const m = /;\s{0,20}charset\s{0,20}=\s{0,20}["']?([^"';\s]{1,40})/i.exec(String(contentTypeHeader).slice(0, 1024))
  const fromHeader = m && decoderFor(m[1])
  if (fromHeader) return { decoder: fromHeader, from: 'header' }
  const head = buf.subarray(0, 4096).toString('latin1')
  const mm = /<meta[^>]{0,512}?charset\s{0,10}=\s{0,10}["']?\s{0,10}([A-Za-z0-9_\-:.]{1,40})/i.exec(head)
  let fromMeta = mm && decoderFor(mm[1])
  if (fromMeta && fromMeta.encoding.startsWith('utf-16')) fromMeta = new TextDecoder('utf-8')
  if (fromMeta) return { decoder: fromMeta, from: 'meta' }
  return { decoder: new TextDecoder('utf-8'), from: 'default' }
}
