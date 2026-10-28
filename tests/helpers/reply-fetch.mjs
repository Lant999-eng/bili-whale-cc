// 测试用（NODE_OPTIONS=--import 预加载）：评论区接口里 rpid=9 那条评论的作者 = PARENT_MID；HTTP_STATUS 可以模拟 412；其余一律 code 0，不碰网络
//   REPLY_LOG：每发一次 reply/add 往这个文件追加一行（数真正发出去几条）
//   REPLY_DELAY_MS：reply/add 晚这么久才回（让两个进程的发送重叠）
//   REPLY_CODE：reply/add 回这个 code（比如 12051 = 明确没收）；REPLY_CODE=garbage 回一段读不出来的东西（结果不确定）
import fs from 'node:fs'

//   PARENT_DELAY_MS：查「被回复的是谁」（reply/reply）卡这么久（认 AbortSignal：超时就中断）
//   THREAD_COUNT：长楼 —— 楼主那条（rpid 9）是别人发的，下面有这么多条楼中楼（按 pn / ps 分页，data.page 照真接口给 count / size）
//   THREAD_TARGET：PARENT_MID 发的那条（rpid 777）是楼里第几条（从 1 数；不给 = 楼里没有它，比如被删了）
//   THREAD_LOG：每查一页 reply/reply 往这个文件追加一行页码；THREAD_FAIL_PN：查这一页时网络出错
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const status = Number(process.env.HTTP_STATUS ?? 200)
  let data = { code: 0, message: '0', data: {} }
  // 请求一到就记页码（在卡住之前）：卡到超时被中断的那一页也算请求过
  if (u.includes('/x/v2/reply/reply') && process.env.THREAD_COUNT && process.env.THREAD_LOG) fs.appendFileSync(process.env.THREAD_LOG, `${new URL(u).searchParams.get('pn') ?? 1}\n`)
  if (u.includes('/x/v2/reply/reply') && process.env.PARENT_DELAY_MS) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, Number(process.env.PARENT_DELAY_MS))
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason ?? new Error('aborted')) })
    })
  }
  if (u.includes('/x/v2/reply/reply') && process.env.THREAD_COUNT) {
    const q = new URL(u).searchParams, pn = Number(q.get('pn') ?? 1), ps = Number(q.get('ps') ?? 20)
    const n = Number(process.env.THREAD_COUNT), at = Number(process.env.THREAD_TARGET ?? 0)
    if (String(pn) === process.env.THREAD_FAIL_PN) throw new TypeError('fetch failed')
    const replies = []
    for (let i = (pn - 1) * ps + 1; i <= Math.min(n, pn * ps); i += 1) {
      replies.push(i === at
        ? { rpid: 777, rpid_str: '777', mid: Number(process.env.PARENT_MID ?? 1), mid_str: String(process.env.PARENT_MID ?? 1), member: { uname: '路人乙' }, content: { message: `我是楼里第 ${i} 条` } }
        : { rpid: 1000 + i, rpid_str: String(1000 + i), mid: 8000 + i, mid_str: String(8000 + i), member: { uname: '楼里' + i }, content: { message: '路过' } })
    }
    data = { code: 0, data: { page: { num: pn, size: ps, count: n }, replies, root: { rpid: 9, rpid_str: '9', mid: 4321, mid_str: '4321', member: { uname: '楼主' }, content: { message: '楼主的话' } } } }
  }
  else if (u.includes('/x/v2/reply/reply') && new URL(u).searchParams.get('root') === '0') data = { code: 0, data: { replies: [] } }   // 和真接口一样：root=0 什么都查不到
  else if (u.includes('/x/v2/reply/reply')) data ={ code: 0, data: { replies: [], root: { rpid: 9, rpid_str: '9', mid: Number(process.env.PARENT_MID ?? 1), mid_str: String(process.env.PARENT_MID ?? 1), member: { uname: '路人甲' }, content: { message: '你好呀' } } } }
  else if (u.includes('/x/v2/reply/add')) {
    if (process.env.REPLY_LOG) fs.appendFileSync(process.env.REPLY_LOG, `${process.pid}\n`)
    if (process.env.REPLY_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.REPLY_DELAY_MS)))
    if (process.env.REPLY_CODE === 'garbage') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
    data = status !== 200 ? { code: -412, message: 'request was banned' }
      : process.env.REPLY_CODE ? { code: Number(process.env.REPLY_CODE), message: 'no' }
      : { code: 0, data: { rpid: 12345 } }
  }
  else if (u.includes('/x/web-interface/view')) data = { code: 0, data: { aid: Number(process.env.VIEW_AID ?? 1), title: 't', owner: { name: 'u' } } }
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
