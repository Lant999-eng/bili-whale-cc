// 公开发言的出门检查（2026-10-26 主人定，tools/lib/outbound.mjs）：评论 / 回复 / 分享评论、动态（文字 / 图文 / 编辑）、直播弹幕发之前，
//   代码里过一遍回陌生人私信那一套（站外链接、联系方式、长号码、主人的 UID 和 QQ、她的 QQ、电脑路径、cookie 的名字）。
//   · 库：该放行的放行（聊天、表情、日期时间、集数、她讲数学的算式和长小数、大整数、BV 号和 B站 链接、@昵称），该拦的拦（全角 / 零宽 / FE0F / 键帽 / 「。」当点的绕法也算）；拒绝的话不抄出号码
//   · 每个命令真跑（假接口 tests/helpers/share-view-fetch.mjs 记下每个请求）：拦下的 --go / --dry / --check / --once-per-person / b23.tv 一个请求都没发、退出码 2、HOME 里一个文件都没多（额度、记账、判重、锁）
//   · 主人还要审的（reply-draft add；studio submit 在 tests/studio.test.mjs）只提醒、不拦
//   · 回陌生人私信的 checkReplyText 一字不变（tests/sdm-from-core.test.mjs：跟着模块走；tests/sdm.test.mjs 另有整套）
// 每个测试一个临时目录（HOME / 数据目录 / 配置都在里面）；不联网
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bv2av } from '../tools/lib/video-id.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const href = (f) => pathToFileURL(path.join(root, f)).href
const BS = String.fromCharCode(92)   // 反斜杠（路径用）
const BV = 'BV1b4W1eeE2g'   // 虚构的 BV 号（换算出来是 av113024680135791，超过 2^32），只为测 BV / av 号和 B站 链接的检测
const AID = bv2av(BV)

// 库在这个进程里测：先把 HOME / 配置指到临时目录再加载（路径在加载时定下来；不碰真的配置）
const unitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-outbound-unit-'))
test.after(() => fs.rmSync(unitHome, { recursive: true, force: true }))
process.env.USERPROFILE = unitHome; process.env.HOME = unitHome
process.env.DSH_HOME = path.join(unitHome, 'data'); process.env.BILI_WHALE_CONFIG = path.join(unitHome, 'data', 'bili-whale.config.json')
delete process.env.BILI_WHALE_AGENT; delete process.env.BILI_WHALE_TURN
// 用到才加载：没有这个文件的旧版本上，每个测试单独失败
const lib = () => import(href('tools/lib/outbound.mjs'))

// 假的号（不是谁的真号）：主人的 UID 7 位、主人的 QQ 7 位、她的 QQ 6 位 —— 都不到「8 位以上」，只有按配置查才拦得住
const OWNER_MID = '7654321', OWNER_QQ = '5566778', SELF_QQ = '667788'
const CFG = { owner: { mid: OWNER_MID, name: 'Owner' }, qq: { ownerQq: OWNER_QQ, selfQq: SELF_QQ } }
const LONG_OWNER = '3494000011112222'   // 新式 16 位 UID 的主人：space 链接里的长 id 会先被换掉，主人的号要另查
// 看不见的绕法：每个数字后面加 FE0F + 键帽（「7️⃣6️⃣5️⃣」，可爱的写法）、每个字后面加删除线
const keycap = (d) => [...d].map((x) => x + '️⃣').join('')
const strike = (d) => [...d].map((x) => x + '̶').join('')

const PASS = [
  '今天这期好可爱哈哈哈，下次还来',
  '笑死😂😂 太好看了吧✨👍🏻',
  '2026年10月26日 20:30 见',
  '2026-10-26 更新的那一期',
  '第 12 集、EP3、P2 都看了',
  '才 3 分钟，看了 2 遍',
  'x^2+1=0 在实数里没有解',
  'π≈3.14159，e≈2.71828',
  'det(A)=0 的时候 A 不可逆',
  '1/2 + 1/3 = 5/6',
  'Übung 3.2.1 的第二问',
  '推荐 BV1b4W1eeE2g',
  'av170001 和 av113024680135791 都是老片子',
  'cv12345678 那篇专栏',
  'https://www.bilibili.com/video/BV1b4W1eeE2g',
  'https://www.bilibili.com/video/av113024680135791',
  'https://t.bilibili.com/1000000000000000001',
  'https://www.bilibili.com/opus/1000000000000000001',
  'https://space.bilibili.com/3494351234567890',
  'space.bilibili.com/12345678',
  'https://b23.tv/AbCdEfG',
  '@Owner 这个你一定喜欢',
  '@某个UP主 讲得真清楚',
  // 她讲数学：长小数、大整数、紧凑的日期（以前都被当成号码）
  '1/3 = 0.333333333…',
  'π = 3.14159265358979，e ≈ 2.718281828，√2 ≈ 1.41421356',
  '0.1 + 0.2 = 0.30000000000000004',
  '一亿 = 100000000，10000000 次播放',
  '20261026 更新',
  'v0.11.20、12,345,678',
  // 表情里的 FE0F / ZWJ / 键帽拿掉以后也不会连成号码
  '❤️ 好看 1️⃣ 第一点 2️⃣ 第二点 👨‍👩‍👧',
  'https://live.bilibili.com/31415926',
  'https://m.bilibili.com/dynamic/1000000000000000001',
  'https://www.bilibili.com/video/BV1b4W1eeE2g?spm_id_from=333.1007.tianma.1-1-1.click&vd_source=abcdef',
  '推荐 BV1b4W1eeE2g。Nice',
  '@Owner，你看',
  'refresh token 过期是什么意思',
  // Codex 复查后：B站 分享链接里的跟踪参数（vd_source 开头是数字、时间戳）、默认昵称 bili_ 后面的数字、普通说到 QQ / 微信 / 推特
  `https://www.bilibili.com/video/${BV}?vd_source=12345678abcdef0123456789abcdefab`,
  // Codex 第二轮：平台名加冒号后面是普通的词、字幕规格、算式、带空格的日期
  '微信：Windows 版更新了',
  'QQ：Android 版更新了',
  '中文字幕/1080P/60fps',
  '(x+y)/2/3 = (x+y)/6',
  '2026 /10/26 那天',
  // Codex 第三轮：中文括号、冒号、紧挨着的中文后面跟 B站 短链接；产品名小写；算式里的 /x/y
  '看这里（b23.tv/AbCdEfG）',
  '推荐：b23.tv/AbCdEfG',
  '推荐b23.tv/AbCdEfG 这期',
  '微信：windows 版更新了',
  '1 /x/y = 1/(x*y)',
  // Codex 第四轮：算式、版本号、产品名、「@昵称」后面跟句号、汉字之间的斜杠、倒数
  '1 /x/10 = 0.1/x',
  'QQ：v9.9.9 版更新了',
  '微信：WeChat 版更新了',
  'OK @ Owner. Nice',
  '上海/北京/广州 都去过',
  '5 4 3 2 1 开始',
  '我的电话坏了',
  // Codex 第五轮：句号后面跟 VIP、@昵称后面的句号、约电话的日期 / 钟点、私聊里的产品名、德语、省略号
  '推荐这期：https://b23.tv/AbCdEf。 VIP 大会员应该也能看吧？',
  'OK @Owner。 VIP 大会员能看这一集吗？',
  '周末约电话 2026-11-01，下午三点吧',
  '我的手机 2026-10-26 刚买的😅',
  '私聊用微信 Android 版会闪退吗？',
  'Kap 2. de Morgan 定律',
  '好吧...我想想',
  '约个电话 9:30 吧',
  '微信：Hello 大家好',
  `https://www.bilibili.com/video/${BV}?share_source=copy_web&ts=1729999999&unique_k=AbCd123`,
  '@bili_12345678901 说得对',
  'QQ音乐里也有这首',
  '微信是个好东西',
  '推特：好看',
  'TCP/IP 和 2026/10/26 那期',
]
const BLOCK = [
  ['看这个 https://example.com/x', 'link'],
  ['去 example．com 看看', 'link'],
  ['ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｎ', 'link'],
  [`exa${'\u200b'}mple.com`, 'link'],
  [`去 evil${'\u200d'}.cn 领`, 'link'],
  ['手机 13800138000', 'contact'],
  ['手机 １３８００１３８０００', 'contact'],
  ['加我 QQ 12345', 'contact'],
  ['vx: abc123x', 'contact'],
  ['邮箱 a@b.com', 'contact'],
  ['号码 87654321', 'number'],
  ['UID 23456789012', 'number'],
  [`主人的 UID 是 ${OWNER_MID}`, 'number'],
  [`https://space.bilibili.com/${OWNER_MID}`, 'number'],
  [`主人的 QQ ${OWNER_QQ}`, 'contact'],
  [`找他：${OWNER_QQ}`, 'number'],
  [`我的 ${SELF_QQ}`, 'number'],
  ['我的 667 788', 'number'],
  ['我的 ６６７７８８', 'number'],
  [`C:${BS}Users${BS}someone${BS}草稿`, 'path'],
  ['D:/work/a', 'path'],
  ['在 ~/.bili-ai 里', 'path'],
  ['/home/ai/x', 'path'],
  ['SESSDATA=abc', 'cookie'],
  ['bili_jct 是什么', 'cookie'],
  [`hi${'\u202e'}there`, 'control'],
  // H1：FE0F、键帽、标签字符、韩文填充符、删除线夹在数字 / 网址 / cookie 名里
  [`UID ${keycap(OWNER_MID)}`, 'number'],
  [`找他 ${OWNER_QQ.slice(0, 4)}\uFE0F${OWNER_QQ.slice(4)}`, 'number'],
  [`QQ群 ${keycap('87654321')}`, 'number'],
  ['手机 13800\uFE0F138000', 'contact'],
  ['号码 8765\u{E0020}4321', 'number'],
  ['号码 8765\u31644321', 'number'],
  [strike(OWNER_MID), 'number'],
  ['去 evil\uFE0F.cn', 'link'],
  ['SESS\uFE0FDATA', 'cookie'],
  // M1：B站 链接里不是 id 的位置上的银行卡 / 身份证、av 后面 18 位以上的、链接里的长数字
  ['https://www.bilibili.com/6222021234567890123', 'contact'],
  ['b23.tv/6222021234567890123', 'contact'],
  ['https://www.bilibili.com/110105194912310021', 'contact'],
  ['av110105194912310021', 'contact'],
  ['看 bilibili.com/6222021234567890123是卡号', 'contact'],
  // 2938475610 是虚构的号码，只为测长数字检测
  ['https://www.bilibili.com/read/2938475610', 'number'],
  [`https://www.bilibili.com/video/${BV}?x=2938475610`, 'number'],
  // M2：主人的号中间夹全角横线、顿号、逗号、斜杠，或者旁边紧挨着别的数字组
  [`${OWNER_MID.slice(0, 4)}－${OWNER_MID.slice(4)}`, 'number'],
  [`${OWNER_QQ.slice(0, 4)}、${OWNER_QQ.slice(4)}`, 'number'],
  [`${OWNER_MID.slice(0, 4)},${OWNER_MID.slice(4)}`, 'number'],
  [`${OWNER_MID.slice(0, 4)}/${OWNER_MID.slice(4)}`, 'number'],
  [`0 ${OWNER_MID.slice(0, 4)} ${OWNER_MID.slice(4)}`, 'number'],
  [`${OWNER_QQ.slice(0, 4)} - ${OWNER_QQ.slice(4)}`, 'number'],
  // M3：不像日期、不是整数位的大数（不是一亿那种）还是要她改写
  ['2^32 = 4294967296', 'number'],
  // M4：「。」「｡」当点
  ['去 evil。cn 看', 'link'],
  ['evil｡cn', 'link'],
  // L5：域名里的数字不抄出来
  [`去 u${OWNER_MID}.evil.cn`, 'link'],
  // L2：路径、cookie 名的别的写法；B站 链接里的路径也查
  [`%USERPROFILE%${BS}Documents${BS}x`, 'path'],
  [`${BS}${BS}wsl$${BS}WeChatBot${BS}root`, 'path'],
  [`AppData${BS}Local${BS}Temp`, 'path'],
  ['/root/.config/x', 'path'],
  [`Desktop${BS}bili-whale`, 'path'],
  ['https://www.bilibili.com/C:/Users/someone/secret', 'path'],
  ['SESS DATA', 'cookie'],
  ['bili＿jct', 'cookie'],
  // Codex 复查（2026-10-26）找到的绕法
  ['https://bilibili.com。CN', 'link'],
  ['看 bilibili.com｡Cn/x', 'link'],
  [`https://space.bilibili.com/0${OWNER_MID}`, 'number'],
  [`0.${OWNER_MID}0`, 'number'],
  [`QQ号 1${OWNER_QQ}9`, 'contact'],
  ['id87654321', 'number'],
  ['UID87654321', 'number'],
  ['av99999999999999999', 'contact'],
  ['QQ 20261026', 'contact'],
  ['QQ 100000000', 'contact'],
  ['wx: fakehandle', 'contact'],
  ['微信：fake_handle', 'contact'],
  ['微信号是 fakehandle', 'contact'],
  ['~/Documents/private-notes', 'path'],
  ['/srv/private/notes', 'path'],
  ['在 /data/notes/x 里', 'path'],
  // Codex 第二轮
  ['https://bilibili.com。公司.cn', 'link'],
  ['bilibili.com.公司.cn', 'link'],
  ['去 例子.cn 领', 'link'],
  [`https://www.bilibili.com/video/${BV}?vd_source=abc我的手机13800138000`, 'contact'],
  [`https://www.bilibili.com/video/${BV}?vd_source=abc13800138000`, 'number'],   // 只出在 ? 后面 → 按号码说（叫她去掉 ? 后面）
  ['wx bili_13800138000', 'contact'],
  ['vx av13800138000', 'contact'],
  ['QQ BV1123456789', 'contact'],
  ['加我微信 fakehandle', 'contact'],
  ['av87654321hello', 'number'],
  ['bili_87654321hello', 'number'],
  ['/data/20261026/notes', 'path'],
  ['/av12345678/notes', 'path'],
  // Codex 第三轮
  ['https://bilibili.com。例子。cn', 'link'],
  ['例子。cn', 'link'],
  ['av87654321.cn', 'link'],
  ['123.456.cn', 'link'],
  ['邮箱 av87654321@bilibili.com', 'contact'],
  ['wx @bili_13800138000', 'contact'],
  ['Telegram: @FakeUser', 'contact'],
  ['微信：fakehandle.', 'contact'],
  [`https://www.bilibili.com/video/${BV}?ts=1765432199fakehandle`, 'number'],
  [`https://www.bilibili.com/video/${BV}?vd_source=13800138000aaaaaaaaaaaaaaaaaaaaa_fake`, 'number'],
  ['文件在/data/private/notes', 'path'],
  ['/1.23/notes', 'path'],
  // Codex 第四轮
  [`主人 UID ${OWNER_MID.slice(0, 4)}    ${OWNER_MID.slice(4)}`, 'number'],
  ['电话：+1-202-555-0147', 'contact'],
  ['联系我：微信：FakeHandle', 'contact'],
  ['微信：fake-handle', 'contact'],
  ['邮箱 fake @ bilibili.com', 'contact'],
  ['邮箱 fake @ qq . com', 'contact'],
  ['去 example。 com 看看', 'link'],
  ['微信号：abc＿123', 'contact'],
  ['vx: abc－123', 'contact'],
  [`文件在 C：＼Users＼Fake＼Notes`, 'path'],
  ['官网：例子.中国', 'link'],
  ['bilibili.com.中国', 'link'],
  ['文件在/data/私人/日记', 'path'],
  ['文件在./notes/private', 'path'],
  ['文件在../notes/private', 'path'],
  ['cookie 名是 S E S S D A T A', 'cookie'],
  ['cookie 名是 b i l i _ j c t', 'cookie'],
  // Codex 第五轮
  ['电话：(202) 555-0147', 'contact'],
  ['我的电话是 +1-202-555-0147', 'contact'],
  ['微信：Fakehandle', 'contact'],
  ['我的微信是 FakeHandle', 'contact'],
  ['去 example . dev 看看', 'link'],
  ['邮箱 fake @ bilibili . tv', 'contact'],
  ['文件：/data/notes', 'path'],
  ['文件：/data/私人/日记', 'path'],
  ['官网：例子.香港', 'link'],
  ['官网：bilibili.com.香港', 'link'],
  ['文件在/私人/日记', 'path'],
]

test('outbound lib: everyday chat, dates, episode numbers, her math column, BV ids, Bilibili links and @nicknames pass', async () => {
  const { checkPublicText } = await lib()
  for (const s of PASS) {
    const r = checkPublicText(s, { cfg: CFG })
    assert.equal(r.ok, true, `${s} → ${r.why}`)
    assert.equal(r.text, s, '原样返回，不改她写的字')
  }
  // 换行、空的不在这里管（各命令自己要求有没有正文）
  assert.equal(checkPublicText('第一行\r\n第二行\t完', { cfg: CFG }).ok, true)
  assert.equal(checkPublicText('', { cfg: CFG }).ok, true)
})

test('outbound lib: off-site links (full-width, zero-width too), contacts, long numbers, the owner UID / QQ and her QQ, paths and cookie names are blocked', async () => {
  const { checkPublicText } = await lib()
  for (const [s, kind] of BLOCK) {
    const r = checkPublicText(s, { cfg: CFG })
    assert.equal(r.ok, false, `该拦：${s}`)
    assert.equal(r.kind, kind, s)
    assert.match(r.why, /^(公开的话里|正文里)/)
    // 拒绝的话不抄出号码、不说是谁的
    for (const n of [OWNER_MID, OWNER_QQ, SELF_QQ, '13800138000', '87654321']) assert.ok(!r.why.includes(n), `${s} → ${r.why}`)
    assert.doesNotMatch(r.why, /主人的|她的 QQ|Owner/)
  }
  // 站外链接只报域名（路径、参数、「xx@」前面那段都不报）
  const why = checkPublicText('看 https://user:tok123@evil.cn/a/secret?k=v', { cfg: CFG }).why
  assert.match(why, /（evil\.cn）/)
  assert.doesNotMatch(why, /tok123|secret|k=v/)
  // 域名里的数字全遮掉（不把主人的号抄回给她，拆开写的也一样）
  assert.match(checkPublicText(`去 u${OWNER_MID}.evil.cn`, { cfg: CFG }).why, /（u…\.evil\.cn）/)
  const split = checkPublicText(`去 u${OWNER_MID.slice(0, 4)}-${OWNER_MID.slice(4)}.evil.cn`, { cfg: CFG }).why
  assert.doesNotMatch(split, /\d/, split)
  // 大整数：告诉她怎么改写
  assert.match(checkPublicText('2^32 = 4294967296', { cfg: CFG }).why, /约 43 亿.*4,294,967,296/)
})

test('outbound lib: "@owner name" is only skipped when nothing domain-like follows it', async () => {
  const { checkPublicText } = await lib()
  for (const s of ['@Owner.evil.cn 好看', '@Owner.evil。cn', '@Owner-evil.cn']) {
    const r = checkPublicText(s, { cfg: CFG })
    assert.equal(r.ok, false, s); assert.equal(r.kind, 'link', s)
  }
  for (const s of ['@Owner 好看', '@Owner，好看', '@Owner。好看', '@Owner']) assert.equal(checkPublicText(s, { cfg: CFG }).ok, true, s)
})

test('outbound lib: a long id in a Bilibili query string gets the number message (drop the part after ?), not the contact one', async () => {
  const { checkPublicText } = await lib()
  for (const s of [`https://www.bilibili.com/list/watchlater?bvid=${BV}&oid=113024680135791`,
    `https://www.bilibili.com/video/${BV}?share_source=copy_web&vd_source=abcdef&up_id=3494351234567890`]) {
    const r = checkPublicText(s, { cfg: CFG })
    assert.equal(r.kind, 'number', s)
    assert.match(r.why, /\? 后面的参数去掉/)
  }
  // 参数后面接着写的中文里的手机号还是「联系方式」
  assert.equal(checkPublicText(`https://b23.tv/AbCdEfG?a=1我的手机13800138000`, { cfg: CFG }).kind, 'contact')
})

test('outbound lib: the owner UID is blocked inside a space link even when the long id would be masked; other people and @Owner are fine', async () => {
  const { checkPublicText } = await lib()
  const cfg = { owner: { mid: LONG_OWNER, name: 'Owner' } }
  assert.equal(checkPublicText(`https://space.bilibili.com/${LONG_OWNER}`, { cfg }).ok, false)
  assert.equal(checkPublicText(`space.bilibili.com/${LONG_OWNER}?spm_id_from=333`, { cfg }).ok, false)
  assert.equal(checkPublicText('https://space.bilibili.com/3494351234567890', { cfg }).ok, true)
  assert.equal(checkPublicText(`https://space.bilibili.com/${LONG_OWNER}`, { cfg: {} }).ok, true, '没配主人的号：别人的 space 链接照常')
  // 主人的昵称像域名 / 带长数字也不拦「@昵称」；别的地方的同一串照样拦
  const odd = { owner: { mid: OWNER_MID, name: 'owner.moe' } }
  assert.equal(checkPublicText('@owner.moe 这期你会喜欢', { cfg: odd }).ok, true)
  assert.equal(checkPublicText('去 owner.moe 看', { cfg: odd }).ok, false)
  // 「a@owner.moe」是邮箱，不是 @昵称（Codex 复查）
  assert.equal(checkPublicText('写信到 a@owner.moe', { cfg: odd }).kind, 'contact')
  for (const s of ['fake!@owner.moe', 'x/@owner.moe', 'y=@owner.moe', 'z~@owner.moe']) assert.equal(checkPublicText(s, { cfg: odd }).ok, false, s)
  // 引号里的邮箱用户名、主人昵称恰好像账号：照样是联系方式（Codex 第三轮）
  assert.equal(checkPublicText('邮箱 "fake name"@owner.moe', { cfg: odd }).kind, 'contact')
  assert.equal(checkPublicText('wx: @fake_handle', { cfg: { owner: { mid: OWNER_MID, name: 'fake_handle' } } }).kind, 'contact')
})

// ─────────────── 命令真跑 ───────────────
function sandbox(t, { cfg = CFG, agent = true, rawCfg = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-outbound-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'portable/profile'), work = path.join(home, 'whale-work')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai')); fs.mkdirSync(work)
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), rawCfg ?? JSON.stringify({ ...cfg, listen: { comment: false, dm: false, live: false } }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test-buvid' }))
  // 一张 1x1 的 PNG（只要头对：dynamic-image 读类型和尺寸）
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20)
  fs.writeFileSync(path.join(work, 'pic.png'), png)
  const env = {
    ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'),
    BILI_WHALE_AI_HOME: work, TEST_REQUESTS: path.join(home, 'requests.jsonl'), REPLY_LOG: path.join(home, 'replies.log'), VIEW_AID: String(AID), SHARE_VIEW: 'ok',
    NODE_OPTIONS: '--import=' + href('tests/helpers/share-view-fetch.mjs'),
  }
  delete env.BILI_WHALE_TURN; delete env.BILI_RESULT_FILE
  if (agent) env.BILI_WHALE_AGENT = '1'; else delete env.BILI_WHALE_AGENT
  return { env, home, work }
}
const run = (env, file, args) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/commands', file), ...args], { env, encoding: 'utf8', timeout: 30000 })
  assert.ifError(r.error)
  return { ...r, all: (r.stdout ?? '') + (r.stderr ?? '') }
}
const requests = (env) => fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
// HOME 下的每个文件 / 目录（和内容）：拦下的那一次前后必须一模一样 —— 额度预留、记账、判重、锁、调试日志都没写
function tree(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p)
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

// 每个通道：命令、参数（TEXT 换成要发的字）；edit-dynamic 的正文从文件读、不给 --go 就是预演
const CHANNELS = {
  comment: { file: 'comment.mjs', label: '评论', args: (x, m) => ['--oid', String(AID), '--bvid', BV, '--message', x, m] },
  reply: { file: 'comment.mjs', label: '回复', args: (x, m) => ['--oid', String(AID), '--bvid', BV, '--root', '9', '--parent', '10', '--message', x, m] },
  share: { file: 'comment.mjs', label: '分享评论', args: (x, m) => ['--oid', String(AID), '--bvid', BV, '--message', `@Owner ${x}`, '--share', '--auto', '--reason', '这是值得分享的视频', '--score', '15', '--rank', '1', m] },
  dynamic: { file: 'dynamic.mjs', label: '动态', args: (x, m) => ['post', '--text', x, m] },
  'dynamic-image': { file: 'dynamic-image.mjs', label: '图文动态', args: (x, m, s) => ['--image', path.join(s.work, 'pic.png'), '--text', x, m] },
  'dynamic-edit': { file: 'edit-dynamic.mjs', label: '动态（编辑）', args: (x, m, s) => { const f = path.join(s.work, 'new.txt'); fs.writeFileSync(f, x); return ['1000000000000000001', f, ...(m === '--go' ? ['--go'] : [])] } },
  danmaku: { file: 'danmaku.mjs', label: '弹幕', args: (x, m) => ['send', '--room', '31415926', '--msg', x, m] },
}
// 只在「拦下」里跑的变体：拦下必须早于 --once-per-person 的判重（查被回复者、写 once-debug.log）、--check 的只读预检（查被回复者）、
//   --bvid 给 b23.tv 短链时的解析（问 b23.tv）—— 检查挪到它们后面，这里就会多出请求 / 文件
const VARIANTS = {
  'reply --once-per-person': { file: 'comment.mjs', label: '回复', args: (x, m) => ['--oid', String(AID), '--bvid', BV, '--root', '9', '--parent', '10', '--message', x, '--once-per-person', m] },
  'reply --check': { file: 'comment.mjs', label: '回复', args: (x) => ['--oid', String(AID), '--bvid', BV, '--root', '9', '--parent', '10', '--message', x, '--check'] },
  'comment --bvid b23.tv': { file: 'comment.mjs', label: '评论', args: (x, m) => ['--oid', String(AID), '--bvid', 'https://b23.tv/AbCdEfG', '--message', x, m] },
}
const BAD = [
  [`主页在 https://space.bilibili.com/${OWNER_MID}`, '--go'],
  ['来 ｅｘａｍｐｌｅ．ｃｏｍ 找我', '--dry'],
  [`加我 ${SELF_QQ}，主人是 ${OWNER_QQ}`, '--go'],
  [`UID ${keycap(OWNER_MID)}`, '--go'],
  ['去 evil。cn 看', '--dry'],
]

for (const [name, ch] of Object.entries({ ...CHANNELS, ...VARIANTS })) {
  test(`outbound ${name}: blocked text sends no request, takes no quota, writes no ledger or lock (--go and --dry)`, (t) => {
    for (const [text, mode] of BAD) {
      const s = sandbox(t)
      const args = ch.args(text, mode, s)   // edit-dynamic 的正文文件先写好，再拍「之前」
      const before = tree(s.home)
      const r = run(s.env, ch.file, args)
      assert.equal(r.status, 2, `${text} ${mode}\n${r.all}`)
      assert.match(r.stderr, new RegExp(`✗ 这条${ch.label.replace(/[()（）]/g, '.')}没发：.*什么都没发`))
      assert.equal(r.stderr.trim().split('\n').length, 1, '一行话')
      for (const n of [OWNER_MID, OWNER_QQ, SELF_QQ]) assert.ok(!r.all.includes(n), `输出里不抄号码：${r.all}`)
      assert.deepEqual(requests(s.env), [], '一个请求都没发')
      assert.deepEqual(tree(s.home), before, 'HOME 里什么都没写（额度、记账、判重、锁）')
    }
  })
}

test('outbound: @-name fields are checked too (dynamic-image --at-name, danmaku --reply-name)', (t) => {
  const s = sandbox(t)
  let r = run(s.env, 'dynamic-image.mjs', ['--image', path.join(s.work, 'pic.png'), '--text', '好看', '--at', '42', '--at-name', 'evil.cn', '--dry'])
  assert.equal(r.status, 2, r.all); assert.deepEqual(requests(s.env), [])
  r = run(s.env, 'danmaku.mjs', ['send', '--room', '31415926', '--msg', '好看', '--reply-mid', '42', '--reply-name', `QQ${OWNER_QQ}`, '--go'])
  assert.equal(r.status, 2, r.all); assert.deepEqual(requests(s.env), [])
})

test('outbound: normal text still goes through every channel (--dry / preview: no POST), and a real comment and dynamic still post', (t) => {
  const ok = '今天 20:30 更新了第 12 集 😂 x^2+1=0、π≈3.14159 都讲了 https://t.bilibili.com/1000000000000000001 BV1b4W1eeE2g'
  for (const [name, ch] of Object.entries(CHANNELS)) {
    const s = sandbox(t, { agent: false })
    const r = run(s.env, ch.file, ch.args(ok, '--dry', s))
    assert.equal(r.status, 0, `${name}\n${r.all}`)
    assert.doesNotMatch(r.all, /没发：/)
    assert.deepEqual(requests(s.env).filter((q) => q.method === 'POST'), [], name)
  }
  let s = sandbox(t, { agent: false })
  let r = run(s.env, 'comment.mjs', CHANNELS.comment.args(`@Owner ${ok}`, '--go'))
  assert.equal(r.status, 0, r.all)
  assert.equal(requests(s.env).filter((q) => q.method === 'POST' && q.path === '/x/v2/reply/add').length, 1)
  s = sandbox(t, { agent: false })
  r = run(s.env, 'dynamic.mjs', CHANNELS.dynamic.args(ok, '--go'))
  assert.equal(r.status, 0, r.all)
  assert.equal(requests(s.env).filter((q) => q.method === 'POST' && q.path === '/x/dynamic/feed/create/dyn').length, 1)
})

test('outbound: on real commands, long decimals, big round numbers, other people\'s space links, av ids and @owner-name-with-dots still pass', (t) => {
  const ALLOW = [
    '1/3 = 0.333333333…，π = 3.14159265358979',
    '一亿 = 100000000，20261026 更新',
    '主页 https://space.bilibili.com/3494351234567890',
    '老片子 av113024680135791',
    '直播间 https://live.bilibili.com/31415926',
  ]
  for (const ch of [CHANNELS.comment, CHANNELS.dynamic]) {
    for (const x of ALLOW) {
      const s = sandbox(t, { agent: false })
      const r = run(s.env, ch.file, ch.args(x, '--dry', s))
      assert.equal(r.status, 0, `${ch.file} ${x}\n${r.all}`)
      assert.doesNotMatch(r.all, /没发：/)
    }
  }
  // 主人的昵称带点：「@昵称」能发，「@昵称.evil.cn」不能
  const odd = { ...CFG, owner: { mid: OWNER_MID, name: 'owner.moe' } }
  let s = sandbox(t, { cfg: odd, agent: false })
  let r = run(s.env, 'comment.mjs', CHANNELS.comment.args('@owner.moe 这期你会喜欢', '--dry'))
  assert.equal(r.status, 0, r.all)
  s = sandbox(t, { cfg: odd })
  r = run(s.env, 'comment.mjs', CHANNELS.comment.args('@owner.moe.evil.cn 这期你会喜欢', '--dry'))
  assert.equal(r.status, 2, r.all)
  assert.match(r.stderr, /站外链接/)
  assert.deepEqual(requests(s.env), [])
})

test('outbound: a config file that cannot be read stops the post (exit 3) before any request on every channel — the owner numbers cannot be checked', (t) => {
  for (const [name, ch] of Object.entries({ ...CHANNELS, ...VARIANTS })) {
    const s = sandbox(t, { rawCfg: '{ "owner": { "mid": ' })
    const args = ch.args('普通的一句话', '--go', s)
    const before = tree(s.home)
    const r = run(s.env, ch.file, args)
    assert.equal(r.status, 3, `${name}\n${r.all}`)
    assert.match(r.stderr, /配置文件读不出来.*什么都没发/, name)
    assert.deepEqual(requests(s.env), [], name)
    assert.deepEqual(tree(s.home), before, name)
  }
})

test('outbound: reply-draft add warns (does not block) when the draft would be refused at approval; the warning is stored for the owner', (t) => {
  const s = sandbox(t, { cfg: { ...CFG, notify: { type: 'none' } } })
  const add = (msg, parent) => run(s.env, 'reply-draft.mjs', ['add', '--oid', String(AID), '--bvid', BV, '--root', '9', '--parent', parent, '--who', '路人', '--message', msg])
  let r = add('主页在 example.com 哦', '10')
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /⚠️ 这条回复过不了公开发言的检查：公开的话里不放站外链接（example\.com）.*drop /)
  r = add('谢谢你，下次还来', '11')
  assert.equal(r.status, 0, r.all)
  assert.doesNotMatch(r.stdout, /过不了公开发言的检查/)
  const items = JSON.parse(fs.readFileSync(path.join(s.home, '.bili-ai/pending-replies.json'), 'utf8')).items
  assert.match(items[0].publicCheck, /站外链接（example\.com）/)
  assert.equal('publicCheck' in items[1], false)
  // 号码类的提醒也不抄出号码
  r = add(`加我 ${OWNER_QQ}`, '12')
  assert.equal(r.status, 0, r.all)
  assert.ok(!r.stdout.split('\n').some((l) => l.includes('过不了') && l.includes(OWNER_QQ)), r.stdout)
})
