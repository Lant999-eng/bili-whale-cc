// B站 扫码登录（host/bililogin.mjs）+ 登录状态检查 + 手动填 cookie：
//   给你看是哪个号（昵称 + UID）、你确认了才保存；过期 / 取消 / 出错 / 没确认 / 你自己的号 / 配置读不出来 → 原来的凭据一个字不动；
//   换号要把新 UID 打一遍；cookie / refresh_token / 二维码 key 不打印、不进状态文件和日志；失效时提醒一次，网络不通不算失效
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-login-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.bili-ai'))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: path.join(home, 'data'), DSH_NODE: process.execPath, BILI_WHALE_CONFIG: '', BILI_WHALE_NO_OPEN: '1' }
  delete env.NODE_OPTIONS
  delete env.BILI_WHALE_QR_PYTHON
  return env
}
const HEAD = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fakeBili, io, SESS, JCT, REFRESH, SPI } from 'file:///@ROOT@tests/helpers/passport-fake.mjs'
import { qrLogin, probeLogin, cookiesFrom, qrText, describeLogin } from 'file:///@ROOT@host/bililogin.mjs'
import { CRED_FILE, CFG_FILE, LOGIN_STATE_FILE, readConfig, writeConfig, readLoginState, writeCookie, whoIs, saveCredentials } from 'file:///@ROOT@host/core.mjs'
writeConfig({ ...readConfig(), owner: { mid: '222', name: 'Owner' } })
const OLD = JSON.stringify({ sessdata: 'OLD_SESSDATA_VALUE_0123456789', bili_jct: 'a'.repeat(32), buvid3: 'OLD-BUVID3-0000-0000-000000000000infoc', dedeuserid: '333' }, null, 2) + '\\n'
const putOld = (s = OLD) => fs.writeFileSync(CRED_FILE, s)
const credIs = (s) => assert.equal(fs.readFileSync(CRED_FILE, 'utf8'), s)
const tmpLeft = () => fs.readdirSync(path.dirname(CRED_FILE)).filter((f) => f.endsWith('.tmp'))
`
function script(env, code) {
  const file = path.join(env.USERPROFILE, 't.mjs')
  fs.writeFileSync(file, (HEAD + code).replaceAll('@ROOT@', root.replace(/\\/g, '/')))
  const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return r.stdout
}

test('QR login: shows nickname + UID first, saves only after you confirm, prints nothing secret', (t) => {
  script(sandbox(t), `
    let atAsk = null
    const b = fakeBili(), x = io(['y'], { onAsk: () => { atAsk = { cred: fs.existsSync(CRED_FILE), self: readConfig().self.mid, said: x.said.slice() } } })
    const r = await qrLogin(x, { fetch: b.fetch })
    assert.equal(r.saved, true); assert.deepEqual(r.self, { mid: '333', name: 'TestBot' }); assert.equal(r.switched, false)
    // 问的那一刻还什么都没写，而且昵称 + UID 已经给你看过了
    assert.equal(atAsk.cred, false); assert.equal(atAsk.self, '')
    assert.ok(atAsk.said.some((s) => s.includes('TestBot（UID 333）')))
    assert.equal(x.asked.length, 1); assert.match(x.asked[0], /保存/)
    // 写进去的
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    assert.equal(c.sessdata, SESS); assert.equal(c.bili_jct, JCT); assert.equal(c.buvid3, SPI); assert.equal(c.dedeuserid, '333')
    assert.equal(c.refresh_token, REFRESH); assert.equal(c.via, 'qr')
    assert.equal(readConfig().self.mid, '333'); assert.equal(readConfig().self.name, 'TestBot')
    // 只改了「她的号」这一项：主人还在，没把默认值整份写回去
    const rawCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    assert.equal(rawCfg.owner.mid, '222'); assert.equal(rawCfg.self.mid, '333')
    const st = readLoginState(); assert.equal(st.state, 'ok'); assert.equal(st.mid, '333')
    // 工具和 Python 读得出来（多出来的字段不碍事）
    const { loadCred } = await import('file:///@ROOT@tools/lib/cred.mjs')
    assert.deepEqual(loadCred(), { sessdata: SESS, bili_jct: JCT, buvid3: SPI })
    // nav 核对用的就是要存的这组
    assert.ok(b.calls.some((k) => k.url.includes('/nav') && k.cookie.includes('SESSDATA=' + SESS) && k.cookie.includes('bili_jct=' + JCT)))
    // 说过的话、状态文件里都没有 cookie / refresh_token / 二维码 key
    const all = [...x.said, ...x.asked, JSON.stringify(r), fs.readFileSync(LOGIN_STATE_FILE, 'utf8')].join('\\n')
    for (const s of [SESS, JCT, REFRESH, 'KEY1', 'qrcode_key']) assert.ok(!all.includes(s), s)
    assert.deepEqual(tmpLeft(), [])
    assert.equal(x.shown.length, 1); assert.match(x.shown[0], /^https:\\/\\/account\\.bilibili\\.com\\//)
    assert.ok(x.said.some((s) => s.includes('已扫码')))
  `)
})

test('QR login: expired, cancelled, declined, unverifiable or broken logins never touch the credentials you already have', (t) => {
  script(sandbox(t), `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    const cases = [
      ['expired, you say no to a new code', { polls: ['waiting', 'expired'] }, ['n'], /取消/, 1],
      ['expired three times', { polls: ['expired'] }, ['y', 'y'], /过期/, 3],
      ['expired, input closed', { polls: ['expired'] }, [], /取消/, 1],
      ['never scanned: gives up when the code is past its 3 minutes', { polls: ['waiting'] }, ['n'], /取消/, 1],
      ['input closed at the confirm prompt', {}, [], /没确认/, 1],
      ['you answer no', {}, ['no'], /没确认/, 1],
      ['you just press enter (default is no)', {}, [''], /没确认/, 1],
      ['B站 does not recognise the new cookie', { navCode: -101 }, ['y'], /这是谁.*没问出来/, 1],
      ['network down while checking who it is', { navCode: 'throw' }, ['y'], /这是谁.*没问出来.*ENOTFOUND/, 1],
      ['no DedeUserID in the answer and B站 does not recognise it', { noDede: true, setCookie: false, navCode: -101 }, ['y'], /这是谁.*没问出来/, 1],
      ['success without usable cookies', { setCookie: false, inUrl: false }, ['y'], /没拿到完整的 cookie/, 1],
      ['SESSDATA missing, bili_jct fine', { sess: '' }, ['y'], /没拿到完整的 cookie/, 1],
      ['SESSDATA fine, bili_jct malformed', { jct: 'xyz' }, ['y'], /没拿到完整的 cookie/, 1],
      ['UID in the cookie and nav disagree', { dedeMid: '999' }, ['y'], /对不上/, 1],
      ['no QR code from B站', { genFail: true }, [], /没给出二维码/, 1],
      ['poll keeps failing for a minute', { polls: ['throw'] }, [], /一直查不到/, 1],
      ['poll answers a state nobody has seen', { polls: ['weird'] }, [], /扫码接口可能改了/, 1],
    ]
    for (const [name, spec, answers, why, gens] of cases) {
      putOld()
      const b = fakeBili(spec), x = io(answers)
      const r = await qrLogin(x, { fetch: b.fetch })
      assert.equal(r.saved, false, name); assert.match(r.reason, why, name)
      credIs(OLD)
      assert.equal(readConfig().self.mid, '333', name)
      assert.equal(readLoginState(), null, name)
      assert.equal(b.calls.filter((k) => k.url.includes('/generate')).length, gens, name)
      for (const s of ['https://', 'KEY1', SESS, JCT]) assert.ok(!r.reason.includes(s), name + ': ' + s)
      assert.deepEqual(tmpLeft(), [], name)
    }
    // 没见过的扫码状态：问一次就停，不干等 3 分钟
    let b = fakeBili({ polls: ['weird'] }); await qrLogin(io([]), { fetch: b.fetch })
    assert.equal(b.calls.filter((k) => k.url.includes('/poll')).length, 1)
    // 网络断断续续（每次断不到一分钟）：不放弃，扫成了照常保存
    putOld()
    b = fakeBili({ polls: [...Array(20).fill('throw'), 'waiting', ...Array(20).fill('throw'), 'success'] })
    let r = await qrLogin(io(['y']), { fetch: b.fetch })
    assert.equal(r.saved, true)
    // 出错信息里像 cookie 的 key=value 抹掉
    putOld()
    r = await qrLogin(io([]), { fetch: fakeBili({ polls: ['throwSecret'] }).fetch })
    assert.equal(r.saved, false); assert.ok(!r.reason.includes('topsecretvalue')); assert.ok(!r.reason.includes('alsosecret')); assert.match(r.reason, /SESSDATA=\\*\\*\\*/)
    credIs(OLD)
    // 画不出二维码：不往下走
    b = fakeBili(); r = await qrLogin(io(['y'], { show: false }), { fetch: b.fetch })
    assert.equal(r.saved, false); assert.ok(!b.calls.some((k) => k.url.includes('/poll'))); credIs(OLD)
    // 过期后再来一张、这次扫成了：照常保存
    b = fakeBili({ polls: ['expired', 'success'] })
    r = await qrLogin(io(['', 'y']), { fetch: b.fetch })
    assert.equal(r.saved, true); assert.equal(b.calls.filter((k) => k.url.includes('/generate')).length, 2)
    // 配置文件读不出来：不核对、不保存、也不把配置冲掉
    putOld()
    const broken = '{ "owner": { "mid": "222" }, }'
    fs.writeFileSync(CFG_FILE, broken)
    r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '222', name: 'Owner' }).fetch })
    assert.equal(r.saved, false); assert.match(r.reason, /配置文件读不出来/); credIs(OLD); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), broken)
    // 记事本存的带 BOM 的配置：照样读得出来（主人的号照样认得）
    fs.writeFileSync(CFG_FILE, String.fromCharCode(0xfeff) + JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333' } }))
    r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '222', name: 'Owner' }).fetch })
    assert.equal(r.saved, false); assert.match(r.reason, /你（主人）自己的号/); credIs(OLD)
  `)
})

test('QR login: your own account is refused; a different account than before needs the new UID typed in', (t) => {
  script(sandbox(t), `
    putOld()
    let x = io(['y']), r = await qrLogin(x, { fetch: fakeBili({ mid: '222', name: 'Owner' }).fetch })
    assert.equal(r.saved, false); assert.match(r.reason, /你（主人）自己的号/); assert.equal(x.asked.length, 0); credIs(OLD)
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '444', name: 'Other' }).fetch })
    assert.equal(r.saved, false); credIs(OLD)
    assert.ok(x.said.some((s) => s.includes('换号了') && s.includes('UID 333') && s.includes('UID 444')))
    assert.match(x.asked[0], /444/)
    x = io(['444']); r = await qrLogin(x, { fetch: fakeBili({ mid: '444', name: 'Other' }).fetch })
    assert.equal(r.saved, true); assert.equal(r.switched, true)
    assert.equal(readConfig().self.mid, '444'); assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).dedeuserid, '444')
    // 配置里没记过她的号，但旧凭据里有 UID（文件带 BOM 也认）：一样算换号
    writeConfig({ ...readConfig(), self: { mid: '', name: '' } })
    const bomOld = String.fromCharCode(0xfeff) + OLD
    putOld(bomOld)
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '555' }).fetch })
    assert.equal(r.saved, false); credIs(bomOld); assert.match(x.asked[0], /555/)
    putOld()
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '333' }).fetch })
    assert.equal(r.saved, true); assert.equal(r.switched, false); assert.match(x.asked[0], /\\[y\\/N\\]/)
    // 名字里的控制字符 / 改方向字符不进终端
    putOld()
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '333', name: 'a\\u001b[2Jb\\u202ec' }).fetch })
    assert.ok(x.said.every((s) => !/[\\u001b\\u202e]/.test(s)))
    // 还没填主人的 UID：提醒你没法核对（照常可以存）
    writeConfig({ ...readConfig(), owner: { mid: '', name: '' } })
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '333' }).fetch })
    assert.equal(r.saved, true); assert.ok(x.said.some((s) => s.includes('还没填主人')))
  `)
})

test('QR login: cookies come raw from the redirect URL when Set-Cookie is missing; a usable old buvid3 is kept, a broken one replaced', (t) => {
  script(sandbox(t), `
    putOld()
    const b = fakeBili({ setCookie: false }), x = io(['y'])
    const r = await qrLogin(x, { fetch: b.fetch })
    assert.equal(r.saved, true)
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    assert.equal(c.sessdata, SESS)
    assert.equal(c.buvid3, 'OLD-BUVID3-0000-0000-000000000000infoc')
    assert.ok(!b.calls.some((k) => k.url.includes('/finger/spi')))
    // 旧的 buvid3 坏了（手抄时带进了空格）：重新要一个，不然这次登录也核对不了
    putOld(JSON.stringify({ sessdata: 'OLD_SESSDATA_VALUE_0123456789', bili_jct: 'a'.repeat(32), buvid3: 'OLD BUVID3 with spaces', dedeuserid: '333' }))
    const b2 = fakeBili()
    assert.equal((await qrLogin(io(['y']), { fetch: b2.fetch })).saved, true)
    assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).buvid3, SPI)
    // Set-Cookie 头优先于链接里的参数；没有 getSetCookie 时退回 set-cookie 合并头
    const h = { get: (k) => (k === 'set-cookie' ? 'SESSDATA=fromHeader%2C1; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT, bili_jct=' + 'b'.repeat(32) + '; Path=/' : null) }
    assert.deepEqual(cookiesFrom({ headers: h }, 'https://x.bilibili.com/?SESSDATA=fromUrl&DedeUserID=7'), { SESSDATA: 'fromHeader%2C1', bili_jct: 'b'.repeat(32), DedeUserID: '7' })
    // 终端里的二维码：▀ 的前景色 = 上格、背景色 = 下格（黑 30/40，白 97/107）；行数是奇数时最后一行下面补白
    assert.equal(qrText([[true, false, true], [false, true, true], [true, true, false]]),
      '\\x1b[30;107m▀\\x1b[97;40m▀\\x1b[30;40m▀\\x1b[0m\\n\\x1b[30;107m▀\\x1b[30;107m▀\\x1b[97;107m▀\\x1b[0m')
  `)
})

test('login check: ok / invalid (tells you once) / network trouble or risk control is not "invalid" / wrong account flagged; no cookie anywhere', (t) => {
  script(sandbox(t), `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    let clock = Date.parse('2026-10-23T10:00:00Z')
    const now = () => clock
    const sent = []
    const notify = async (m) => { sent.push(m) }
    const probe = (spec, n = notify) => probeLogin({ fetch: fakeBili(spec).fetch, now, notify: n })
    let s = await probe({})
    assert.equal(s.state, 'missing'); assert.equal(sent.length, 0)
    putOld()
    clock += 3600_000; s = await probe({})
    assert.equal(s.state, 'ok'); assert.equal(s.mid, '333'); assert.equal(s.problem, undefined); assert.equal(sent.length, 0)
    assert.equal(describeLogin(s).level, 'ok'); assert.match(describeLogin(s).text, /有效/)
    const okAt = s.lastOkAt
    clock += 3600_000; s = await probe({ navCode: -101 })
    assert.equal(s.state, 'invalid'); assert.equal(s.changed, true); assert.equal(sent.length, 1)
    assert.match(sent[0], /失效/); assert.match(sent[0], /cookie --qr/)
    assert.equal(describeLogin(s).level, 'bad'); assert.match(describeLogin(s).text, /失效.*cookie --qr/)
    const since = s.since
    clock += 3600_000; s = await probe({ navCode: -101 })
    assert.equal(s.state, 'invalid'); assert.equal(s.changed, false); assert.equal(sent.length, 1); assert.equal(s.since, since)
    assert.equal(s.lastOkAt, okAt); assert.equal(s.mid, '333')
    // 网络不通 / B站 风控（-412、-352）/ 回包缺 mid：都不算失效、不提醒；上次知道的号和最后有效时间留着
    for (const spec of [{ navCode: 'throw' }, { navCode: -412 }, { navCode: -352 }, { navCode: { raw: { code: 0, data: { isLogin: true } } } }]) {
      clock += 3600_000; s = await probe(spec)
      assert.equal(s.state, 'unknown', JSON.stringify(spec)); assert.equal(sent.length, 1); assert.equal(s.lastOkAt, okAt); assert.equal(s.mid, '333')
      assert.equal(describeLogin(s).level, 'warn')
    }
    assert.match(describeLogin(s).text, /上次确认有效/)
    // 中间查不到几次，又查到还是失效：同一个问题，不再提醒；「从什么时候失效」也不重算
    clock += 3600_000; s = await probe({ navCode: -101 })
    assert.equal(s.state, 'invalid'); assert.equal(sent.length, 1); assert.equal(s.since, since)
    // code 0 但 isLogin false：失效
    clock += 3600_000; s = await probe({ navCode: { raw: { code: 0, data: { isLogin: false } } } })
    assert.equal(s.state, 'invalid'); assert.equal(sent.length, 1)
    // 恢复
    clock += 3600_000; s = await probe({})
    assert.equal(s.state, 'ok'); assert.notEqual(s.lastOkAt, okAt)
    // 号和配置里的不一样 / 是你自己的号：各提醒一次；又换成另一个不对的号：再提醒
    clock += 3600_000; s = await probe({ mid: '444' })
    assert.equal(s.problem, 'mismatch'); assert.equal(s.expected, '333'); assert.equal(sent.length, 2); assert.match(sent[1], /444/)
    assert.equal(describeLogin(s).level, 'bad')
    clock += 3600_000; s = await probe({ mid: '444' }); assert.equal(sent.length, 2)
    clock += 3600_000; s = await probe({ mid: '555' }); assert.equal(sent.length, 3); assert.match(sent[2], /555/)
    clock += 3600_000; s = await probe({ mid: '222' })
    assert.equal(s.problem, 'owner'); assert.equal(sent.length, 4); assert.match(sent[3], /你自己的号/)
    assert.equal(describeLogin(s).level, 'bad')
    // 推送失败：把原因交给宿主记日志，下次再试
    clock += 3600_000; s = await probe({ navCode: -101 }, async () => { throw new Error('webhook down SESSDATA=leak123') })
    assert.equal(s.notifiedAt, null); assert.match(s.notifyError, /webhook down/); assert.ok(!s.notifyError.includes('leak123'))
    clock += 3600_000; s = await probe({ navCode: -101 })
    assert.equal(sent.length, 5); assert.ok(s.notifiedAt)
    // 存着的值格式坏了（有空格）：本地就判出来、不发请求、算失效（要重新登录），整条 cookie 不会出现在任何地方
    putOld(JSON.stringify({ sessdata: 'BROKEN SESSDATA VALUE 0123456789', bili_jct: 'a'.repeat(32), buvid3: '' }))
    const b = fakeBili({})
    clock += 3600_000; s = await probeLogin({ fetch: b.fetch, now, notify })
    assert.equal(s.state, 'invalid'); assert.match(s.why, /带了空格、引号、换行/); assert.ok(!b.calls.some((k) => k.url.includes('/nav')))
    // 状态文件和提醒里没有 cookie
    const all = fs.readFileSync(LOGIN_STATE_FILE, 'utf8') + sent.join('\\n')
    for (const v of ['OLD_SESSDATA_VALUE', 'a'.repeat(32), 'BROKEN SESSDATA', 'leak123']) assert.ok(!all.includes(v), v)
  `)
})

test('whoIs never passes the request error text on (it can contain the whole Cookie header)', (t) => {
  script(sandbox(t), `
    const cred = { sessdata: SESS, bili_jct: JCT, buvid3: SPI }
    let w = await whoIs(cred, { fetch: fakeBili({ navCode: 'throwHeader' }).fetch })
    assert.equal(w.ok, false); assert.equal(w.invalid, false)
    assert.ok(!JSON.stringify(w).includes(SESS)); assert.ok(!JSON.stringify(w).includes(JCT))
    w = await whoIs(cred, { fetch: fakeBili({ navCode: 'throw' }).fetch })
    assert.equal(w.netErr, 'ENOTFOUND')
    w = await whoIs(cred, { fetch: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e } })
    assert.equal(w.netErr, '超时')
    // 有换行 / 空格 / 分号的值：不发请求，直接说格式坏了
    let called = 0
    for (const bad of [{ ...cred, sessdata: 'abc\\ndef0123456789012345' }, { ...cred, buvid3: 'x;y' }, { ...cred, bili_jct: 'a b' }]) {
      w = await whoIs(bad, { fetch: async () => { called += 1; throw new Error('should not be called') } })
      assert.equal(w.badFormat, true)
    }
    assert.equal(called, 0)
  `)
})

test('manual cookie: B站 must recognise it, you see who it is and confirm, your own account is refused, switching needs the UID typed', (t) => {
  script(sandbox(t), `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    const input = { sessdata: SESS, bili_jct: JCT, buvid3: SPI }
    const use = (spec) => { globalThis.fetch = fakeBili(spec).fetch }
    putOld()
    use({ navCode: -101 }); let r = await writeCookie(input)
    assert.equal(r.ok, false); assert.match(r.error, /不认/); assert.match(r.error, /没写入/); assert.doesNotMatch(r.error, /--no-verify/); credIs(OLD)
    use({ navCode: 'throw' }); r = await writeCookie(input)
    assert.equal(r.ok, false); assert.match(r.error, /--no-verify/); credIs(OLD)
    use({ navCode: 'throwHeader' }); r = await writeCookie(input)
    assert.equal(r.ok, false); assert.ok(!r.error.includes(SESS)); credIs(OLD)
    use({ mid: '222' }); r = await writeCookie(input)
    assert.equal(r.ok, false); assert.match(r.error, /你（主人）自己的号/); credIs(OLD)
    // 你先看到是谁，再决定：没点头不写
    const seen = []
    const confirm = (answer) => async (info) => { seen.push(info); return typeof answer === 'function' ? answer(info) : answer }
    use({ mid: '444', name: 'Other' }); r = await writeCookie(input, { confirm: confirm(false) })
    assert.equal(r.ok, false); assert.match(r.error, /没换号/); credIs(OLD); assert.equal(readConfig().self.mid, '333')
    assert.equal(seen[0].who.mid, '444'); assert.equal(seen[0].who.name, 'Other'); assert.equal(seen[0].switched, true); assert.equal(seen[0].prev.mid, '333')
    r = await writeCookie(input, { confirm: confirm(true) })
    assert.equal(r.ok, true); assert.equal(r.switched, true); assert.match(r.detail, /换号/)
    assert.equal(readConfig().self.mid, '444'); assert.equal(readLoginState().state, 'ok')
    assert.equal(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).owner.mid, '222')
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    assert.equal(c.sessdata, SESS); assert.equal(c.dedeuserid, '444'); assert.equal(c.via, 'manual')
    // 同一个号：也要你点头（不算换号）
    seen.length = 0; r = await writeCookie(input, { confirm: confirm(false) })
    assert.equal(r.ok, false); assert.match(r.error, /没确认/); assert.equal(seen[0].switched, false)
    // 配置里没记她的号、旧凭据里有别的 UID：算换号（和扫码一样）
    writeConfig({ ...readConfig(), self: { mid: '', name: '' } }); putOld()
    seen.length = 0; r = await writeCookie(input, { confirm: confirm(false) })
    assert.equal(seen[0].switched, true); assert.equal(seen[0].prev.mid, '333'); credIs(OLD)
    // 没填主人 UID：告诉 confirm（命令行会提醒你）
    writeConfig({ ...readConfig(), owner: { mid: '', name: '' } })
    seen.length = 0; await writeCookie(input, { confirm: confirm(false) }); assert.equal(seen[0].ownerUnknown, true)
    writeConfig({ ...readConfig(), owner: { mid: '222', name: 'Owner' } })
    // 配置文件读不出来：不写，也不把配置冲掉
    const broken = '{ "owner": { "mid": "222" }, }'
    fs.writeFileSync(CFG_FILE, broken)
    use({ mid: '222' }); r = await writeCookie(input)
    assert.equal(r.ok, false); assert.match(r.error, /配置文件读不出来/); credIs(OLD); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), broken)
    writeConfig({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'TestBot' } })
    // 值里有换行 / 空格：说清楚、不写（--no-verify 也不行）
    for (const bad of [{ ...input, sessdata: 'abc\\ndef0123456789012345' }, { ...input, buvid3: 'has space-0000-0000-0000' }]) {
      for (const verify of [true, false]) {
        r = await writeCookie(bad, { verify }); assert.equal(r.ok, false); assert.match(r.error, /不能用的字符/); credIs(OLD)
      }
    }
    // --no-verify：不问 B站 直接写；登录状态改成「没核对」，面板不再说原来那个号有效
    markOk: { const { markLoginOk } = await import('file:///@ROOT@host/core.mjs'); markLoginOk({ mid: '333', name: 'TestBot' }) }
    use({ navCode: 'throw' }); r = await writeCookie(input, { verify: false })
    assert.equal(r.ok, true); assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).sessdata, SESS)
    const st = readLoginState(); assert.equal(st.state, 'unknown'); assert.equal(st.mid, null); assert.match(st.why, /没核对/)
    assert.deepEqual(tmpLeft(), [])
  `)
})

test('credentials are written atomically (temp file + rename), never in place', (t) => {
  script(sandbox(t), `
    putOld()
    const writes = [], renames = []
    const ow = fs.writeFileSync, or = fs.renameSync
    fs.writeFileSync = (f, ...a) => { writes.push(String(f)); return ow(f, ...a) }
    fs.renameSync = (a, b) => { renames.push([String(a), String(b)]); return or(a, b) }
    try { saveCredentials({ sessdata: SESS, bili_jct: JCT, buvid3: '' }) } finally { fs.writeFileSync = ow; fs.renameSync = or }
    assert.ok(!writes.includes(CRED_FILE), '不能直接写凭据文件')
    assert.equal(renames.length, 1); assert.equal(renames[0][1], CRED_FILE); assert.ok(writes.includes(renames[0][0]))
    assert.equal(path.dirname(renames[0][0]), path.dirname(CRED_FILE))
    assert.deepEqual(tmpLeft(), [])
    // 改名失败：原来的不动，临时文件也不留
    fs.renameSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    putOld()
    try { assert.throws(() => saveCredentials({ sessdata: SESS, bili_jct: JCT, buvid3: '' })) } finally { fs.renameSync = or }
    credIs(OLD); assert.deepEqual(tmpLeft(), [])
  `)
})

test('dashboard: login state shown without reading credentials; invalid / missing / wrong account flagged in red with the re-login command', (t) => {
  script(sandbox(t), `
    const { collect, render } = await import('file:///@ROOT@host/dashboard.mjs')
    putOld()
    const page = () => { const s = collect(); return { s, html: render(s) } }
    const fact = (html) => (html.match(/<span[^>]*>她的 B站 登录[^<]*<\\/span>/) ?? [''])[0]
    let { s, html } = page()
    assert.equal(s.login.state, 'never'); assert.match(html, /还没查过/)
    const put = (v) => { fs.mkdirSync(path.dirname(LOGIN_STATE_FILE), { recursive: true }); fs.writeFileSync(LOGIN_STATE_FILE, JSON.stringify(v)) }
    const at = new Date().toISOString()
    put({ state: 'ok', mid: '333', name: '<b>TestBot</b>', checkedAt: at, since: at, lastOkAt: at })
    ;({ s, html } = page())
    assert.match(fact(html), /有效/); assert.doesNotMatch(fact(html), /class="err"/)
    assert.ok(html.includes('&lt;b&gt;TestBot&lt;/b&gt;')); assert.ok(!html.includes('<b>TestBot'))
    assert.ok(!s.errors.flags.some((f) => f.includes('登录')))
    put({ state: 'invalid', mid: '333', name: 'x', checkedAt: at, since: at, why: 'nav 返回 code=-101 账号未登录' })
    ;({ s, html } = page())
    assert.ok(s.errors.flags.some((f) => f.includes('失效') && f.includes('cookie --qr')))
    assert.match(fact(html), /失效了/); assert.match(fact(html), /class="err"/)
    put({ state: 'missing', checkedAt: at })
    ;({ s, html } = page()); assert.ok(s.errors.flags.some((f) => f.includes('还没登录') && f.includes('cookie --qr'))); assert.match(fact(html), /class="err"/)
    put({ state: 'ok', mid: '222', name: 'Owner', problem: 'owner', checkedAt: at })
    ;({ s, html } = page()); assert.ok(s.errors.flags.some((f) => f.includes('你自己的号'))); assert.match(fact(html), /class="err"/)
    put({ state: 'ok', mid: '444', name: 'Other', problem: 'mismatch', expected: '333', checkedAt: at })
    ;({ s } = page()); assert.ok(s.errors.flags.some((f) => f.includes('444') && f.includes('333')))
    put({ state: 'ok', mid: '333', name: 'x', checkedAt: new Date(Date.now() - 5 * 3600_000).toISOString() })
    ;({ html } = page()); assert.match(html, /很久没更新/)
    put({ state: 'unknown', mid: '333', name: 'x', checkedAt: at, lastOkAt: at, why: '这次没查到（请求失败：超时）' })
    ;({ s, html } = page()); assert.match(html, /上次没查到/); assert.match(html, /最后一次确认有效/)
    assert.ok(!s.errors.flags.some((f) => f.includes('登录')))
    // 状态文件里万一有 cookie 的样子、名字里有控制字符 / 改方向字符：都不出现在页面和数据里
    put({ state: 'invalid', mid: '333', name: 'a\\u202eb\\u0007c', checkedAt: at, since: at, why: '… SESSDATA=secretval; bili_jct=secretjct' })
    ;({ s, html } = page())
    const all = JSON.stringify(s) + html
    for (const v of ['secretval', 'secretjct', '\\u202e', '\\u0007', 'OLD_SESSDATA_VALUE', 'a'.repeat(32)]) assert.ok(!all.includes(v), JSON.stringify(v))
  `)
})

test('QR login edge cases: no DedeUserID, Set-Cookie only, numeric mids, bad generate answers, transient poll errors, closed input at the UID prompt', (t) => {
  script(sandbox(t), `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    // 回包里没有 DedeUserID：照常核对、保存，UID 用 B站 说的
    putOld()
    let x = io(['y'], { onAsk: () => { assert.ok(x.said.some((s) => s.includes('TestBot（UID 333）'))) } })
    let r = await qrLogin(x, { fetch: fakeBili({ noDede: true }).fetch })
    assert.equal(r.saved, true); assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).dedeuserid, '333')
    // 只有 Set-Cookie（链接里没有）：从头里取
    putOld()
    r = await qrLogin(io(['y']), { fetch: fakeBili({ setCookie: true, inUrl: false }).fetch })
    assert.equal(r.saved, true); assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).sessdata, SESS)
    // 手改配置时 mid 写成了数字：照样认出是你自己的号 / 是换号
    fs.writeFileSync(CFG_FILE, JSON.stringify({ owner: { mid: 222, name: 'Owner' }, self: { mid: 333, name: 'TestBot' } }))
    putOld()
    r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '222' }).fetch }); assert.equal(r.saved, false); assert.match(r.reason, /你（主人）自己的号/); credIs(OLD)
    x = io(['y']); r = await qrLogin(x, { fetch: fakeBili({ mid: '444' }).fetch }); assert.equal(r.saved, false); assert.match(x.asked[0], /444/); credIs(OLD)
    // 换号时问 UID，输入已经结束（读到头）：不换
    x = io([]); r = await qrLogin(x, { fetch: fakeBili({ mid: '444' }).fetch }); assert.equal(r.saved, false); assert.match(r.reason, /没确认/); credIs(OLD)
    // 二维码接口回的地址不是 B站 的 / key 不对：不画、不查
    for (const spec of [{ genUrl: 'https://evil.example/x?qrcode_key=1' }, { genKey: '' }, { genKey: 'a b' }]) {
      const b = fakeBili(spec); x = io(['y'])
      r = await qrLogin(x, { fetch: b.fetch })
      assert.equal(r.saved, false); assert.match(r.reason, /没给出二维码/); assert.equal(x.shown.length, 0); assert.ok(!b.calls.some((k) => k.url.includes('/poll')))
    }
    // 查扫码进度时外层回 -412（风控）一阵：不放弃；一直这样一分钟：放弃
    r = await qrLogin(io(['y']), { fetch: fakeBili({ polls: [...Array(10).fill('outer412'), 'success'] }).fetch })
    assert.equal(r.saved, true)
    putOld()
    r = await qrLogin(io([]), { fetch: fakeBili({ polls: ['outer412'] }).fetch })
    assert.equal(r.saved, false); assert.match(r.reason, /一直查不到.*-412/); credIs(OLD)
  `)
})

test('config: a config file that cannot be read is never overwritten (login, config set); setSelf only touches "self"', (t) => {
  script(sandbox(t), `
    const { readConfigStrict, setSelf, saveSettings, setConfigPath } = await import('file:///@ROOT@host/core.mjs')
    putOld()
    for (const bad of ['{ "owner": { "mid": "222" }, }', 'null', '[]', '"text"']) {
      fs.writeFileSync(CFG_FILE, bad)
      assert.equal(readConfigStrict().ok, false, bad)
      assert.throws(() => setSelf({ mid: '1', name: 'x' })); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), bad)
      assert.equal(saveSettings({ quota: { shareDaily: 2 } }).ok, false); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), bad)
      assert.equal(setConfigPath('owner.name', 'me').ok, false); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), bad)
      const r = await qrLogin(io(['y']), { fetch: fakeBili({}).fetch })
      assert.equal(r.saved, false, bad); assert.match(r.reason, /配置文件读不出来/); credIs(OLD); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), bad)
    }
    // 配置文件是个目录（打不开）：一样不写
    fs.rmSync(CFG_FILE); fs.mkdirSync(CFG_FILE)
    let r = await qrLogin(io(['y']), { fetch: fakeBili({}).fetch })
    assert.equal(r.saved, false); assert.match(r.reason, /打不开/); credIs(OLD)
    fs.rmSync(CFG_FILE, { recursive: true })
    // 没有配置文件：按默认值来（可以登录）
    assert.equal(readConfigStrict().ok, true)
    // 登录成功只改「她的号」这一项：别的原样留着，不把默认值写进去
    const orig = { owner: { mid: '222', name: 'Owner' }, notify: { type: 'webhook', url: 'https://hook.example/x' }, custom: { keep: 1 } }
    fs.writeFileSync(CFG_FILE, JSON.stringify(orig))
    r = await qrLogin(io(['y']), { fetch: fakeBili({}).fetch })
    assert.equal(r.saved, true)
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    assert.deepEqual(raw, { ...orig, self: { mid: '333', name: 'TestBot' } })
    fs.writeFileSync(CFG_FILE, JSON.stringify(orig))
    globalThis.fetch = fakeBili({ mid: '333' }).fetch
    assert.equal((await writeCookie({ sessdata: SESS, bili_jct: JCT })).ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')), { ...orig, self: { mid: '333', name: 'TestBot' } })
  `)
})

test('manual cookie field checks: each one alone, and characters that cannot go into a header (also after URL-decoding)', (t) => {
  script(sandbox(t), `
    const cases = [
      [{ sessdata: SESS, bili_jct: 'f'.repeat(31) }, /bili_jct 格式不对/],
      [{ sessdata: SESS, bili_jct: 'g'.repeat(32) }, /bili_jct 格式不对/],
      [{ sessdata: 'short123', bili_jct: JCT }, /太短/],
      [{ sessdata: 'fakeSESSDATA0123456789,1999999999,abcd*b1', bili_jct: JCT }, /不能用的字符/],
      [{ sessdata: 'fakeSESSDATA0123456789"1999999999', bili_jct: JCT }, /不能用的字符/],
      [{ sessdata: SESS, bili_jct: JCT, buvid3: 'AAAA,BBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF' }, /不能用的字符/],
    ]
    globalThis.fetch = fakeBili({}).fetch
    for (const [input, why] of cases) {
      for (const verify of [true, false]) {
        putOld()
        const r = await writeCookie(input, { verify })
        assert.equal(r.ok, false, JSON.stringify(input)); assert.match(r.error, why); credIs(OLD)
      }
    }
    // whoIs 自己也挡：引号、逗号、分号、反斜杠、空格、换行、中文
    let called = 0
    for (const bad of ['a"b', 'a,b', 'a;b', 'a\\\\b', 'a b', 'a\\nb', '中文']) {
      const w = await whoIs({ sessdata: 'x' + bad + 'x0123456789012345678', bili_jct: JCT }, { fetch: async () => { called += 1 } })
      assert.equal(w.badFormat, true, JSON.stringify(bad))
    }
    assert.equal(called, 0)
    // B站 真会发的值都放行：SESSDATA 里有 %2C 和 *，buvid3 以 infoc 结尾
    const w = await whoIs({ sessdata: SESS, bili_jct: JCT, buvid3: SPI }, { fetch: fakeBili({}).fetch })
    assert.equal(w.ok, true)
  `)
})

test('login check: judged by what the tools really send (quotes / spaces / BOM in SESSDATA or bili_jct = needs re-login); a broken buvid3 alone is not "invalid"; missing bili_jct is "missing"', (t) => {
  script(sandbox(t), `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    const sent = []
    const probe = async (cred, spec = {}) => {
      putOld(JSON.stringify(cred))
      const b = fakeBili(spec)
      const s = await probeLogin({ fetch: b.fetch, notify: async (m) => sent.push(m) })
      return { s, navs: b.calls.filter((k) => k.url.includes('/nav')) }
    }
    // 引号、首尾空白、换行（手改 / 老版本留下的）：多数工具原样读、原样发 —— 会出错，所以算「用不了」，提醒重新登录；不去问 nav
    for (const bad of [{ sessdata: '"' + SESS + '"', bili_jct: JCT }, { sessdata: SESS, bili_jct: ' ' + JCT }, { sessdata: SESS + '\\n', bili_jct: JCT }, { sessdata: 'abc\\ndef0123456789012345', bili_jct: JCT }]) {
      const { s, navs } = await probe(bad)
      assert.equal(s.state, 'invalid', JSON.stringify(bad)); assert.match(s.why, /带了空格、引号、换行/); assert.equal(navs.length, 0)
    }
    assert.equal(sent.length, 1)   // 同一个问题只提醒一次
    // 文件开头有 BOM（记事本存的）：很多工具 JSON.parse 直接失败
    fs.writeFileSync(CRED_FILE, String.fromCharCode(0xfeff) + JSON.stringify({ sessdata: SESS, bili_jct: JCT, buvid3: SPI }))
    let s = await probeLogin({ fetch: fakeBili({}).fetch })
    assert.equal(s.state, 'invalid'); assert.match(s.why, /BOM/)
    let navs
    // buvid3 只是尾巴上多个空格：请求头里本来就会去掉，照常查，不提示
    ;({ s, navs } = await probe({ sessdata: SESS, bili_jct: JCT, buvid3: SPI + ' ' }))
    assert.equal(s.state, 'ok'); assert.equal(s.hint, undefined); assert.ok(navs[0].cookie.includes('buvid3=' + SPI))
    // 没有 buvid3：正常，不提示
    ;({ s, navs } = await probe({ sessdata: SESS, bili_jct: JCT, buvid3: '' }))
    assert.equal(s.state, 'ok'); assert.equal(s.hint, undefined)
    // buvid3 中间有空格：不算失效，不带它去查，提示一句
    ;({ s, navs } = await probe({ sessdata: SESS, bili_jct: JCT, buvid3: 'OLD BUVID3 with spaces' }))
    assert.equal(s.state, 'ok'); assert.match(s.hint, /buvid3/); assert.ok(navs[0].cookie.endsWith('buvid3='))
    assert.match(describeLogin(s).line, /^  ✓ .*buvid3/)
    assert.equal(sent.length, 1)   // buvid3 的问题不提醒
    // 只有 SESSDATA、没有 bili_jct：算没登录，不去问
    ;({ s, navs } = await probe({ sessdata: SESS }))
    assert.equal(s.state, 'missing'); assert.equal(navs.length, 0)
    // 体检那一行：✓ / ✗ / ⚠️ 开头，名字里的控制字符去掉
    assert.match(describeLogin({ state: 'invalid', why: 'x' }).line, /^  ✗ .*cookie --qr/)
    assert.match(describeLogin({ state: 'missing' }).line, /^  ✗ .*cookie --qr/)
    assert.match(describeLogin({ state: 'ok', problem: 'owner', mid: '222' }).line, /^  ✗ /)
    assert.match(describeLogin({ state: 'unknown', why: '这次没查到' }).line, /^  ⚠️ /)
    const okLine = describeLogin({ state: 'ok', mid: '333', name: 'a\\u001b[2Jb\\u202ec' }).line
    assert.match(okLine, /^  ✓ /); assert.ok(!/[\\u001b\\u202e]/.test(okLine))
  `)
})

test('daemon login check: logs state changes; alerts via B站 DM are only logged (her own account is the broken one); failed pushes are logged readably and retried; skipped during a ban', (t) => {
  script(sandbox(t), `
    const { runLoginCheck } = await import('file:///@ROOT@host/bililogin.mjs')
    putOld()
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' }, notify: { type: 'dm' } })
    const logs = [], calls = []
    const runBili = async (args) => { calls.push(args); return { ok: false, err: 'spawnSync notify-send ENOENT\\n  details  here' } }
    let s = await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(s.state, 'invalid'); assert.ok(s.notifiedAt); assert.equal(calls.length, 0)
    assert.ok(logs.some((l) => l.startsWith('⚠️ 登录提醒没推送（推送方式是 B站 私信')))
    assert.ok(logs.some((l) => l.startsWith('B站 登录状态：invalid')))
    // 推送失败：原因原样（空白合成一个空格）记进日志，下次再试
    writeConfig({ ...readConfig(), notify: { type: 'command', cmd: 'notify-send' } })
    fs.rmSync(LOGIN_STATE_FILE); logs.length = 0
    s = await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(calls.length, 1); assert.equal(s.notifiedAt, null)
    assert.ok(logs.includes('⚠️ 登录提醒没推送成（下次检查再试）：spawnSync notify-send ENOENT details here'), logs.join(' | '))
    s = await runLoginCheck({ log: (m) => logs.push(m), runBili: async (a) => { calls.push(a); return { ok: true, err: '' } }, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(calls.length, 2); assert.ok(s.notifiedAt)
    // 风控熔断中：不去碰 B站
    const b = fakeBili({})
    assert.equal(await runLoginCheck({ log: () => {}, runBili, fetch: b.fetch, banned: () => true }), null); assert.equal(b.calls.length, 0)
    // 状态没变：不重复记「登录状态」那一行
    logs.length = 0
    await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.ok(!logs.some((l) => l.startsWith('B站 登录状态')))
  `)
})

test('daemon login check: with B站 DM as the push and QQ as the fallback, the alert is still pushed (only DM-without-fallback is skipped)', (t) => {
  script(sandbox(t), `
    const { runLoginCheck } = await import('file:///@ROOT@host/bililogin.mjs')
    putOld()
    const logs = [], calls = []
    const runBili = async (args) => { calls.push(args); return { ok: true, err: '' } }
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' }, notify: { type: 'dm', fallback: 'qq' } })
    let s = await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(s.state, 'invalid'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 1), ['notify'])
    assert.ok(!logs.some((l) => l.startsWith('⚠️ 登录提醒没推送（推送方式是 B站 私信')))
    // 推送方式本身就是 QQ：照常推
    writeConfig({ ...readConfig(), notify: { type: 'qq' } }); fs.rmSync(LOGIN_STATE_FILE)
    s = await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(calls.length, 2)
    // 私信、备用也是私信 / 不推送：照旧只记日志
    for (const fallback of ['dm', 'none', '']) {
      writeConfig({ ...readConfig(), notify: { type: 'dm', fallback } }); fs.rmSync(LOGIN_STATE_FILE)
      await runLoginCheck({ log: (m) => logs.push(m), runBili, fetch: fakeBili({ navCode: -101 }).fetch })
      assert.equal(calls.length, 2, fallback)
    }
  `)
})

test('credential temp file is removed even when writing it fails half-way', (t) => {
  script(sandbox(t), `
    putOld()
    const ow = fs.writeFileSync
    fs.writeFileSync = (f, ...a) => { if (String(f).endsWith('.tmp')) { ow(f, 'partial'); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) } return ow(f, ...a) }
    try { assert.throws(() => saveCredentials({ sessdata: SESS, bili_jct: JCT, buvid3: '' })) } finally { fs.writeFileSync = ow }
    credIs(OLD); assert.deepEqual(tmpLeft(), [])
  `)
})

test('line reader: in a terminal, keys typed before the question are dropped; Ctrl+D means no answer; piped answers queue up', async () => {
  const { PassThrough } = await import('node:stream')
  const { lineReader } = await import(pathToFileURL(path.join(root, 'host', 'lineread.mjs')).href)
  let input = new PassThrough(), output = new PassThrough()
  output.resume()
  let lr = lineReader(null, { input, output, tty: true })
  const p = lr.ask('保存？[y/N] ')
  input.write('y\r')                                          // 问题还没出来时敲的回车 —— 不算回答
  await new Promise((r) => setTimeout(r, 150))
  input.write('n\r')
  assert.equal(await p, 'n')
  input.end()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(await lr.ask('再问一次？'), null)              // 输入结束（Ctrl+D）之后：不抛错，当没回答
  lr.close()
  input = new PassThrough(); output = new PassThrough(); output.resume()
  lr = lineReader(null, { input, output, tty: false })
  input.write('a\nb\n')
  assert.equal(await lr.ask('1 '), 'a'); assert.equal(await lr.ask('2 '), 'b')
  input.end()
  assert.equal(await lr.ask('3 '), null)
  lr.close()
})

test('round 3: numeric mids everywhere; switch detection falls back to the UID seen by the last login check; a config write failure after saving is a warning; a bad old buvid3 is replaced; old names with control characters are shown safely', (t) => {
  script(sandbox(t), `
    const ESC = String.fromCharCode(27), RLO = String.fromCharCode(0x202e)
    fs.writeFileSync(CFG_FILE, JSON.stringify({ owner: { mid: 222, name: 'Owner' }, self: { mid: 333, name: 'TestBot' } }))
    putOld()
    globalThis.fetch = fakeBili({ mid: '222' }).fetch
    let r = await writeCookie({ sessdata: SESS, bili_jct: JCT })
    assert.equal(r.ok, false); assert.match(r.error, /你（主人）自己的号/); credIs(OLD)
    let s = await probeLogin({ fetch: fakeBili({ mid: '222' }).fetch })
    assert.equal(s.problem, 'owner')
    s = await probeLogin({ fetch: fakeBili({ mid: '333' }).fetch })
    assert.equal(s.state, 'ok'); assert.equal(s.problem, undefined); assert.equal(s.mid, '333')
    // 配置里没记她的号、旧凭据里也没有 UID，但宿主上次检查看到的是 333：扫出 444 → 算换号
    fs.writeFileSync(CFG_FILE, JSON.stringify({ owner: { mid: '222' } }))
    putOld(JSON.stringify({ sessdata: 'OLD_SESSDATA_VALUE_0123456789', bili_jct: 'a'.repeat(32), buvid3: 'x' }))
    let x = io(['y'])
    r = await qrLogin(x, { fetch: fakeBili({ mid: '444' }).fetch })
    assert.equal(r.saved, false); assert.match(x.asked[0], /444/)
    globalThis.fetch = fakeBili({ mid: '444' }).fetch
    const seen = []
    r = await writeCookie({ sessdata: SESS, bili_jct: JCT }, { confirm: async (i) => { seen.push(i); return false } })
    assert.equal(seen[0].switched, true); assert.equal(seen[0].prev.mid, '333')
    // 旧 buvid3 是 'x'（格式不对）：重新要一个
    const b = fakeBili({ mid: '333' })
    r = await qrLogin(io(['y']), { fetch: b.fetch })
    assert.equal(r.saved, true); assert.ok(b.calls.some((k) => k.url.includes('/finger/spi'))); assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).buvid3, SPI)
    // 凭据存好了、改配置时出错：算存好了，给一句提醒（不是崩掉）
    putOld()
    const or = fs.renameSync
    fs.renameSync = (a, b2) => { if (String(b2) === CFG_FILE) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return or(a, b2) }
    try { r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '333' }).fetch }) } finally { fs.renameSync = or }
    assert.equal(r.saved, true); assert.match(r.warn, /她的号」没更新/)
    assert.equal(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).sessdata, SESS); assert.equal(readLoginState().state, 'ok')
    // 换号时之前的名字里有控制字符 / 改方向字符：提示里不带
    fs.writeFileSync(CFG_FILE, JSON.stringify({ owner: { mid: '222' }, self: { mid: '333', name: 'x' + ESC + '[2J' + RLO + 'y' } }))
    putOld(); x = io(['n']); await qrLogin(x, { fetch: fakeBili({ mid: '444' }).fetch })
    assert.ok(x.said.some((l) => l.includes('换号了')))
    assert.ok(x.said.every((l) => !l.includes(ESC) && !l.includes(RLO)))
    // config set：PowerShell 吃掉引号的 JSON 要说清楚、不写
    const { setConfigPath } = await import('file:///@ROOT@host/core.mjs')
    const before = fs.readFileSync(CFG_FILE, 'utf8')
    r = setConfigPath('preferences.like', '[猫]')
    assert.equal(r.ok, false); assert.match(r.error, /PowerShell/); assert.equal(fs.readFileSync(CFG_FILE, 'utf8'), before)
  `)
})

test('round 3: the daemon login check honours a ban by default, logs a push failure with no message, and is scheduled 20 s after start then hourly', (t) => {
  script(sandbox(t), `
    const { runLoginCheck, scheduleLoginChecks } = await import('file:///@ROOT@host/bililogin.mjs')
    putOld()
    const banFile = path.join(path.dirname(CRED_FILE), 'api-ban.json')
    fs.writeFileSync(banFile, JSON.stringify({ until: Date.now() + 600000, why: 'HTTP 412' }))
    const b = fakeBili({})
    assert.equal(await runLoginCheck({ log: () => {}, runBili: async () => ({ ok: true }), fetch: b.fetch }), null)
    assert.equal(b.calls.length, 0)
    fs.rmSync(banFile)
    writeConfig({ ...readConfig(), notify: { type: 'webhook', url: 'https://hook.example/x' } })
    const logs = []
    const s = await runLoginCheck({ log: (m) => logs.push(m), runBili: async () => ({ ok: false, err: '' }), fetch: fakeBili({ navCode: -101 }).fetch })
    assert.equal(s.notifiedAt, null); assert.ok(logs.some((l) => l.includes('推送命令失败（没有出错信息）')), logs.join(' | '))
    const calls = []
    scheduleLoginChecks(() => {}, { setTimeoutFn: (fn, ms) => calls.push(['once', ms]), setIntervalFn: (fn, ms) => calls.push(['every', ms]) })
    assert.deepEqual(calls, [['once', 20000], ['every', 3600000]])
  `)
})

test('line reader in a terminal: a half-typed answer and keys typed just before the question are dropped; Ctrl+C goes to onCancel; pasted lines are kept when asked to', async () => {
  const { PassThrough } = await import('node:stream')
  const { lineReader } = await import(pathToFileURL(path.join(root, 'host', 'lineread.mjs')).href)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let input = new PassThrough(), output = new PassThrough()
  output.resume()
  let cancelled = 0
  let lr = lineReader(() => { cancelled += 1 }, { input, output, tty: true })
  let p = lr.ask('Q1 ')
  input.write('y')                                   // 敲了一半、没回车
  await sleep(150)
  input.write('\r')
  assert.equal(await p, '')
  p = lr.ask('Q2 ')
  setTimeout(() => input.write('y\r'), 10)           // 问题显示出来之前 10 毫秒敲的
  await sleep(150)
  input.write('n\r')
  assert.equal(await p, 'n')
  p = lr.ask('Q3 ')
  await sleep(100)
  input.write(String.fromCharCode(3))                // Ctrl+C
  await sleep(50)
  assert.equal(cancelled, 1)
  input.write('z\r')
  assert.equal(await p, 'z')
  lr.close()
  input = new PassThrough(); output = new PassThrough(); output.resume()
  lr = lineReader(null, { input, output, tty: true })
  p = lr.ask('A ', { fresh: false })
  input.write('one\rtwo\r')                          // 一次粘贴两行
  assert.equal(await p, 'one')
  assert.equal(await lr.ask('B ', { fresh: false }), 'two')
  lr.close()
})

// ─────────────── 命令行（真的跑 host/cli.mjs；B站 换成假的） ───────────────
function cliEnv(t, cfg = { owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'TestBot' } }) {
  const env = sandbox(t)
  fs.mkdirSync(env.DSH_HOME, { recursive: true }); fs.writeFileSync(path.join(env.DSH_HOME, 'bili-whale.config.json'), JSON.stringify(cfg))
  const cred = path.join(env.USERPROFILE, '.bili-ai', 'credentials.json')
  const old = JSON.stringify({ sessdata: 'OLD_SESSDATA_VALUE_0123456789', bili_jct: 'a'.repeat(32), buvid3: '' })
  fs.writeFileSync(cred, old)
  const run = (args, input, spec = {}, extra = {}) => spawnSync(process.execPath, [path.join(root, 'host', 'cli.mjs'), ...args], {
    env: { ...env, TEST_PASSPORT: JSON.stringify(spec), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/passport-global.mjs')).href, ...extra },
    input, encoding: 'utf8', timeout: 60_000,
  })
  return { env, cred, old, run }
}

test('cli manual cookie: shows who it is before asking, refuses what B站 does not recognise, a new account needs the UID typed, closed input saves nothing', (t) => {
  const { cred, old, run } = cliEnv(t)
  const args = ['cookie', '--sessdata', 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1', '--bili_jct', 'f'.repeat(32)]
  let r = run(args, 'y\n', { navCode: -101 })
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /不认/); assert.equal(fs.readFileSync(cred, 'utf8'), old)
  r = run(args, 'y\n', { mid: '444', name: 'Other' })
  assert.equal(r.status, 1); assert.match(r.stdout, /这组 cookie 登录的是：Other（UID 444）/); assert.match(r.stdout, /换号了/); assert.equal(fs.readFileSync(cred, 'utf8'), old)
  r = run(args, '', { mid: '444', name: 'Other' })
  assert.equal(r.status, 1); assert.equal(fs.readFileSync(cred, 'utf8'), old)
  r = run(args, '444\n', { mid: '444', name: 'Other' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /已写入/); assert.equal(JSON.parse(fs.readFileSync(cred, 'utf8')).dedeuserid, '444')
  // 同一个号：先看到是谁，回 y 才写；n / 直接回车 / 输入结束 都不写
  const now = fs.readFileSync(cred, 'utf8')
  for (const input of ['n\n', '\n', '']) {
    r = run(args, input, { mid: '444', name: 'Other' })
    assert.equal(r.status, 1, JSON.stringify(input)); assert.match(r.stdout, /这组 cookie 登录的是：Other（UID 444）/); assert.match(r.stdout, /没确认/)
    assert.equal(fs.readFileSync(cred, 'utf8'), now)
  }
  assert.ok(!(r.stdout + r.stderr).includes('fakeSESSDATA0123456789'))
  // 名字里的控制字符 / 改方向字符：不进终端
  r = run(args, 'n\n', { mid: '444', name: 'a\u001b[2Jb\u202ec' })
  assert.ok(!/[\u001b\u202e]/.test(r.stdout))
})

test('cli manual cookie: warns when your own UID is not configured; a renamed old account with control characters is shown safely; --no-verify stores and marks the login unchecked', (t) => {
  let { env, cred, run } = cliEnv(t, { self: { mid: '333', name: 'x\u001b]0;evil\u0007y' } })
  const args = ['cookie', '--sessdata', 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1', '--bili_jct', 'f'.repeat(32)]
  let r = run(args, 'n\n', { mid: '444', name: 'Other' })
  assert.equal(r.status, 1); assert.match(r.stdout, /还没填主人/); assert.match(r.stdout, /换号了/); assert.ok(!/[\u001b\u0007]/.test(r.stdout))
  r = run([...args, '--no-verify'], '', { navCode: 'throw' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /没问 B站/)
  assert.equal(JSON.parse(fs.readFileSync(cred, 'utf8')).sessdata, 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1')
  const st = JSON.parse(fs.readFileSync(path.join(env.DSH_HOME, 'whale-cc', 'login-state.json'), 'utf8'))
  assert.equal(st.state, 'unknown'); assert.match(st.why, /没核对/)
})

test('cli cookie --qr: cannot draw the QR → stops before polling, old login untouched', (t) => {
  const { cred, old, run } = cliEnv(t)
  const r = run(['cookie', '--qr'], 'y\n', {}, { BILI_WHALE_QR_PYTHON: path.join(os.tmpdir(), 'no-such-python-' + process.pid + '.exe') })
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /画不出二维码/); assert.doesNotMatch(r.stdout, /已扫码/)
  assert.equal(fs.readFileSync(cred, 'utf8'), old)
})

const VENV_PY = path.join(root, '.studio-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
test('cli cookie --qr end to end: draws the QR in the terminal, asks, saves; answering no keeps the old login', { skip: !fs.existsSync(VENV_PY) && '没装工作室依赖（画二维码要 .studio-venv 里的 qrcode）', timeout: 120_000 }, (t) => {
  const { env, cred, old, run } = cliEnv(t)
  const qr = (input, spec = {}, extra) => run(['cookie', '--qr', ...(extra ?? [])], input, { polls: ['scanned', 'success'], ...spec })
  let r = qr('n\n')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.match(r.stdout, /▀/); assert.match(r.stdout, /TestBot（UID 333）/); assert.match(r.stdout, /没保存/)
  assert.match(r.stdout, /Claude Code 的登录/)
  assert.equal(fs.readFileSync(cred, 'utf8'), old)
  r = qr('y\n')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /已保存/); assert.match(r.stdout, /自动续期还没做/)
  const c = JSON.parse(fs.readFileSync(cred, 'utf8'))
  assert.equal(c.via, 'qr'); assert.equal(c.dedeuserid, '333')
  for (const s of [c.sessdata, c.bili_jct, c.refresh_token, 'KEY1', 'qrcode_key']) assert.ok(!(r.stdout + r.stderr).includes(s), s)
  fs.writeFileSync(cred, old)
  r = qr('y\n', { mid: '222', name: 'Owner' })
  assert.equal(r.status, 1); assert.match(r.stdout, /自己的号/); assert.equal(fs.readFileSync(cred, 'utf8'), old)
  // 两个问题的回答一次喂进去（过期 → 再来一张 → 保存）：第二个回答排着队，不会丢
  r = qr('\ny\n', { polls: ['expired', 'success'] })
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /已保存/)
  // 只回答了第一个问题、输入就结束了：第二个问题当没回答（不保存）
  fs.writeFileSync(cred, old)
  r = qr('\n', { polls: ['expired', 'success'] })
  assert.equal(r.status, 1, r.stderr + r.stdout); assert.match(r.stdout, /没确认/); assert.equal(fs.readFileSync(cred, 'utf8'), old)
  // --png：图片版放在 ~/.bili-ai，结束就删
  fs.rmSync(path.join(env.USERPROFILE, '.bili-ai'), { recursive: true, force: true })   // 全新安装：目录都还没有
  r = qr('n\n', {}, ['--png'])
  assert.equal(r.status, 1, r.stderr + r.stdout); assert.match(r.stdout, /图片版/)
  assert.ok(!fs.existsSync(path.join(env.USERPROFILE, '.bili-ai', 'login-qr.png')))
})

test('cli round 3: manual cookie typed in (piped) works end to end; a confirmed save with a control-character nickname prints cleanly', (t) => {
  const { cred, run } = cliEnv(t)
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
  let r = run(['cookie'], 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1\n' + 'f'.repeat(32) + '\n\ny\n', { mid: '333' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /已写入/)
  assert.equal(JSON.parse(fs.readFileSync(cred, 'utf8')).bili_jct, 'f'.repeat(32))
  r = run(['cookie', '--sessdata', 'fakeSESSDATA0123456789%2C1999999999%2Cabcd*b1', '--bili_jct', 'f'.repeat(32)], 'y\n', { mid: '333', name: 'a' + ESC + ']0;x' + BEL + 'b' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /已写入/)
  assert.ok(!r.stdout.includes(ESC) && !r.stdout.includes(BEL))
})

test('cli doctor checks the B站 login on the spot and prints one clean ✓ / ✗ line', { timeout: 180_000 }, (t) => {
  const { env, run } = cliEnv(t)
  const ESC = String.fromCharCode(27)
  const r = run(['doctor'], '', { mid: '333', name: 'ab' + ESC + '[2J' })
  assert.match(r.stdout, /✓ 她的 B站 登录有效：ab\[2J（UID 333）/)
  assert.ok(!r.stdout.includes(ESC))
  const st = JSON.parse(fs.readFileSync(path.join(env.DSH_HOME, 'whale-cc', 'login-state.json'), 'utf8'))
  assert.equal(st.state, 'ok'); assert.equal(st.mid, '333')
})

test('daemon runs the B站 login check soon after it starts (login-state.json appears)', { timeout: 60_000 }, async (t) => {
  const { env } = cliEnv(t, { owner: { mid: '222' }, self: { mid: '333' }, listen: { comment: false, dm: false, live: false } })
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [path.join(root, 'host', 'daemon.mjs')], {
    env: { ...env, TEST_PASSPORT: JSON.stringify({ navCode: -101 }), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/passport-global.mjs')).href, BILI_WHALE_LOGIN_CHECK_FIRST_MS: '300' },
    stdio: 'ignore', windowsHide: true,
  })
  t.after(() => { try { child.kill() } catch {} })
  const f = path.join(env.DSH_HOME, 'whale-cc', 'login-state.json')
  for (let i = 0; i < 150 && !fs.existsSync(f); i += 1) await new Promise((r) => setTimeout(r, 200))
  child.kill()
  assert.ok(fs.existsSync(f), 'login-state.json 没出现：宿主没排登录检查')
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).state, 'invalid')
})

test('daemon started from a shell with no node on PATH and no DSH_NODE still starts the scheduler (uses the node it runs on)', { timeout: 60_000 }, async (t) => {
  const { env } = cliEnv(t, { owner: { mid: '222' }, self: { mid: '333' }, listen: { comment: false, dm: false, live: false } })
  // 环境变量名不分大小写；ProgramFiles 单删不掉（新进程里系统按 ProgramW6432 补回来），连 ProgramW6432 一起删 ——
  // 以前只删 ProgramFiles：装了官方 Node 的机器上宿主找到的是 C:\Program Files\nodejs\node.exe，根本没走到「用它自己跑的那个 node」
  for (const k of Object.keys(env)) if (/^(path|programfiles|programw6432|dsh_node|dsh_desktop_node_executable)$/i.test(k)) delete env[k]
  env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [path.join(root, 'host', 'daemon.mjs')], { env, stdio: 'ignore', windowsHide: true })
  t.after(() => { try { child.kill() } catch {} })
  const f = path.join(env.DSH_HOME, 'whale-cc', 'daemon.json')
  for (let i = 0; i < 150 && !fs.existsSync(f); i += 1) await new Promise((r) => setTimeout(r, 200))
  child.kill()
  assert.ok(fs.existsSync(f), 'daemon.json 没出现：宿主没起来')
  const st = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(st.scheduler?.ok, true, '生物钟没起来：' + st.scheduler?.reason)
  assert.equal(st.node, process.execPath, '宿主用的应该是它自己跑在上面的那个 node（不是别处找到的）')
})

test('cli doctor marks a running host whose scheduler failed with ✗, not ✓', { timeout: 180_000 }, (t) => {
  const { env, run } = cliEnv(t)
  const state = (scheduler) => fs.writeFileSync(path.join(env.DSH_HOME, 'whale-cc', 'daemon.json'),
    JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString(), scheduler }))
  fs.mkdirSync(path.join(env.DSH_HOME, 'whale-cc'), { recursive: true })
  state({ ok: false, reason: '找不到 node' })
  let r = run(['doctor'], '', { mid: '333', name: 'ab' })
  assert.match(r.stdout, /✗ 宿主在跑（pid \d+），但生物钟没起来.*找不到 node/)
  assert.doesNotMatch(r.stdout, /✓ 宿主在跑/)
  state({ ok: true, reason: '已启动（每 60 秒 tick）' })
  r = run(['doctor'], '', { mid: '333', name: 'ab' })
  assert.match(r.stdout, /✓ 宿主在跑（pid \d+）· 生物钟：已启动/)
})

// 挂住的 nav：旧凭据的检查已经发出去了，B站 迟迟不回；release(答案) 才回
const HELD = `
const held = () => {
  let release
  const gate = new Promise((r) => { release = r })
  const b = fakeBili({ navCode: () => gate })
  return { b, release: (v) => release(v), asked: () => b.calls.some((k) => k.url.includes('/nav')) }
}
const stateText = () => fs.readFileSync(LOGIN_STATE_FILE, 'utf8')
`

test('login check race: a check still waiting on B站 when you log in again is dropped — no "invalid" over the new login, no alert; same when it says ok for the account you just switched away from', (t) => {
  script(sandbox(t), HELD + `
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    const sent = [], notify = async (m) => { sent.push(m) }
    // 1) 你重新扫了码（同一个号）；旧凭据的检查这才回来说 -101
    putOld()
    let h = held(), p = probeLogin({ fetch: h.b.fetch, notify })
    assert.ok(h.asked())
    let r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '333' }).fetch })
    assert.equal(r.saved, true); assert.equal(readLoginState().state, 'ok')
    let after = stateText()
    h.release(-101)
    let s = await p
    assert.equal(s.stale, true); assert.equal(s.changed, false); assert.equal(s.alert, null)
    assert.equal(stateText(), after); assert.equal(sent.length, 0)
    assert.notEqual(describeLogin(s).level, 'bad')   // 体检那一行也不说「失效了」
    // 下一次检查查的是新凭据：照常
    s = await probeLogin({ fetch: fakeBili({ mid: '333' }).fetch, notify })
    assert.equal(s.state, 'ok'); assert.equal(s.stale, undefined); assert.equal(sent.length, 0)
    // 2) 旧检查回来说「有效、是 333」，可这期间你已经换成了 444：不把 333 写回去，也不报「号不一样」
    putOld()
    h = held(); p = probeLogin({ fetch: h.b.fetch, notify })
    r = await qrLogin(io(['444']), { fetch: fakeBili({ mid: '444', name: 'Other' }).fetch })
    assert.equal(r.saved, true); assert.equal(r.switched, true)
    after = stateText()
    h.release({ mid: '333', name: 'TestBot' })
    s = await p
    assert.equal(s.stale, true); assert.equal(stateText(), after); assert.equal(readLoginState().mid, '444'); assert.equal(sent.length, 0)
    // 3) 手动填的（--no-verify）也一样：状态还是「没核对」，不被旧检查改成失效
    putOld()
    h = held(); p = probeLogin({ fetch: h.b.fetch, notify })
    r = await writeCookie({ sessdata: SESS, bili_jct: JCT }, { verify: false })
    assert.equal(r.ok, true); after = stateText()
    h.release(-101)
    s = await p
    assert.equal(s.stale, true); assert.equal(stateText(), after); assert.match(readLoginState().why, /没核对/); assert.equal(sent.length, 0)
  `)
})

test('login check race: a new login landing while the alert is being pushed is not overwritten; a check that started on the just-saved account compares against the config as it is when B站 answers; the daemon logs a dropped check and pushes nothing', (t) => {
  script(sandbox(t), HELD + `
    const { markLoginOk } = await import('file:///@ROOT@host/core.mjs')
    const { runLoginCheck } = await import('file:///@ROOT@host/bililogin.mjs')
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' } })
    // 1) 旧凭据真的失效了、提醒正推送着，你这时重新登录了：提醒收不回来，但状态不写回「失效」
    putOld()
    const sent = []
    let s = await probeLogin({ fetch: fakeBili({ navCode: -101 }).fetch, notify: async (m) => {
      sent.push(m)
      saveCredentials({ sessdata: SESS, bili_jct: JCT, buvid3: SPI, dedeuserid: '333', via: 'qr' }); markLoginOk({ mid: '333', name: 'TestBot' })
    } })
    assert.equal(sent.length, 1); assert.equal(s.stale, true); assert.equal(readLoginState().state, 'ok')
    // 2) 检查开始时新凭据（444）刚存下、配置里她的号还没改过来（换号时先存凭据、再改配置）：B站 回话时拿那会儿的配置比，不误报「号不一样」
    putOld(JSON.stringify({ sessdata: SESS, bili_jct: JCT, buvid3: SPI, dedeuserid: '444' }))
    let h = held(), p = probeLogin({ fetch: h.b.fetch, notify: async (m) => { sent.push(m) } })
    writeConfig({ ...readConfig(), self: { mid: '444', name: 'Other' } }); markLoginOk({ mid: '444', name: 'Other' })
    h.release({ mid: '444', name: 'Other' })
    s = await p
    assert.equal(s.stale, undefined); assert.equal(s.state, 'ok'); assert.equal(s.problem, undefined); assert.equal(sent.length, 1)
    assert.equal(readLoginState().mid, '444'); assert.equal(readLoginState().problem, undefined)
    // 3) 宿主每小时那次：作废了记一行日志，不推送、不记「登录状态变了」
    writeConfig({ ...readConfig(), self: { mid: '333', name: 'TestBot' }, notify: { type: 'command', cmd: 'notify-send' } })
    putOld(); fs.rmSync(LOGIN_STATE_FILE, { force: true })
    const logs = [], pushes = []
    h = held()
    p = runLoginCheck({ log: (m) => logs.push(m), runBili: async (a) => { pushes.push(a); return { ok: true, err: '' } }, fetch: h.b.fetch, banned: () => false })
    assert.ok(h.asked())
    const r = await qrLogin(io(['y']), { fetch: fakeBili({ mid: '333' }).fetch })
    assert.equal(r.saved, true)
    h.release(-101)
    s = await p
    assert.equal(s.stale, true); assert.equal(pushes.length, 0); assert.equal(readLoginState().state, 'ok')
    assert.ok(logs.some((l) => l.includes('凭据换了')), logs.join(' | ')); assert.ok(!logs.some((l) => l.startsWith('B站 登录状态')), logs.join(' | '))
  `)
})
