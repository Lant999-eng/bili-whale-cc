// 测试用（NODE_OPTIONS=--import 预加载）：长楼 + 大 id 的假接口，不碰网络
//   reply/reply：楼里一共 THREAD_N 条楼中楼（按时间正序，最老的在第 1 页；data.page 照真接口给 count / size）
//     THREAD_HIS_MID：「他」的 mid（可以超过 2^53）；THREAD_HIS_AT：他的回复在楼里第几条（逗号分隔，从 1 数）
//     THREAD_HIS_PARENT：他那几条挂在哪条评论下（parent；不给 = 挂在楼主那条下；逗号分隔 = 和 THREAD_HIS_AT 一一对应）
//     THREAD_RPID_BASE：第 i 条的 rpid = 它 + i（默认 5000；给个超过 2^53 的看 rpid 会不会失真）
//     THREAD_ROOT_MID：楼主那条（data.root，rpid = 请求的 root）是谁发的（默认 4321）
//     THREAD_NO_COUNT=1：data.page 不给总条数；THREAD_DELAY_MS：每页晚这么久才回（认 AbortSignal）
//     THREAD_FAIL_PN：查这一页时接口回 code=-404；THREAD_LOG：每查一页往这个文件追加一行页码
//     THREAD_COOKIE_LOG：每查一页往这个文件追加一行请求带的 cookie（看调用方给的请求头有没有带到）
//   mid / rpid / parent 和真接口一样：数字形式是裸的 JSON 数字（超过 2^53 就失真），另有 *_str 字符串形式
//   msgfeed：/x/msgfeed/reply、/x/msgfeed/at 原样回 FEED_REPLY / FEED_AT 文件里的文字（里面可以有裸的大整数）；
//     带 id 参数的（第 2 页）回 FEED_REPLY_2 / FEED_AT_2（FEED_2_NETFAIL=1：第 2 页断网）；FEED_LOG：每个请求的网址记一行
import fs from 'node:fs'

// 先把 id 写成字符串，再去掉数字形式的引号（和真接口一样是裸数字）
const raw = (d) => JSON.stringify(d).replace(/"(mid|rpid|parent|root)":"(\d+)"/g, '"$1":$2')
const ok = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url))
  if (u.pathname === '/x/v2/reply/reply') {
    const pn = Number(u.searchParams.get('pn') ?? 1), ps = Number(u.searchParams.get('ps') ?? 20)
    if (process.env.THREAD_LOG) fs.appendFileSync(process.env.THREAD_LOG, `${pn}\n`)
    if (process.env.THREAD_COOKIE_LOG) fs.appendFileSync(process.env.THREAD_COOKIE_LOG, `${new Headers(opts.headers ?? {}).get('cookie') ?? ''}\n`)
    if (process.env.THREAD_DELAY_MS) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, Number(process.env.THREAD_DELAY_MS))
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason ?? new Error('aborted')) })
      })
    }
    if (String(pn) === process.env.THREAD_FAIL_PN) return ok(JSON.stringify({ code: -404, message: '啥都木有' }))
    const n = Number(process.env.THREAD_N ?? 0), root = String(u.searchParams.get('root'))
    const his = String(process.env.THREAD_HIS_MID ?? ''), hisAt = String(process.env.THREAD_HIS_AT ?? '').split(',').filter(Boolean).map(Number), at = new Set(hisAt)
    const parents = String(process.env.THREAD_HIS_PARENT ?? '').split(',')   // 一个 = 他每条都挂在它下面；几个 = 和 THREAD_HIS_AT 一一对应（空 = 挂在楼主下）
    const parentOf = (i) => (parents.length > 1 ? parents[hisAt.indexOf(i)] : parents[0]) || root
    const base = BigInt(process.env.THREAD_RPID_BASE ?? '5000'), replies = []
    for (let i = (pn - 1) * ps + 1; i <= Math.min(n, pn * ps); i += 1) {
      const mine = at.has(i), mid = mine ? his : String(8000 + i), parent = mine ? parentOf(i) : root
      const rpid = String(base + BigInt(i))
      replies.push({ rpid, rpid_str: rpid, mid, mid_str: mid, parent, parent_str: parent, root, root_str: root,
        ctime: 1_700_000_000 + i, member: { mid, uname: mine ? '他' : '楼里' + i }, content: { message: mine ? `他在楼里第 ${i} 条` : '路过' } })
    }
    const page = process.env.THREAD_NO_COUNT === '1' ? { num: pn, size: ps } : { num: pn, size: ps, count: n }
    const rootMid = process.env.THREAD_ROOT_MID ?? '4321'   // 楼主是谁（给成「他」= 他那条就是顶层评论）
    return ok(raw({ code: 0, data: { page, replies, root: { rpid: root, rpid_str: root, mid: rootMid, mid_str: rootMid, ctime: 1_700_000_000, member: { uname: '楼主' }, content: { message: '楼主的话' } } } }))
  }
  if (u.pathname === '/x/msgfeed/reply' || u.pathname === '/x/msgfeed/at') {
    if (process.env.FEED_LOG) fs.appendFileSync(process.env.FEED_LOG, u.href + '\n')
    // 带着 id（按 cursor 翻页）要的是第 2 页：FEED_REPLY_2 / FEED_AT_2；没给就是空的一页
    const second = u.searchParams.has('id'), at = u.pathname.endsWith('/at')
    if (second && process.env.FEED_2_NETFAIL) throw new TypeError('fetch failed')   // 第 2 页断网
    const f = second ? (at ? process.env.FEED_AT_2 : process.env.FEED_REPLY_2) : (at ? process.env.FEED_AT : process.env.FEED_REPLY)
    return ok(f ? fs.readFileSync(f, 'utf8') : JSON.stringify({ code: 0, data: { items: [] } }))
  }
  throw new Error('Network blocked by test: ' + u.href)
}
