// 视频编号（tools/lib/video-id.mjs）：主人分享的视频是 av 号 / av 链接 / b23.tv 短链 / 私信卡片时，也换得到那一条的 BV 号 ——
// 换算按 B站 公开的 av↔BV 算法（已知的几对两个方向都对、和 2020 年的老算法在老 av 号上一致）；照旧只认合法写法；
// 短链只问一次 b23.tv、不带 cookie、不跟着跳；卡片直接给 BV / 标题 / UP 主，专栏 / 直播间不当视频；各个看片工具真的认这些写法
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { av2bv, bv2av, parseVideoRef, toBvid, findBvid, resolveVideoRef, shareCard, renderShareCard, BV_RE } from '../tools/lib/video-id.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const CARDS = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'dm-share-cards.json'), 'utf8')).cards

// 公开的几对（老 av 号、2024 年以后的大 av 号都有）
const PAIRS = [[2, 'BV1xx411c7mD'], [170001, 'BV17x411w7KC'], [455017605, 'BV1Q541167Qg'], [111298867365120, 'BV1L9Uoa9EUx']]

test('av↔BV: known pairs both ways, range limits, and the same answers as the pre-2024 algorithm on old av ids', () => {
  for (const [aid, bvid] of PAIRS) {
    assert.equal(av2bv(aid), bvid)
    assert.equal(av2bv(String(aid)), bvid)
    assert.equal(av2bv(BigInt(aid)), bvid)
    assert.equal(bv2av(bvid), aid)
  }
  // 范围：1 ≤ av < 2^51；不是整数、前导 0、负数都不认
  for (const bad of [0, -1, 2 ** 51, 1.5, '0012', '12a', '', null, undefined, NaN, '99999999999999999']) assert.equal(av2bv(bad), null, String(bad))
  assert.equal(bv2av(av2bv(2 ** 51 - 1)), 2 ** 51 - 1)
  // 不是 B站 发的 BV（字母表里没有 0 / I / O / l，或者换不回同一个）：不硬算
  for (const bad of ['BV1234567890', 'BV1xx411c7mI', 'av170001', '', null]) assert.equal(bv2av(bad), null, String(bad))
  // 老算法（2020 年公布的那版，只管 2^27 以下的老 av 号）：确定的一串 av 号上两边结果一样
  const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF', s = [11, 10, 3, 8, 4, 6]
  const oldAv2bv = (x) => { x = (x ^ 177451812) + 8728348608; const r = 'BV1  4 1 7  '.split(''); for (let i = 0; i < 6; i += 1) r[s[i]] = table[Math.floor(x / 58 ** i) % 58]; return r.join('') }
  for (let aid = 1; aid < 2 ** 27; aid += 104729) { assert.equal(av2bv(aid), oldAv2bv(aid), `av${aid}`); assert.equal(bv2av(av2bv(aid)), aid) }
})

test('parseVideoRef: every accepted spelling lands on the same BV; anything else is refused, as strictly as before', () => {
  const same = ['BV17x411w7KC', 'av170001', 'AV170001', 'aid=170001', 'avid=170001', ' av170001 ',
    'https://www.bilibili.com/video/av170001', 'https://www.bilibili.com/video/av170001/?p=2&share_source=copy', 'http://www.bilibili.com/video/BV17x411w7KC/',
    'www.bilibili.com/video/av170001', 'bilibili.com/video/BV17x411w7KC', 'https://m.bilibili.com/video/av170001', 'https://www.bilibili.com/s/video/BV17x411w7KC',
    'https://player.bilibili.com/player.html?aid=170001&page=1', 'https://www.bilibili.com/list/watchlater?bvid=BV17x411w7KC', 'b23.tv/BV17x411w7KC', 'https://b23.tv/av170001']
  for (const x of same) assert.equal(toBvid(x), 'BV17x411w7KC', x)
  assert.deepEqual(parseVideoRef('av170001'), { bvid: 'BV17x411w7KC', aid: 170001, via: 'av' })
  assert.deepEqual(parseVideoRef('https://b23.tv/AbC123x?share=1'), { short: 'https://b23.tv/AbC123x' })
  assert.deepEqual(parseVideoRef('bili2233.cn/AbC123x'), { short: 'https://bili2233.cn/AbC123x' })
  const refused = ['', '   ', 'bv17x411w7KC', 'BV17x411w7K', 'BV17x411w7KCX', '../BV17x411w7KC', 'BV17x411w7KC/../x', '../../.bili-ai/x', 'av0', 'av-1', 'av12a', 'av 170001',
    'av99999999999999999', 'av2251799813685248', '看这个 av170001', 'av170001 好看', 'https://evil.example/video/BV17x411w7KC', 'https://www.bilibili.com.evil.example/video/av1',
    'https://user:pw@www.bilibili.com/video/av1', 'https://www.bilibili.com:8443/video/av1', 'ftp://www.bilibili.com/video/av1', 'javascript:alert(1)',
    'https://www.bilibili.com/read/cv123', 'https://space.bilibili.com/999999003', 'https://www.bilibili.com/video/', 'https://b23.tv/', 'https://b23.tv/a/b', 'https://b23.tv/' + 'x'.repeat(17),
    'x'.repeat(700), null, undefined, true]
  for (const x of refused) assert.equal(parseVideoRef(x), null, String(x))
  // 换出来的永远是合法 BV 号（会拼进文件名）
  for (const x of same) assert.match(toBvid(x), BV_RE)
})

test('findBvid: a BV first, then an av inside a video link, then a standalone av12345; words that only contain "av" are not ids', () => {
  assert.equal(findBvid('看看这个 https://www.bilibili.com/video/BV1xx411c7mD/ 和 av170001'), 'BV1xx411c7mD')
  assert.equal(findBvid('分享 https://www.bilibili.com/video/av170001 给你'), 'BV17x411w7KC')
  assert.equal(findBvid('av170001，好看'), 'BV17x411w7KC')
  for (const x of ['have fun', 'travel 2026', 'nav170001', 'av0', '', null]) assert.equal(findBvid(x), null, String(x))
})

test('resolveVideoRef: a b23.tv link is asked once (no cookie, no following); non-video, dead and failing links are reported; BV / av never touch the network', async () => {
  const calls = []
  const fake = (spec) => async (url, init) => {
    calls.push({ url, init })
    if (spec === 'throw') throw new TypeError('fetch failed')
    if (spec === 'timeout') throw new DOMException('timeout', 'TimeoutError')
    return { status: spec.status, headers: new Headers(spec.location ? { location: spec.location } : {}), body: null }
  }
  let r = await resolveVideoRef('https://b23.tv/AbC123x', { fetch: fake({ status: 302, location: 'https://www.bilibili.com/video/BV17x411w7KC/?share_source=copy_web&vd_source=x' }) })
  assert.deepEqual({ ok: r.ok, bvid: r.bvid, via: r.via }, { ok: true, bvid: 'BV17x411w7KC', via: 'short' })
  assert.match(r.note, /短链 https:\/\/b23\.tv\/AbC123x → BV17x411w7KC/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://b23.tv/AbC123x')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.headers.cookie, undefined)
  assert.ok(calls[0].init.signal, '要有时限')
  // 跳到 av 链接也行
  r = await resolveVideoRef('b23.tv/Xy9', { fetch: fake({ status: 301, location: 'https://m.bilibili.com/video/av170001' }) })
  assert.equal(r.bvid, 'BV17x411w7KC')
  // 跳到的不是视频 / 又是一个短链 / 别的网站：不认（code 2），也不跟着跳
  for (const location of ['https://www.bilibili.com/bangumi/play/ep123?x=1', 'https://b23.tv/Other1', 'https://evil.example/video/BV17x411w7KC']) {
    calls.length = 0
    r = await resolveVideoRef('https://b23.tv/AbC123x', { fetch: fake({ status: 302, location }) })
    assert.equal(r.ok, false); assert.equal(r.code, 2); assert.match(r.error, /跳到的不是 B站 视频/); assert.doesNotMatch(r.error, /\?x=1/)
    assert.equal(calls.length, 1)
  }
  // 不存在的码（真 b23.tv 回 200、不跳）：说可能失效了（code 2）；b23.tv 出错 / 断网 / 超时：code 3，说请主人直接发 BV 号
  r = await resolveVideoRef('https://b23.tv/zzzzzzQ', { fetch: fake({ status: 200 }) })
  assert.equal(r.code, 2); assert.match(r.error, /可能失效了或者抄错了/)
  r = await resolveVideoRef('https://b23.tv/zzzzzzQ', { fetch: fake({ status: 503 }) })
  assert.equal(r.code, 3); assert.match(r.error, /b23\.tv 出错/)
  r = await resolveVideoRef('https://b23.tv/zzzzzzQ', { fetch: fake('throw') })
  assert.equal(r.code, 3); assert.match(r.error, /没解析成.*直接发 BV 号/)
  r = await resolveVideoRef('https://b23.tv/zzzzzzQ', { fetch: fake('timeout') })
  assert.equal(r.code, 3); assert.match(r.error, /超时/)
  // 不联网的写法：一次都不问
  calls.length = 0
  for (const x of ['BV17x411w7KC', 'av170001', 'https://www.bilibili.com/video/av170001', 'b23.tv/BV17x411w7KC']) {
    r = await resolveVideoRef(x, { fetch: fake('throw') })
    assert.equal(r.ok, true, x); assert.equal(r.bvid, 'BV17x411w7KC')
  }
  assert.equal(calls.length, 0)
  assert.equal((await resolveVideoRef('BV17x411w7KC')).note, '')
  assert.equal((await resolveVideoRef('av170001')).note, '（av170001 = BV17x411w7KC）')
  r = await resolveVideoRef('../../.bili-ai/x', { fetch: fake('throw') })
  assert.equal(r.ok, false); assert.equal(r.code, 2); assert.match(r.error, /不是 BV 号/)
})

test('share cards (fixture JSON): the BV, title and UP are given directly; article and live-room cards are not turned into a video', () => {
  for (const c of CARDS) {
    const got = shareCard(c.content)
    for (const [k, v] of Object.entries(c.expect)) assert.deepEqual(got[k], v, `${c.name}：${k}`)
  }
  const [first] = CARDS
  assert.equal(renderShareCard(first.content), '[B站视频分享] 《示例视频》 · UP 主 某UP\nBV 号 BV17x411w7KC（av170001）\nhttps://www.bilibili.com/video/BV17x411w7KC/')
  // 只有编号、来源不是视频：提醒打开后核对标题
  assert.match(renderShareCard({ id: '170001', title: '没写来源' }), /BV17x411w7KC.*核对一下标题/)
  assert.equal(renderShareCard({ id: 170001, source: 6, title: '一篇专栏', author: '写手', url: 'https://www.bilibili.com/read/cv170001' }),
    '[B站分享（不是视频，类型 6）] 《一篇专栏》 · UP 主 写手\nhttps://www.bilibili.com/read/cv170001')
  // 每一张渲染出来都没有多出来的换行（标题、UP 名里的换行压掉了）
  for (const c of CARDS) assert.ok(renderShareCard(c.content).split('\n').length <= 3, c.name)
  for (const bad of [null, 'x', [1], 7]) assert.equal(shareCard(bad), null)
  assert.match(renderShareCard(null), /读不出来/)
})

// —— 工具真的认这些写法（假的视频接口 + 假的 b23.tv；看片记录按 BV 号记） ——
function videoSandbox(t, spec, b23 = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-vid-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'SECRET_SESSDATA_VALUE_123456', bili_jct: 'c'.repeat(32), buvid3: '' }))
  const specFile = path.join(home, 'video.json')
  fs.writeFileSync(specFile, JSON.stringify(spec))
  const imp = (f) => '--import=' + pathToFileURL(path.join(root, 'tests', 'helpers', f)).href
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: path.join(home, 'data'), BILI_WHALE_CONFIG: path.join(home, 'data', 'c.json'), BILI_NO_CACHE: '1', BILI_WHALE_AGENT: '1',
    TEST_VIDEO_FILE: specFile, TEST_REQUESTS: path.join(home, 'req.jsonl'), TEST_B23: JSON.stringify(b23), NODE_OPTIONS: `${imp('video-fetch.mjs')} ${imp('b23-fetch.mjs')}` }
  const bili = (...args) => {
    fs.rmSync(env.TEST_REQUESTS, { force: true })
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'bili.mjs'), ...args], { env, encoding: 'utf8', timeout: 60_000 })
    const reqs = fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    return { code: r.status, out: r.stdout + r.stderr, reqs }
  }
  return { home, env, bili }
}

test('tools: an av id, an av link and a b23.tv short link all open the same video in subtitles / comments / watched; bad input is still refused before any request', (t) => {
  const BV = 'BV1xx411c7mD'   // = av2
  const s = videoSandbox(t, { view: { bvid: BV, aid: 2, title: '主人分享的那条' }, player: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://subtitle.example/a.json' }] }, subBody: [{ from: 0, to: 2, content: '你好' }], replies: [{ content: { message: '热评' } }] },
    { Kong37x: `https://www.bilibili.com/video/${BV}/?share_source=copy_web`, Gone000: 200, Elsewhere: 'https://space.bilibili.com/1' })
  for (const arg of ['av2', 'AV2', 'https://www.bilibili.com/video/av2/', 'https://b23.tv/Kong37x']) {
    const r = s.bili('subtitles', arg)
    assert.equal(r.code, 0, arg + '\n' + r.out)
    assert.match(r.out, new RegExp(`${BV}|主人分享的那条`))
    assert.ok(r.reqs.some((q) => q.url.includes(`bvid=${BV}`)), arg + ' 要按换出来的 BV 号去取')
    assert.ok(!r.reqs.some((q) => /bvid=(?!BV1xx411c7mD)/.test(q.url)), arg + ' 不能把原样的写法拼进请求')
    assert.equal(r.reqs.filter((q) => q.b23).length, arg.includes('b23') ? 1 : 0, arg)
    if (arg.includes('b23')) { const q = r.reqs.find((x) => x.b23); assert.equal(q.redirect, 'manual'); assert.equal(q.cookie, false) }
  }
  // 看片记录按 BV 号记：用 av 号查到的就是刚才那条
  let r = s.bili('watched', 'show', 'av2')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /BV1xx411c7mD 《主人分享的那条》/); assert.match(r.out, /字幕：取到了/)
  r = s.bili('watched', 'note', 'https://b23.tv/Kong37x', '--text', '一句话的开场')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /记下了/)
  r = s.bili('comments', 'av2', '--json')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /"bvid": "BV1xx411c7mD"/)
  // 认不出来的：照旧在发任何请求之前拒绝（退出码 2）；短链失效 / 跳到别处也说清楚
  for (const [args, re] of [[['subtitles', '../../.bili-ai/x'], /不是 BV 号/], [['debrief', 'av0', '--no-frames'], /不是 BV 号/], [['watch-video', 'https://evil.example/video/av2'], /不是 BV 号/],
    [['comments', 'bvid=x&ps=50', '--json'], /不是 BV 号/], [['video', '看这个 av2'], /不是 BV 号/], [['subtitles', 'https://b23.tv/Gone000'], /可能失效了/], [['subtitles', 'https://b23.tv/Elsewhere'], /跳到的不是 B站 视频/]]) {
    r = s.bili(...args)
    assert.equal(r.code, 2, args.join(' ') + '\n' + r.out); assert.match(r.out, re)
    assert.ok(!r.reqs.some((q) => !q.b23), args.join(' ') + ' 不该访问视频接口')
  }
  assert.doesNotMatch(fs.readdirSync(path.join(s.home, '.bili-ai')).join(' '), /x$/)
})

test('dm and comment shares: an av link, --target av… and --bvid av… count as the same video for the 7-day rule', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-vid-dm-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, '.dsh'), data = path.join(home, '.bili-ai')
  fs.mkdirSync(dsh); fs.mkdirSync(data)
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '111' }, share: { enabled: true }, notify: { type: 'none' } }))
  fs.writeFileSync(path.join(data, 'credentials.json'), JSON.stringify({ sessdata: 'fake', bili_jct: 'a'.repeat(32) }))
  fs.writeFileSync(path.join(data, 'quota.json'), JSON.stringify({ log: [{ at: new Date().toISOString(), share: true, target: 'BV:BV17x411w7KC' }] }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), TEST_REQUESTS: path.join(home, 'requests'),
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests', 'helpers', 'supplement-fetch.mjs')).href }
  const share = ['--share', '--reason', '这个视频确实值得测试分享', '--score', '15', '--rank', '1', '--dry']
  for (const args of [['--msg', '这条好看 https://www.bilibili.com/video/av170001', ...share], ['--msg', '这条好看', '--target', 'av170001', ...share], ['--msg', '这条好看', '--target', 'BV:AV170001', ...share]]) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'commands', 'dm.mjs'), ...args], { env, encoding: 'utf8', timeout: 15000 })
    assert.notEqual(r.status, 0, args.join(' ') + ' 不该通过')
    assert.match(r.stdout + r.stderr, /7 天/, args.join(' '))
  }
  // comment --bvid av…：referer 和账本都用换出来的 BV 号
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'commands', 'comment.mjs'), '--oid', '170001', '--bvid', 'av170001', '--message', 'test', '--auto', ...share], { env, encoding: 'utf8', timeout: 15000 })
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /7 天内已经分享过了/)
  assert.match(r.stdout, /referer=https:\/\/www\.bilibili\.com\/video\/BV17x411w7KC\//)
  assert.doesNotMatch(fs.readFileSync(env.TEST_REQUESTS, 'utf8'), /POST/)
})
