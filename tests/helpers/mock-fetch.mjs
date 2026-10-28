import fs from 'node:fs'
// 私信接口的回包：msg_key 和真接口一样是裸的大整数（dm.json 里写成字符串，回包时去掉引号）
const imText = (d) => JSON.stringify(d).replace(/"msg_key":"(\d+)"/g, '"msg_key":$1')
const imResp = (d) => ({ status: 200, ok: true, json: async () => JSON.parse(imText(d)), text: async () => imText(d) })   // json() 和真的一样会把大整数变成近似值
globalThis.fetch = async (url, opts = {}) => {
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:String(url),method:opts.method ?? 'GET'})+'\n')
  let data
  if (String(url).includes('/x/v2/reply/reply')) {
    const u = new URL(url)
    data = u.searchParams.get('type') === '11' && u.searchParams.get('root') === '9'
      ? { code: 0, data: { replies: [], root: { rpid: 9, mid: 222, member: { uname: 'Owner' } } } }
      : { code: -404 }
    return { status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) }   // comment 查被回复者走 apiGet（读 text）
  }
  // 私信：TEST_DM_FILE 是 { messages: [...], others: [...] }（主人会话里的全部消息 + 别的会话），或者旧格式的一条 last_msg
  const dmLog = () => {
    const raw = JSON.parse(fs.readFileSync(process.env.TEST_DM_FILE, 'utf8'))
    if (Array.isArray(raw.messages)) return raw
    return { messages: [{ msg_seqno: Number(raw.msg_seqno ?? raw.msg_key ?? 1), msg_type: 1, ...raw }] }
  }
  if (process.env.TEST_DM_FILE && String(url).includes('/get_sessions')) {
    if (process.env.TEST_DM_SESSIONS_FAIL_FILE && fs.existsSync(process.env.TEST_DM_SESSIONS_FAIL_FILE)) throw Error('mock: get_sessions unavailable')   // 存在 = 会话列表也取不到
    const { messages, others = [], ownerMissing } = dmLog()
    const max = Math.max(0, ...messages.map((m) => Number(m.msg_seqno)))
    const owner = { talker_id: 222, session_type: 1, max_seqno: max, last_msg: messages.find((m) => Number(m.msg_seqno) === max) ?? null }
    data = { code: 0, data: { session_list: [...others, ...(ownerMissing ? [] : [owner])] } }
    return imResp(data)
  }
  if (process.env.TEST_DM_FILE && String(url).includes('/fetch_session_msgs')) {
    // TEST_DM_FAIL=1 / TEST_DM_FAIL_FILE 存在：接口出错 · TEST_DM_NEWEST=1：给「最新的一页」（另一种可能的真实语义），认 end_seqno（只给比它小的）·
    // TEST_DM_NO_END=1：不认 end_seqno
    if (process.env.TEST_DM_FAIL === '1' || (process.env.TEST_DM_FAIL_FILE && fs.existsSync(process.env.TEST_DM_FAIL_FILE))) throw Error('mock: fetch_session_msgs unavailable')
    const u = new URL(String(url))
    if (u.searchParams.get('talker_id') !== '222') { data = { code: 0, data: { messages: [], has_more: 0 } }; return imResp(data) }
    const begin = Number(u.searchParams.get('begin_seqno') ?? 0), size = Number(u.searchParams.get('size') ?? 20)
    // TEST_DM_MODE_FILE（里面写 newest / noend）：跑到一半改接口的行为（scheduler 的子进程环境在启动时就定下了）
    const mode = process.env.TEST_DM_MODE_FILE && fs.existsSync(process.env.TEST_DM_MODE_FILE) ? fs.readFileSync(process.env.TEST_DM_MODE_FILE, 'utf8') : ''
    const end = process.env.TEST_DM_NO_END === '1' || mode.includes('noend') ? 0 : Number(u.searchParams.get('end_seqno') ?? 0)
    const after = dmLog().messages.filter((m) => Number(m.msg_seqno) > begin && (!end || Number(m.msg_seqno) < end)).sort((a, b) => Number(a.msg_seqno) - Number(b.msg_seqno))
    const page = process.env.TEST_DM_NEWEST === '1' || mode.includes('newest') ? after.slice(-size) : after.slice(0, size)
    data = { code: 0, data: { messages: page.reverse(), has_more: after.length > size ? 1 : 0 } }   // 新的在前（和真接口一样）
    return imResp(data)
  }
  if (process.env.TEST_FEEDS && String(url).includes('/x/msgfeed/')) {
    const feeds=JSON.parse(fs.readFileSync(process.env.TEST_FEEDS,'utf8'))
    const kind=new URL(String(url)).pathname.split('/').pop()
    if(feeds[kind]?.error)throw Error('mock inbox unavailable')
    data={code:0,data:{items:feeds[kind]??[]}}
    return {status:200,ok:true,json:async()=>data}
  }
  if (String(url).includes('/nav')) data={code:0,data:{isLogin:true,mid:111,uname:'test-account'}}
  else if(String(url).includes('/x/relation'))data={code:0,data:{attribute:6}}
  else if(String(url).includes('/send_msg'))data={code:0,data:{}}
  else throw Error('Network blocked by test: '+url)
  return {status:200,ok:true,json:async()=>data}
}
