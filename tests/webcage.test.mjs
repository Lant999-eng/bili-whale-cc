// 网络笼子（tools/lib/webcage.mjs）：地址规则表（IPv4 / IPv6 / ::ffff: / 本机地址 / 本机 /64）、网址的各种写法、
//   屏蔽名单的统一写法、lookup（有一个坏地址就整个拒、all:true / all:false 的样子、fake-ip 提示、每次重查）、去掉代理环境变量。
// 全部离线：假的解析器、假的网卡，不碰真的 DNS
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const {
  addrAllowed, checkUrl, makeLookup, normalizeHost, hostBlocked, stripProxyEnv, parseV6, parseV4, DEFAULT_BLOCK, sameAddr, tunSuspect,
} = await import(pathToFileURL(path.join(root, 'tools/lib/webcage.mjs')).href)

// 假的本机地址：局域网 IPv4、两个公网 IPv6（同一个 /64）、链路本地、回环、一个假设的本机公网 IPv4
const OWN = ['192.168.178.23', '2003:e1:1234:5600:aaaa:bbbb:cccc:dddd', '2003:e1:1234:5600::42', 'fe80::1%7', '127.0.0.1', '::1', '85.10.20.30']

const ALLOW = [
  '8.8.8.8', '1.1.1.1', '93.184.216.34', '11.0.0.1', '100.63.255.255', '100.128.0.0', '169.253.1.1', '172.15.255.255', '172.32.0.0',
  '192.0.1.1', '192.88.98.1', '192.167.255.255', '192.169.0.1', '198.17.255.255', '198.20.0.1', '203.0.114.1', '223.255.255.255',
  '85.10.20.31',
  '2606:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888', '2400:cb00::1', '2001:200::1', '[2606:4700::1111]',
  '2003:e1:1234:5701::1', '::ffff:8.8.8.8', '::ffff:808:808', '2620:fe::fe',
]
const DENY = [
  // IPv4 特殊段
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
  '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.178.1', '192.168.0.1',
  '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  // IPv6：2000::/3 以外的、里面的特殊段
  '::', '::1', 'fe80::1', 'fe80::1%12', 'fc00::1', 'fd12:3456::1', '64:ff9b::808:808', '64:ff9b:1::1', 'ff02::1', '4000::1', 'e000::1',
  '::127.0.0.1', '2001:db8::1', '2002:c0a8:b201::1', '2001:0:4136:e378::1', '2001:10::1', '2001:20::1', '2001:2::1', '3fff::1', '3ffe::1',
  // ::ffff: 映射的按 IPv4 查
  '::ffff:192.168.178.1', '::ffff:c0a8:b201', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::ffff:7f00:1]',
  // 本机自己的（IPv4 完全一样、IPv6 同一个 /56：家里路由器分到的整段）
  '85.10.20.30', '::ffff:85.10.20.30', '2003:e1:1234:5601::1', '2003:e1:1234:56ff::1', '2003:e1:1234:5600::1', '2003:e1:1234:5600:ffff::1', '2003:e1:1234:5600:aaaa:bbbb:cccc:dddd',
  // 不是地址的
  '', 'not-an-ip', '1.2.3', '01.2.3.4', '1.2.3.256', '1.2.3.4.5', '1::2::3', '12345::1', 'gggg::1', '::ffff:1.2.3.4.5', '1:2:3:4:5:6:7:8:9',
]

test('地址规则表：该放的放、该挡的挡（' + (ALLOW.length + DENY.length) + ' 条）', () => {
  assert.ok(ALLOW.length + DENY.length >= 40)
  for (const ip of ALLOW) assert.equal(addrAllowed(ip, { localAddrs: OWN }), true, `应该放行：${ip}`)
  for (const ip of DENY) assert.equal(addrAllowed(ip, { localAddrs: OWN }), false, `应该挡住：${ip}`)
})

test('IPv6 解析：展开 ::、结尾的 IPv4、方括号；zone 不认', () => {
  assert.deepEqual(parseV6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(parseV6('::'), [0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(parseV6('1::'), [1, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(parseV6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
  assert.deepEqual(parseV6('[2001:db8::1]'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
  assert.deepEqual(parseV6('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304])
  assert.equal(parseV6('fe80::1%eth0'), null)
  assert.equal(parseV6(':::'), null)
  assert.equal(parseV6('1:2:3:4:5:6:7:8::'), null)
  assert.equal(parseV4('1.2.3.4'), 0x01020304)
  assert.equal(parseV4('0x7f.0.0.1'), null)
  assert.ok(sameAddr('::ffff:127.0.0.1', '127.0.0.1'))
})

test('本机地址每次现读；读不出来就一律不放；屏蔽名单里的 IP / 网段也挡', () => {
  let calls = 0
  const la = () => { calls++; return ['2003:e1:1234:5600::42'] }
  assert.equal(addrAllowed('2003:e1:1234:5600::9', { localAddrs: la }), false)
  assert.equal(addrAllowed('2003:e1:1234:5700::9', { localAddrs: la }), true)
  assert.equal(calls, 2)
  assert.equal(addrAllowed('8.8.8.8', { localAddrs: () => { throw new Error('读不出网卡') } }), false)
  assert.equal(addrAllowed('85.1.2.3', { localAddrs: [], deny: ['85.1.2.0/24'] }), false)
  assert.equal(addrAllowed('85.1.3.3', { localAddrs: [], deny: ['85.1.2.0/24'] }), true)
  assert.equal(addrAllowed('2a01:1::5', { localAddrs: [], deny: ['2a01:1::/32'] }), false)
  // 不传 localAddrs → 读真的网卡（回环一定在里面，本来也不放）
  assert.equal(addrAllowed('127.0.0.1'), false)
})

test('网址：直接写 IP 的各种写法都当场查', () => {
  const bad = ['http://3232281089/', 'http://0xc0a8b201/', 'http://0300.0250.0262.01/', 'http://192.168.178.1/', 'http://127.1/',
    'http://0/', 'http://[::1]/', 'http://[::ffff:192.168.178.1]/', 'http://[fe80::1%25eth0]/', 'http://[fd00::1]/', 'https://10.1.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[64:ff9b::c0a8:b201]/', 'http://[2002:c0a8:b201::1]/', 'http://198.18.0.5/']
  for (const u of bad) {
    const r = checkUrl(u, { localAddrs: [] })
    assert.equal(r.ok, false, `应该挡住：${u}`)
    assert.ok(r.why)
  }
  // 公网 IP 直接写在网址里也不去（只去有名字的网站）；测试口子 policyOverride.addrs 里的照放
  for (const u of ['http://8.8.8.8/', 'http://[2606:4700::1111]/x']) {
    const r = checkUrl(u, { localAddrs: [] })
    assert.equal(r.ok, false, u)
    assert.match(r.why, /IP/)
  }
  assert.equal(checkUrl('http://8.8.8.8/', { localAddrs: [], policyOverride: { addrs: ['8.8.8.8'] } }).ok, true)
  // 本机的公网 IPv6（直接写在网址里）
  assert.equal(checkUrl('http://[2003:e1:1234:5600::1]/', { localAddrs: OWN }).ok, false)
})

test('网址：协议、用户名、端口、长度、本机名字', () => {
  const cases = {
    'http://user@example.com/': false, 'http://user:pw@example.com/': false, 'http://example.com:8080/': false,
    'https://example.com:8443/': false, 'http://example.com:22/': false, 'ftp://example.com/': false, 'file:///C:/Windows/win.ini': false,
    'javascript:alert(1)': false, 'data:text/html,hi': false, 'ws://example.com/': false, '': false, 'not a url': false,
    'http://localhost/': false, 'http://LOCALHOST./': false, 'http://router/': false, 'http://fritz.box/': false, 'http://nas.local/': false,
    'http://a.localhost/': false, 'http://x.home.arpa/': false,
    'http://example.com/': true, 'http://example.com:80/': true, 'https://example.com:443/': true, 'https://example.com:80/': true,
    'https://zh.wikipedia.org/wiki/%E5%82%85': true,
  }
  for (const [u, ok] of Object.entries(cases)) assert.equal(checkUrl(u, { localAddrs: [] }).ok, ok, u)
  assert.equal(checkUrl('https://example.com/' + 'a'.repeat(3000)).ok, false)
  assert.match(checkUrl('http://user@example.com/').why, /用户名/)
  assert.match(checkUrl('http://example.com:8080/').why, /端口/)
  assert.equal(checkUrl('https://example.com/a#b').url, 'https://example.com/a#b')
})

test('屏蔽名单：B站 全家，统一写法（结尾的点、大小写、全角）；长得像的别的域名不误伤', () => {
  const blocked = ['http://www.bilibili.com./', 'https://WWW.BILIBILI.COM/', 'https://ｗｗｗ．ｂｉｌｉｂｉｌｉ．ｃｏｍ/', 'https://space.bilibili.com/123',
    'https://b23.tv/abc', 'https://i0.hdslb.com/a.jpg', 'https://upos-sz-mirror.bilivideo.com/x', 'https://api.biliapi.net/', 'https://bilibili.com/',
    'https://www.bilibili.com。/', 'https://m.bilibili.cn/']
  for (const u of blocked) assert.equal(checkUrl(u, { localAddrs: [] }).ok, false, u)
  assert.match(checkUrl('https://b23.tv/x').why, /屏蔽/)
  // 名字里带 bilibili / hdslb / bilivideo … 的一律不去（B站 自己的新域名、借 B站 名字的站都算上；少读几个粉丝站没关系）
  for (const u of ['https://bilibili.com.evil.example/', 'https://notbilibili.com/', 'https://bilibili-fan.example.org/', 'https://x.bilibilicomics.com/', 'https://a.hdslb.net.example/']) {
    assert.equal(checkUrl(u, { localAddrs: [] }).ok, false, u)
  }
  assert.equal(checkUrl('https://bili.example.org/', { localAddrs: [] }).ok, true)
  // 路径 / 参数里带 B站 的名字（代理、镜像站拿路径转发到 B站）：也不去；编码过几层的一样认得
  for (const u of ['https://example.org/bilibili/x', 'https://proxy.example/?u=https%3A%2F%2Fapi.bilibili.com%2Fx', 'https://proxy.example/%2562%2569%256c%2569%2562%2569%256c%2569', 'https://x.example/b23.tv/abc']) {
    assert.equal(checkUrl(u, { localAddrs: [] }).ok, false, u)
  }
  // 西里尔字母的「і」：是另一个域名（punycode），不是 B站，也不会被当成 B站 放过或误挡
  const look = checkUrl('https://bіlibili.com/', { localAddrs: [] })
  assert.equal(look.ok, true)
  assert.match(look.url, /xn--/)
  // 配置里的名单和 IP 并进来；B站 总是在里面
  assert.equal(checkUrl('https://a.evil.example/', { block: ['evil.example'], localAddrs: [] }).ok, false)
  assert.equal(checkUrl('http://85.1.2.3/', { block: ['85.1.2.3'], localAddrs: [] }).ok, false)
  assert.equal(checkUrl('https://www.bilibili.com/', { block: ['other.example'], localAddrs: [] }).ok, false)
  assert.equal(normalizeHost('WWW.Bilibili.COM...'), 'www.bilibili.com')
  assert.equal(normalizeHost('bücher.de'), 'xn--bcher-kva.de')
  assert.equal(normalizeHost(''), '')
  assert.equal(hostBlocked('live.bilibili.com'), true)
  assert.equal(hostBlocked('bilibili.com.cn'), false)
  assert.equal(hostBlocked('xbilibili.com'), false)
  assert.equal(hostBlocked('a.example.org', ['*.example.org']), true)
  assert.equal(hostBlocked('example.org', ['.example.org']), true)
  assert.ok(DEFAULT_BLOCK.includes('hdslb.com'))
})

// lookup 包成 Promise：回 { err, a, f }
const call = (fn, host, options) => new Promise((res) => {
  if (options === undefined) fn(host, (err, a, f) => res({ err, a, f }))
  else fn(host, options, (err, a, f) => res({ err, a, f }))
})
const fake = (list) => async () => list

test('lookup：全部合规时 all:true 回整张表、all:false 回第一个；family 过滤；两参数写法', async () => {
  const lk = makeLookup({ resolve: fake([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]), localAddrs: [] })
  const all = await call(lk, 'example.com', { all: true })
  assert.equal(all.err, null)
  assert.deepEqual(all.a, [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }])
  const one = await call(lk, 'example.com', {})
  assert.equal(one.a, '93.184.216.34')
  assert.equal(one.f, 4)
  const six = await call(lk, 'example.com', { family: 6 })
  assert.equal(six.a, '2606:2800:220:1::1')
  assert.equal(six.f, 6)
  const num = await call(lk, 'example.com', 4)
  assert.equal(num.a, '93.184.216.34')
  const two = await call(lk, 'example.com')
  assert.equal(two.a, '93.184.216.34')
  // 解析器回字符串数组也认
  const s = await call(makeLookup({ resolve: fake(['1.1.1.1']), localAddrs: [] }), 'one.example', { all: true })
  assert.deepEqual(s.a, [{ address: '1.1.1.1', family: 4 }])
})

test('lookup：有一个坏地址就整个拒（不管排第几）', async () => {
  for (const list of [['8.8.8.8', '192.168.178.1'], ['192.168.178.1', '8.8.8.8'], ['2606:4700::1', '::1'], ['8.8.8.8', '::ffff:10.0.0.1'],
    ['8.8.8.8', '2003:e1:1234:5600::7']]) {
    const lk = makeLookup({ resolve: fake(list), localAddrs: OWN })
    for (const o of [{ all: true }, {}, { family: 4 }]) {
      const r = await call(lk, 'rebind.example', o)
      assert.equal(r.err?.code, 'EWEBCAGE', JSON.stringify(list))
    }
  }
})

test('lookup：全在 198.18/15 → 说像是代理的 TUN / fake-ip；混着公网的照常拒', async () => {
  const r = await call(makeLookup({ resolve: fake(['198.18.0.21', '198.19.3.4']), localAddrs: [] }), 'x.example', { all: true })
  assert.equal(r.err.code, 'EWEBCAGE')
  assert.match(r.err.message, /TUN|fake-ip/)
  const m = await call(makeLookup({ resolve: fake(['198.18.0.21', '8.8.8.8']), localAddrs: [] }), 'x.example', { all: true })
  assert.equal(m.err.code, 'EWEBCAGE')
  assert.doesNotMatch(m.err.message, /TUN/)
})

test('lookup：解析不出 / 屏蔽的名字不去解析 / 直接是 IP / 每次重查', async () => {
  const none = await call(makeLookup({ resolve: fake([]), localAddrs: [] }), 'none.example', {})
  assert.equal(none.err.code, 'ENOTFOUND')
  const thrown = await call(makeLookup({ resolve: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }) }, localAddrs: [] }), 'nx.example', {})
  assert.equal(thrown.err.code, 'ENOTFOUND')
  let asked = 0
  const counting = async () => { asked++; return ['8.8.8.8'] }
  const b = await call(makeLookup({ resolve: counting, localAddrs: [] }), 'www.bilibili.com', {})
  assert.equal(b.err.code, 'EWEBCAGE')
  const l = await call(makeLookup({ resolve: counting, localAddrs: [] }), 'localhost', {})
  assert.equal(l.err.code, 'EWEBCAGE')
  const ip = await call(makeLookup({ resolve: counting, localAddrs: [] }), '10.0.0.1', { all: true })
  assert.equal(ip.err.code, 'EWEBCAGE')
  assert.equal(asked, 0)
  // 第一次给公网、第二次给内网（DNS rebinding）：第二次照样拒
  let n = 0
  const flip = async () => (n++ === 0 ? ['93.184.216.34'] : ['192.168.178.1'])
  const lk = makeLookup({ resolve: flip, localAddrs: [] })
  assert.equal((await call(lk, 'flip.example', {})).err, null)
  assert.equal((await call(lk, 'flip.example', {})).err.code, 'EWEBCAGE')
  // 本机地址也是每次现读
  let own = []
  const lk2 = makeLookup({ resolve: fake(['2a01:4f8::5']), localAddrs: () => own })
  assert.equal((await call(lk2, 'own.example', {})).err, null)
  own = ['2a01:4f8::1']
  assert.equal((await call(lk2, 'own.example', {})).err.code, 'EWEBCAGE')
})

test('去掉代理环境变量（大小写都算），别的不动', () => {
  const env = { HTTP_PROXY: 'x', https_proxy: 'x', ALL_PROXY: 'x', no_proxy: 'x', NO_PROXY: 'x', NODE_USE_ENV_PROXY: '1', Http_Proxy: 'x',
    GLOBAL_AGENT_HTTP_PROXY: 'x', npm_config_proxy: 'x', npm_config_https_proxy: 'x', SOCKS_PROXY: 'x', PATH: '/bin', HOME: '/h', PROXYCHAINS: 'keep' }
  const out = stripProxyEnv(env)
  assert.deepEqual(Object.keys(out).sort(), ['HOME', 'PATH', 'PROXYCHAINS'])
  assert.equal(env.HTTP_PROXY, 'x')
})

test('通配 DNS 的名字（1-2-3-4.nip.io 这种）不去；TUN 模式的网卡认得出', () => {
  for (const u of ['http://192-168-178-1.nip.io/', 'https://10.0.0.1.sslip.io/', 'http://a.traefik.me/', 'http://localtest.me/', 'http://x.lvh.me/', 'http://make-1.2.3.4-rebind.1u.ms/']) {
    assert.equal(checkUrl(u, { localAddrs: [] }).ok, false, u)
  }
  assert.equal(tunSuspect({ 'Clash': [{ address: '10.0.0.2' }] }), 'Clash')
  assert.equal(tunSuspect({ 'Meta': [] }), 'Meta')
  assert.equal(tunSuspect({ 'Ethernet 3': [{ address: '198.18.0.1' }] }), 'Ethernet 3')
  assert.equal(tunSuspect({ 'WLAN': [{ address: '192.168.178.23' }, { address: 'fe80::1' }], 'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1' }] }), null)
  assert.equal(tunSuspect({}), null)
})

test('屏蔽名单里写的 IP / 网段：认得出的才收（::ffff: 开头的、前缀超长的、像 IP 又写错的都不收 —— 收了也挡不住）；28.0.0.0/8 当成 TUN 假地址', async () => {
  const { webBlockEntry } = await import(pathToFileURL(path.join(root, 'tools/lib/config.mjs')).href)
  assert.equal(webBlockEntry('203.0.113.7'), '203.0.113.7')
  assert.equal(webBlockEntry('203.0.113.0/24'), '203.0.113.0/24')
  for (const x of ['::ffff:8.8.8.0/120', '8.8.8.0/33', '2001:db8::/129', '300.1.1.1', '1.2.3', 'a:b', 'x/y']) assert.equal(webBlockEntry(x), '', x)
  assert.equal(webBlockEntry('Example.ORG'), 'example.org')
  assert.equal(tunSuspect({ 'Ethernet 7': [{ address: '28.0.0.1' }] }), 'Ethernet 7')
})
