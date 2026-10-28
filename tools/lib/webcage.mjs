// 网络笼子：读书回合的文字浏览器（web search / open / more）每个请求、每一跳跳转都先过这里，真正连上时再查一次。
// 网页是对方写的，不能让它把请求引到主人家里：
//   路由器（192.168.x.x 这类内网地址）、本机开着的各种服务、这台电脑自己的公网 IPv6。
//   · 地址规则是「只放行」：IPv4 只放公网（IANA 特殊用途段全挡），IPv6 只放 2000::/3 再扣掉特殊段；本机自己的地址和同一个 /64 也挡
//   · 网址里直接写 IP 的当场查（Node 不走 lookup）；写域名的在 lookup 里查：一次要回所有地址，有一个不合规就整个不连
//   · 屏蔽名单（默认 B站 全家）按统一写法比：小写、去掉结尾的点、punycode
//   · policyOverride 只给测试用（放行列出来的那几个地址 / 端口），只能从参数传；不读环境变量、不读配置
import dns from 'node:dns'
import os from 'node:os'
import { domainToASCII } from 'node:url'

export const MAX_URL = 2048

// B站 一家的域名（主站、短链、图片 / 视频 CDN、接口、游戏、漫画、海外版……）。调用的一方把配置里的名单并进来
export const DEFAULT_BLOCK = Object.freeze([
  'bilibili.com', 'bilibili.cn', 'bilibili.tv', 'bilibili.co', 'bilibili.net', 'bilibili.us',
  'b23.tv', 'acg.tv', 'hdslb.com', 'hdslb.net', 'hdslb.org',
  'bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'biliapi.com', 'biliapi.net',
  'bilicdn1.com', 'bilicdn2.com', 'bilicdn3.com', 'bilicdn4.com', 'acgvideo.com', 'biliimg.com', 'biliimg.net',
  'biligame.com', 'biligame.net', 'bilibiligame.net', 'biligo.com', 'bilibilipay.com', 'biliintl.com', 'bstarstatic.com',
  'bilicomic.com', 'bilicomics.com', 'bilibilicomics.com', 'bili22.cn', 'bili33.cn', 'bili2233.cn', 'im9.com',
  // B站 旗下的别的站（猫耳、BigFun）、B站 镜像；替人去取网页的转手服务（r.jina.ai、谷歌翻译的网页代理）
  'missevan.com', 'bigfun.cn', 'biliplus.com', 'r.jina.ai', 'translate.goog',
])
// 名单之外，名字里带这几个词的也当成 B站 一家（bilibilicomics.com 这种新开的域名；误挡几个粉丝站没关系）
const BILI_LIKE = /bilibili|hdslb|bilivideo|biliapi|biligame|bilicdn|biliimg|biliplus/
// 网址的路径 / 参数里夹着 B站 的地址（web.archive.org/save/https://space.bilibili.com/…、各种「替你取网页」的服务）：也不去
const BILI_IN_PATH = /bilibili|hdslb|bilivideo|biliapi|b23\.tv|acg\.tv|missevan|bigfun/

// 一看就是本机 / 局域网的名字（DNS 那一关也会挡，这里先挡一道）。
// 后面那几个是「名字里写什么 IP 就解析到什么」的通配 DNS（203-0-113-7.nip.io → 203.0.113.7）：网页拿它把请求引回主人家的公网 IP（经路由器回环进局域网）
const LOCAL_NAMES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'home.arpa', 'corp',
  'invalid', 'fritz.box', 'myfritz.box', 'fritz.nas', 'wpad',
  'nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me', 'lacolhost.com', 'localho.st', '1u.ms', 'rbndr.us', 'nip.direct']
/** 这个名字（统一写法之后）不能去：屏蔽名单、B站 一家、本机 / 局域网 / 通配 DNS 的名字 */
function nameRefused(h, hosts) { return hostBlocked(h, hosts) || BILI_LIKE.test(h) || hostBlocked(h, LOCAL_NAMES) }

const no = (why) => ({ ok: false, why })
const cageErr = (msg) => Object.assign(new Error(msg), { code: 'EWEBCAGE' })

// 去掉结尾的点（不用正则：一长串点也是线性的）
const stripDots = (s) => { let e = s.length; while (e > 0 && s[e - 1] === '.') e--; return s.slice(0, e) }

/** 主机名统一写法：小写、去掉结尾的点、IDN 转 punycode（全角字母、「。」也会被换掉）；不合法 → '' */
export function normalizeHost(h) {
  const s = stripDots(String(h ?? '').trim().toLowerCase())
  if (!s || s.length > 253 * 4) return ''
  return stripDots(domainToASCII(s) || '')
}

/** host 是不是在名单里（完全相同或是它的子域名）；名单里的项也按统一写法比，「*.x」「.x」都当成 x */
export function hostBlocked(host, blockList = DEFAULT_BLOCK) {
  const h = normalizeHost(host)
  if (!h) return false
  for (const raw of blockList ?? []) {
    const b = normalizeHost(String(raw ?? '').replace(/^\*?\./, ''))
    if (b && (h === b || h.endsWith('.' + b))) return true
  }
  return false
}

// ─────────────── 地址解析 ───────────────

/** IPv4：只认四段十进制（不认前导零、八进制、十六进制 —— WHATWG URL / DNS / socket 给的都是规范写法）→ 32 位无符号数；不是 → null */
export function parseV4(s) {
  s = String(s ?? '')
  if (s.length > 15) return null
  const p = s.split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || (x.length > 1 && x[0] === '0')) return null
    const v = Number(x)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** IPv6 → 8 个 16 位数；展开「::」、认结尾的 IPv4 写法、外面的方括号；带 zone（%eth0）的一律不认 → null */
export function parseV6(s) {
  s = String(s ?? '')
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (!s || s.length > 45 || s.includes('%')) return null
  let tail = []
  const lc = s.lastIndexOf(':')
  if (lc < 0) return null
  if (s.slice(lc + 1).includes('.')) {
    const v4 = parseV4(s.slice(lc + 1))
    if (v4 === null) return null
    tail = [Math.floor(v4 / 65536), v4 % 65536]
    s = s.slice(0, lc + 1)
    if (!s.endsWith('::')) s = s.slice(0, -1)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part) => {
    if (part === '') return []
    const g = part.split(':')
    for (const x of g) if (!/^[0-9a-fA-F]{1,4}$/.test(x)) return null
    return g.map((x) => parseInt(x, 16))
  }
  const head = groups(halves[0])
  if (!head) return null
  if (halves.length === 1) {
    const w = [...head, ...tail]
    return w.length === 8 ? w : null
  }
  const rest = groups(halves[1])
  if (!rest) return null
  const used = head.length + rest.length + tail.length
  if (used > 7) return null
  return [...head, ...new Array(8 - used).fill(0), ...rest, ...tail]
}

// 前 len 位一样不一样（16 位一组）
function v6In(w, p, len) {
  for (let i = 0; len > 0; i++, len -= 16) {
    const bits = Math.min(16, len)
    const mask = (0xffff << (16 - bits)) & 0xffff
    if ((w[i] & mask) !== (p[i] & mask)) return false
  }
  return true
}
const v4In = (n, base, len) => len === 0 || (n >>> (32 - len)) === (base >>> (32 - len))

// IPv4 不放行的段（IANA 特殊用途全部；255.255.255.255 在 240/4 里）。
// 28.0.0.0/8 不是特殊段，但代理软件常把 fake-ip 设在这里（真实主人是美国国防部，没有能读的网站）：一并不连
const V4_SPECIAL = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['28.0.0.0', 8],
].map(([a, l]) => [parseV4(a), l])
const FAKE_IP = [parseV4('198.18.0.0'), 15]
const FAKE_IP_ALT = [parseV4('28.0.0.0'), 8]

// IPv6 只放 2000::/3，再扣掉这些：IETF 协议段 2001::/23（Teredo 2001::/32、基准测试、ORCHID 2001:10::/28、ORCHIDv2 2001:20::/28 都在里面）、
//   文档 2001:db8::/32 和 3fff::/20、6to4 2002::/16（里面藏着 IPv4 地址）、早年的 6bone 3ffe::/16
const V6_SPECIAL = [
  ['2001::', 23], ['2001::', 32], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['3ffe::', 16],
].map(([a, l]) => [parseV6(a), l])

// 一个地址 → { v: 4, n } 或 { v: 6, w }；::ffff:a.b.c.d（含 ::ffff:c0a8:b201 写法）当成 IPv4
function toAddr(ip) {
  const s = String(ip ?? '').trim()
  const n = parseV4(s)
  if (n !== null) return { v: 4, n }
  const w = parseV6(s)
  if (!w) return null
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) return { v: 4, n: w[6] * 65536 + w[7] }
  return { v: 6, w }
}

/** 「a.b.c.d」「a.b.c.d/nn」「v6」「v6/nn」→ 匹配器；不是地址 → null（屏蔽名单里可以写 IP / 网段，比如家里的公网 IP） */
export function parseCidr(s) {
  const str = String(s ?? '').trim()
  const k = str.indexOf('/')
  const a = toAddr(k < 0 ? str : str.slice(0, k))
  if (!a) return null
  const max = a.v === 4 ? 32 : 128
  let len = max
  if (k >= 0) {
    if (!/^\d{1,3}$/.test(str.slice(k + 1))) return null
    len = Number(str.slice(k + 1))
    if (len > max) return null
  }
  return { ...a, len }
}
const cidrHas = (c, a) => c.v === a.v && (a.v === 4 ? v4In(a.n, c.n, c.len) : v6In(a.w, c.w, c.len))

// 本机网卡上的所有地址（每次现读：IPv6 隐私地址会换）
export function defaultLocalAddrs() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a?.address) out.push(a.address)
  return out
}
function readLocal(localAddrs) {
  const list = typeof localAddrs === 'function' ? localAddrs() : (localAddrs ?? defaultLocalAddrs())
  return [...list].map((x) => toAddr(String(x).split('%')[0])).filter(Boolean)
}

function v4Public(n) {
  for (const [b, l] of V4_SPECIAL) if (v4In(n, b, l)) return false
  return true
}
function v6Public(w) {
  if ((w[0] & 0xe000) !== 0x2000) return false
  for (const [p, l] of V6_SPECIAL) if (v6In(w, p, l)) return false
  return true
}

/**
 * 这个地址能不能连（「只放行」的写法）：公网 IPv4 / 2000::/3 里不特殊的 IPv6；不是本机自己的地址（IPv6 连同一个 /56）；不在 deny 里。
 * localAddrs：本机地址的数组或函数（默认每次现读网卡）；读不出来就一律不放。deny：屏蔽名单里的 IP / 网段
 */
export function addrAllowed(ip, { localAddrs, deny = [] } = {}) {
  const a = toAddr(ip)
  if (!a) return false
  if (a.v === 4 ? !v4Public(a.n) : !v6Public(a.w)) return false
  let own
  try { own = readLocal(localAddrs) } catch { return false }
  for (const o of own) {
    if (o.v !== a.v) continue
    // IPv6 挡同一个 /56：家里的宽带一般分到一个 /56（路由器别的子网也在里面），不只是这台电脑的 /64
    if (a.v === 4 ? o.n === a.n : v6In(a.w, o.w, 56)) return false
  }
  for (const d of deny) {
    const c = typeof d === 'string' ? parseCidr(d) : d
    if (c && cidrHas(c, a)) return false
  }
  return true
}

/** 两个写法是不是同一个地址（::ffff:127.0.0.1 和 127.0.0.1 算同一个） */
export function sameAddr(x, y) {
  const a = toAddr(x), b = toAddr(y)
  if (!a || !b || a.v !== b.v) return false
  return a.v === 4 ? a.n === b.n : a.w.every((v, i) => v === b.w[i])
}

// ─────────────── 名单 / 测试口子 ───────────────

// 屏蔽名单拆成两份：主机名 / IP 和网段；B站 全家总是在里面（调用的一方忘了并也挡）
function splitBlock(block) {
  const hosts = [...DEFAULT_BLOCK], deny = []
  for (const x of block ?? []) {
    const c = parseCidr(x)
    if (c) deny.push(c)
    else if (String(x ?? '').trim()) hosts.push(String(x))
  }
  return { hosts, deny }
}

// policyOverride（只给测试用）：{ addrs: ['127.0.0.1'], ports: [端口], lookup }。
//   addrs 里的地址（只认完全一样的）不管规则直接放；ports 里的端口能用；lookup 换掉笼子的 DNS 检查（只为了测「连上时再查一次」那一道）。
//   不传就是严格的笼子。命令层绝不能把配置 / 环境变量接到这里
function readOverride(po) {
  if (!po) return { addrs: [], ports: new Set(), lookup: null }
  return { addrs: [...(po.addrs ?? [])].map(String), ports: new Set([...(po.ports ?? [])].map(Number)), lookup: po.lookup ?? null }
}

/** 笼子的地址检查（连上时再查一次也用它）：policyOverride.addrs 里的放行，其余照 addrAllowed */
export function makeAddrCheck({ localAddrs, block, policyOverride } = {}) {
  const { deny } = splitBlock(block)
  const ov = readOverride(policyOverride)
  return (ip) => ov.addrs.some((x) => sameAddr(x, ip)) || addrAllowed(ip, { localAddrs, deny })
}

const ADDR_WHY = '不能连这个地址（内网、本机或特殊用途的地址）'

/**
 * 网址能不能去 → { ok: true, url } 或 { ok: false, why }。
 * 只认 http / https；不许带用户名密码；端口只能是默认、80 或 443；直接写 IP 的当场按 addrAllowed 查
 * （WHATWG URL 已经把 3232281089、0xc0a8b201、0300.0250.0262.01 这些写法换成了 a.b.c.d）；域名不能在屏蔽名单里、不能是本机 / 局域网的名字
 */
export function checkUrl(u, { block, localAddrs, policyOverride } = {}) {
  const s = typeof u === 'string' ? u : String(u ?? '')
  if (!s.trim()) return no('网址是空的')
  if (s.length > MAX_URL) return no('网址太长')
  let url
  try { url = new URL(s) } catch { return no('网址写得不对') }
  if (url.href.length > MAX_URL) return no('网址太长')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return no('只能打开 http / https 的网址')
  if (url.username || url.password) return no('网址里不能带用户名或密码')
  const ov = readOverride(policyOverride)
  if (url.port && url.port !== '80' && url.port !== '443' && !ov.ports.has(Number(url.port))) return no('只能用 80 / 443 端口')
  const host = url.hostname
  if (!host) return no('网址里没有主机名')
  // 直接写 IP 的一律不去（正经网站都有名字）：网页能看到请求是从哪个 IP 来的，再跳回这个 IP 就进了主人家的路由器（回环）。
  // 只有测试口子里列出来的地址能用（测试连本机的假服务器）
  const lit = host.startsWith('[') ? host.slice(1, -1) : parseV4(host) !== null ? host : null
  if (lit !== null) return ov.addrs.some((x) => sameAddr(x, lit)) ? { ok: true, url: url.href } : no('不能打开直接写 IP 的网址（只去有名字的网站）')
  const h = normalizeHost(host)
  if (!h) return no('主机名写得不对')
  if (!h.includes('.')) return no('不能连没有点的主机名（多半是本机或局域网里的）')
  if (hostBlocked(h, LOCAL_NAMES)) return no('不能连本机或局域网里的名字')
  if (nameRefused(h, splitBlock(block).hosts)) return no('这个网站在屏蔽名单里')
  let tail = url.pathname + url.search
  for (let i = 0; i < 3; i += 1) { try { const d = decodeURIComponent(tail); if (d === tail) break; tail = d } catch { break } }
  if (BILI_IN_PATH.test(tail.normalize('NFKC').toLowerCase())) return no('网址里夹着 B站 的地址（经别的网站转一道也不去）')
  return { ok: true, url: url.href }
}

// ─────────────── DNS ───────────────

const defaultResolve = (host) => dns.promises.lookup(host, { all: true, order: 'verbatim' })

/**
 * 给 http.request / net.connect 用的 lookup(hostname, options, cb)：一次解析出所有地址，有一个不合规就整个不连（错误码 EWEBCAGE）；
 * 全在 198.18.0.0/15 里 → 说像是开着代理的 TUN / fake-ip 模式。options.all（Node 20+ 自动选地址族时会传）→ 回整张表，否则回第一个。
 * resolve(host) 可以换成假的（测试用），回 [{ address, family }] 或地址字符串的数组
 */
export function makeLookup({ resolve = defaultResolve, localAddrs, block, policyOverride } = {}) {
  const check = makeAddrCheck({ localAddrs, block, policyOverride })
  const { hosts } = splitBlock(block)
  return function lookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {} }
    if (typeof options === 'number') options = { family: options }
    options = options ?? {}
    const host = String(hostname ?? '')
    Promise.resolve().then(async () => {
      let list
      const lit = parseV4(host) !== null ? 4 : parseV6(host) ? 6 : 0
      if (lit) list = [{ address: host, family: lit }]
      else {
        const h = normalizeHost(host)
        if (!h || nameRefused(h, hosts)) throw cageErr('这个网站不能连（屏蔽名单或本机的名字）')
        const got = await resolve(host)
        list = [...(got ?? [])].map((x) => (typeof x === 'string' ? { address: x } : { address: String(x?.address ?? ''), family: x?.family }))
          .map((x) => ({ address: x.address, family: parseV4(x.address) !== null ? 4 : 6 }))
      }
      if (!list.length) throw Object.assign(new Error(`找不到 ${host}`), { code: 'ENOTFOUND' })
      const v4s = list.map((x) => parseV4(x.address))
      if (v4s.every((n) => n !== null && (v4In(n, ...FAKE_IP) || v4In(n, ...FAKE_IP_ALT)))) {
        throw cageErr('解析出来的地址全在 198.18.0.0/15 或 28.0.0.0/8（像是开着代理的 TUN / fake-ip 模式），不连 —— 请主人先关掉代理的 TUN 模式')
      }
      if (!list.every((x) => check(x.address))) throw cageErr(`${host} 解析到了不能连的地址（内网、本机或特殊用途），整个不连`)
      const fam = Number(options.family) || 0
      const pick = fam === 4 || fam === 6 ? list.filter((x) => x.family === fam) : list
      if (!pick.length) throw Object.assign(new Error(`找不到 ${host} 的 IPv${fam} 地址`), { code: 'ENOTFOUND' })
      return pick
    }).then((pick) => {
      if (options.all) cb(null, pick.map((x) => ({ address: x.address, family: x.family })))
      else cb(null, pick[0].address, pick[0].family)
    }, (e) => cb(e))
  }
}

// ─────────────── 环境变量 ───────────────

// 代理相关的环境变量（大小写都算）：读书回合不能经过任何代理
const PROXY_ENV = /^(?:(?:http|https|ftp|all|no|socks|socks4|socks5|grpc|wss?)_proxy|node_use_env_proxy|global_agent_.*|npm_config_(?:https_|http_)?proxy|npm_config_no_?proxy|yarn_(?:https_|http_)?proxy)$/i

/**
 * 像不像开着代理的 TUN 模式（Clash / mihomo / sing-box / v2rayN / Xray / Hiddify / NekoBox 的虚拟网卡，或者网卡上有 198.18.x、28.x 的地址）→ 网卡名 / null。
 * 开着的时候代理会自己再解析一遍网址（fake-ip、嗅探改目标）：笼子查过的地址不一定是真正连上的地址 —— 读书先不上网。
 * 只认得出常见的几种：名字和地址都换了的认不出（交接说明里写着）
 */
const TUN_NAME = /clash|mihomo|\bmeta\b|sing-?box|wintun|xray|v2ray|tun2socks|\btun\d*\b|utun|hiddify|neko|karing|throne/i
export function tunSuspect(ifaces = os.networkInterfaces()) {
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    if (TUN_NAME.test(name)) return name
    for (const a of list ?? []) { const n = parseV4(String(a?.address ?? '')); if (n !== null && (v4In(n, ...FAKE_IP) || v4In(n, ...FAKE_IP_ALT))) return name }
  }
  return null
}

/** 环境变量的一份拷贝，去掉所有代理设置（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY / NODE_USE_ENV_PROXY …，大小写都算） */
export function stripProxyEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env ?? {})) if (!PROXY_ENV.test(k)) out[k] = v
  return out
}

export { cageErr }
