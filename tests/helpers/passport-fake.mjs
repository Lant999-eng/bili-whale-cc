// 假的 B站 passport（扫码登录）/ nav / spi：给 host/bililogin.mjs、core.writeCookie 注入 fetch 用
//   polls：每次查扫码进度依次返回什么（waiting / scanned / expired / success / throw；用完了就一直是最后一个）
//   polls 里还可以有：weird（没见过的扫码状态）/ throwSecret（出错信息里带着 cookie 样子的字）
//   navCode：0 = 认得（返回 mid / name）；-101 = 没登录；'throw' = 网络不通；'throwHeader' = 本地报错、信息里带着整条 cookie；{ raw: 回包 }；也可以是函数（按次数变；返回 Promise = 这次请求挂着，等它给出答案才回）
//   sess / jct：登录成功时给的 cookie 值（默认 SESS / JCT）；noDede：成功时不给 DedeUserID；genUrl / genKey：二维码接口回的地址 / key；polls 里 outer412：外层 code=-412（风控）
export const SESS = 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1'
export const JCT = 'f'.repeat(32)
export const REFRESH = 'fakeREFRESHtoken0123456789'
export const SPI = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE12345infoc'

export function fakeBili({ polls = ['waiting', 'scanned', 'success'], mid = '333', name = 'TestBot', navCode = 0, setCookie = true, inUrl = true, dedeMid = null, genFail = false, sess = SESS, jct = JCT, noDede = false, genUrl = null, genKey = null } = {}) {
  const calls = []
  let gen = 0, poll = 0, nav = 0
  const res = (body, cookies = []) => ({
    ok: true, status: 200, json: async () => body,
    headers: { getSetCookie: () => cookies, get: (k) => (k === 'set-cookie' && cookies.length ? cookies.join(', ') : null) },
  })
  const fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, cookie: opts.headers?.cookie ?? null })
    if (u.includes('/qrcode/generate')) {
      gen += 1
      if (genFail) return res({ code: -400, message: 'nope' })
      const key = genKey ?? `KEY${gen}`.padEnd(32, 'x')
      return res({ code: 0, data: { url: genUrl ?? `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${key}&from=`, qrcode_key: key } })
    }
    if (u.includes('/qrcode/poll')) {
      const st = polls[Math.min(poll, polls.length - 1)]
      poll += 1
      if (st === 'throw') throw new Error(`connect ECONNRESET ${u}`)
      if (st === 'throwSecret') throw new Error('proxy said: SESSDATA=topsecretvalue; refresh_token=alsosecret')
      if (st === 'outer412') return res({ code: -412, message: 'request was banned' })
      if (st === 'weird') return res({ code: 0, data: { code: 99999, message: 'new state', url: '', refresh_token: '' } })
      const code = { waiting: 86101, scanned: 86090, expired: 86038, success: 0 }[st]
      if (st !== 'success') return res({ code: 0, data: { code, message: st, url: '', refresh_token: '', timestamp: 0 } })
      const dede = dedeMid ?? mid
      const q = inUrl ? `${noDede ? '' : `DedeUserID=${dede}&DedeUserID__ckMd5=abc&`}Expires=1999999999&SESSDATA=${sess}&bili_jct=${jct}&gourl=https%3A%2F%2Fwww.bilibili.com` : 'gourl=https%3A%2F%2Fwww.bilibili.com'
      return res({ code: 0, data: { code: 0, message: '', url: `https://passport.biligame.com/x/passport-login/web/crossDomain?${q}`, refresh_token: REFRESH, timestamp: 1 } },
        setCookie ? [`SESSDATA=${sess}; Path=/; Domain=bilibili.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; Secure`, `bili_jct=${jct}; Path=/; Domain=bilibili.com`, ...(noDede ? [] : [`DedeUserID=${dede}; Path=/; Domain=bilibili.com`]), 'sid=abcdef; Path=/'] : [])
    }
    if (u.includes('/web-interface/nav')) {
      const nc = typeof navCode === 'function' ? await navCode(nav++, opts.headers?.cookie) : navCode
      if (nc === 'throw') throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.bilibili.com'), { code: 'ENOTFOUND' }) })
      if (nc === 'throwHeader') throw new TypeError(`Headers.append: "${opts.headers?.cookie}" is an invalid header value.`)
      if (nc && typeof nc === 'object' && nc.raw) return res(nc.raw)
      if (nc && typeof nc === 'object') return res({ code: 0, data: { isLogin: true, mid: Number(nc.mid), uname: nc.name ?? 'x' } })
      return res(nc === 0 ? { code: 0, data: { isLogin: true, mid: Number(mid), uname: name } } : { code: nc, message: '账号未登录', data: { isLogin: false } })
    }
    if (u.includes('/finger/spi')) return res({ code: 0, data: { b_3: SPI, b_4: 'x' } })
    throw new Error('unexpected request ' + u)
  }
  return { fetch, calls }
}

/** 假的终端：answers 依次回答问题（用完 = 读到头 null）；sleep 只推进假时钟；onAsk 在每次提问时调（看那一刻有没有写过东西） */
export function io(answers = [], { onAsk = null, show = true } = {}) {
  const said = [], asked = [], shown = []
  let t = 1_700_000_000_000
  return {
    said, asked, shown,
    show: (url) => { shown.push(url); return show },
    say: (s) => said.push(String(s)),
    ask: async (q) => { asked.push(String(q)); onAsk?.(q); return answers.length ? answers.shift() : null },
    sleep: async (ms) => { t += ms },
    now: () => t,
  }
}
