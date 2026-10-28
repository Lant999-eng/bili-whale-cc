// node --import 用：假的视频接口（看片记录的测试：debrief / subtitles / comments / watch-video / video）
//   TEST_VIDEO_FILE：{
//     loggedIn: true | false,                                     // nav 说没登录时（凭据过期），字幕接口回空列表不等于「没有字幕」
//     view: { code?, title, owner, duration, aid, cid, pic, parts },
//     player: { code?, subtitles: [{ lan, subtitle_url }], aiStatus?, needLogin? },   // x/player/wbi/v2
//     webview: { code?, subtitles: [...] },                       // x/v2/subtitle/web/view（兜底）
//     subBody: [{ from, to, content }] | 404,                     // 字幕文件
//     danmaku: ['…'] | 'fail' | 'deflate:a,b' | 'garbage',        // comment.bilibili.com/<cid>.xml（deflate：压缩流；garbage：解不开的二进制）
//     replies: [{ rpid, content: { message }, member: { uname } }] | { code },   // x/v2/reply
//     replyCount?, emptyFromPage?,                                // 评论总数、从第几页起是空页
//     cover: 200 | 404, playurl: { code?, durl? }
//     view.pageDuration：每 P 的时长（默认 总时长 / P 数）；subBody 'junk'：不是 JSON；replyCount 'none'：接口不给总数
//     media: 'ok' | '404' | 'cut' | 'junk'（playurl 给的直链下载时：真视频（mediaFile）/ 404 / 下到一半断 / 不是视频）
//     subBody / danmaku / cover 也可以是 'netfail'（断网：fetch 直接抛 TypeError）· 'timeout'（调用方给的时限到了）· 'cut'（subBody / cover：读正文时断了）
//   }
//   TEST_REQUESTS：每个请求记一行 { url, timed }（timed：调用方有没有给时限 signal）
import fs from 'node:fs'
import zlib from 'node:zlib'
const json = (d, status = 200) => ({ ok: status < 300, status, json: async () => d, text: async () => JSON.stringify(d), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(d)).buffer, headers: { get: () => null } })
const raw = (body, status = 200) => { const b = Buffer.from(body); return { ok: status < 300, status, text: async () => b.toString('utf8'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => JSON.parse(b.toString('utf8')), headers: { get: () => null } } }
const xml = (list) => `<?xml version="1.0"?><i>${list.map((t, i) => `<d p="${i + 1}.0,1,25,16777215,0,0,0,0">${t}</d>`).join('')}</i>`
// 断网 / 时限到了：和真 fetch 抛的一样（时限只在调用方给了 signal 时才会到 —— 没给的话真网络上会一直卡着）
const netFail = (mode, init) => {
  if (mode === 'netfail') throw new TypeError('fetch failed')
  if (mode === 'timeout') throw init?.signal ? new DOMException('The operation was aborted due to timeout', 'TimeoutError') : new Error('没给时限：真网络上会一直卡着')
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (process.env.TEST_REQUESTS) fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ url: u, timed: Boolean(init?.signal) }) + '\n')
  const spec = JSON.parse(fs.readFileSync(process.env.TEST_VIDEO_FILE, 'utf8'))
  const v = spec.view ?? {}
  if (u.includes('/x/web-interface/nav')) {
    const login = spec.loggedIn !== false
    return json({ code: login ? 0 : -101, data: { isLogin: login, ...(login ? { mid: 333, uname: 'TestBot' } : {}), wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })
  }
  if (u.includes('/x/web-interface/wbi/view') || u.includes('/x/web-interface/view')) {
    if (v.code && v.code !== 0) return json({ code: v.code, message: 'mock view error' })
    const cid = v.cid ?? 279786
    return json({ code: 0, data: { aid: v.aid ?? 170001, cid, bvid: v.bvid, title: v.title ?? '测试视频', duration: v.duration ?? 90, pic: v.pic ?? 'https://i0.hdslb.com/bfs/archive/cover.jpg', owner: { name: v.owner ?? 'UP主', mid: 42 }, pages: Array.from({ length: v.parts ?? 1 }, (_, i) => ({ cid: cid + i, page: i + 1, duration: v.pageDuration ?? Math.round((v.duration ?? 90) / (v.parts ?? 1)) })), tname: '知识', pubdate: 1700000000, desc: '简介', stat: { view: 1, like: 1, favorite: 1, coin: 1, danmaku: 3, reply: 2 } } })
  }
  if (u.includes('/x/player/wbi/v2')) {
    const p = spec.player ?? {}
    if (p.code && p.code !== 0) return json({ code: p.code, message: 'mock player error' })
    return json({ code: 0, data: { need_login_subtitle: Boolean(p.needLogin), subtitle: { subtitles: p.subtitles ?? [], ai_status: p.aiStatus ?? 0 } } })
  }
  if (u.includes('/x/v2/subtitle/web/view')) {
    const w = spec.webview ?? {}
    if (w.code && w.code !== 0) return json({ code: w.code, message: 'mock webview error' })
    return json({ code: 0, data: { subtitle: { subtitles: w.subtitles ?? [] } } })
  }
  if (u.includes('subtitle.example') || u.includes('/bfs/subtitle/')) {
    if (spec.subBody === 404) return raw('nope', 404)
    if (spec.subBody === 'junk') return raw('<html>not json</html>')
    netFail(spec.subBody, init)
    if (spec.subBody === 'cut') { const cut = async () => { throw new TypeError('terminated') }; return { ok: true, status: 200, text: cut, json: cut, arrayBuffer: cut, headers: { get: () => null } } }
    return json({ body: spec.subBody ?? [] })
  }
  if (u.includes('comment.bilibili.com/')) {
    const d = spec.danmaku ?? []
    if (d === 'fail') return raw('', 412)
    netFail(d, init)
    if (d === 'garbage') return raw(Buffer.from([0x78, 0x9c, 1, 2, 3, 4, 5, 6, 7, 8]))
    if (typeof d === 'string' && d.startsWith('deflate:')) return raw(zlib.deflateRawSync(Buffer.from(xml(d.slice(8).split(',').filter(Boolean)))))
    return raw(xml(d))
  }
  if (u.includes('/x/v2/reply?')) {
    const r = spec.replies ?? []
    if (!Array.isArray(r)) return json({ code: r.code ?? -404, message: 'mock reply error' })
    const pn = Number(new URL(u).searchParams.get('pn') ?? 1)
    const list = spec.emptyFromPage && pn >= spec.emptyFromPage ? [] : r
    return json({ code: 0, data: { replies: list.map((x, i) => ({ rpid: x.rpid ?? i + 1, like: 1, rcount: 0, ctime: 1700000000, member: { uname: x.member?.uname ?? '路人', mid: 7 }, content: { message: x.content?.message ?? '好看' } })), page: spec.replyCount === 'none' ? {} : { count: spec.replyCount ?? r.length }, top_replies: [] } })
  }
  if (u.includes('/x/player/playurl') || u.includes('/x/player/wbi/playurl')) {
    const p = spec.playurl ?? { code: 0 }
    return json({ code: p.code ?? 0, message: 'mock', data: p.durl ? { durl: p.durl, quality: 64 } : {} })
  }
  if (u.includes('upos.example/')) {
    const m = spec.media ?? 'ok'
    if (m === '404') return new Response('nope', { status: 404 })
    if (m === 'junk') return new Response('this is not a video')
    if (m === 'cut') {
      let sent = false
      return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(1024)) } else c.error(new Error('connection reset')) } }))
    }
    return new Response(fs.readFileSync(spec.mediaFile))
  }
  if (u.includes('/bfs/archive/')) {
    netFail(spec.cover, init)
    if (spec.cover === 'cut') { const cut = async () => { throw new TypeError('terminated') }; return { ok: true, status: 200, text: cut, json: cut, arrayBuffer: cut, headers: { get: () => null } } }
    return spec.cover === 404 ? raw('not found', 404) : raw(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
  }
  throw new Error('unexpected request ' + u)
}
