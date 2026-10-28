// B站 扫码登录 + 登录状态检查（宿主专用 —— 她的会话读写不了 ~/.bili-ai 和宿主目录，也没有调这里的命令）
//   node host/cli.mjs cookie --qr [--png]
//
// 和 Claude Code 的登录（node host/cli.mjs login）是两回事：这里登录的是她那个 B站 号。
//
// 规矩：
//   · 二维码过期 / 你取消 / 出错 / 扫出来是你自己的号 / 你没确认 → 原来的凭据一个字都不动（只有最后一步才写）
//   · 先用新 cookie 问 B站「这是谁」（只读的 nav），把昵称 + UID 给你看，你确认了才写；换了号要你把新 UID 打一遍
//   · 凭据原子写入（临时文件 + 改名，见 core.saveCredentials）
//   · cookie、refresh_token、二维码里的登录链接都不打印、不写日志、不进面板；出错信息里的链接 / key 先抹掉
//   · refresh_token 存下了，但自动续期还没接上：失效了靠宿主每小时的检查（probeLogin）+ 面板 / 通知提醒你再扫一次
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CRED_FILE, VENV_DIR, COOKIE_SAFE, readConfig, readConfigStrict, setSelf, saveCredentials, readSavedCred, whoIs, whoIsWhyNot,
  readLoginState, writeLoginState, markLoginOk,
} from './core.mjs'
import { apiState } from '../tools/lib/bili-api.mjs'

const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web/qrcode'
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', referer: 'https://www.bilibili.com/' }
export const QR_TTL_MS = 180_000                       // B站 的二维码 3 分钟有效
export const POLL_GIVE_UP_MS = 60_000                  // 连着这么久一次都没查成（网络断了 / B站 一直出错）就不等了
export const QR_PNG_FILE = path.join(path.dirname(CRED_FILE), 'login-qr.png')   // --png 时的图片版：放在只有你能读的 ~/.bili-ai，扫完就删
const POLL_STATE = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired', 0: 'success' }
const WANT = new Set(['SESSDATA', 'bili_jct', 'DedeUserID'])
const getFetch = (f) => f ?? globalThis.fetch
// 存着的值和工具读的时候一样先收拾一下（tools/lib/cred.mjs 的 loadCred：去掉首尾空白和引号）—— 老版本 / 手写的凭据文件里常有
const normCred = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')
const BOM = String.fromCharCode(0xfeff)
// 出错信息里万一带了链接（里面有登录用的 key）或 cookie：先抹掉
// 推送地址里的 key（access_token= / sendkey= 这类，地址可能没写 https://）也抹（2026-10-24 审查）
const scrub = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, '<链接>').replace(/(qrcode_key|SESSDATA|bili_jct|refresh_token|DedeUserID\w*|access_token|token|sendkey|secret|key)=[^&;\s]+/gi, '$1=***').slice(0, 160)

/** 要一张登录二维码：→ { ok, url（二维码里的内容）, key } */
export async function qrGenerate({ fetch: f } = {}) {
  try {
    const r = await getFetch(f)(`${PASSPORT}/generate?source=main-fe-header&go_url=https%3A%2F%2Fwww.bilibili.com%2F&web_location=333.1007`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) })
    const j = await r.json().catch(() => ({}))
    const url = String(j?.data?.url ?? ''), key = String(j?.data?.qrcode_key ?? '')
    if (j?.code !== 0 || !/^https:\/\/([\w-]+\.)*bilibili\.com\/\S*$/.test(url) || !/^[\w-]{8,64}$/.test(key)) {
      return { ok: false, error: `B站 没给出二维码（code=${scrub(j?.code ?? '?')}${j?.message ? ' ' + scrub(j.message) : ''}）` }
    }
    return { ok: true, url, key }
  } catch (e) { return { ok: false, error: '连不上 B站：' + scrub(e?.message ?? e) } }
}

/** 从登录成功的回包里取 cookie：Set-Cookie 头优先，回包 data.url 的参数兜底（原样取，不解码 —— 和浏览器里存的一样） */
export function cookiesFrom(res, dataUrl) {
  const out = {}
  const h = res?.headers
  const lines = typeof h?.getSetCookie === 'function' ? h.getSetCookie() : String(h?.get?.('set-cookie') ?? '').split(/,(?=\s*[\w-]+=)/)
  for (const l of lines) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(l)
    if (m && WANT.has(m[1]) && m[2].trim() && !out[m[1]]) out[m[1]] = m[2].trim()
  }
  const q = String(dataUrl ?? '').split('#')[0].split('?')[1] ?? ''
  for (const kv of q.split('&')) {
    const i = kv.indexOf('=')
    if (i > 0 && WANT.has(kv.slice(0, i)) && !out[kv.slice(0, i)] && kv.slice(i + 1)) out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

/** 查一次扫码进度：→ { state: waiting | scanned | expired | success | error, cookies?, refreshToken?, error? } */
export async function qrPoll(key, { fetch: f } = {}) {
  let r, j
  try {
    r = await getFetch(f)(`${PASSPORT}/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`, { headers: HEADERS, signal: AbortSignal.timeout(15_000) })
    j = await r.json()
  } catch (e) { return { state: 'error', error: '连不上 B站：' + scrub(e?.message ?? e) } }
  if (j?.code !== 0) return { state: 'error', error: `code=${scrub(j?.code ?? '?')} ${scrub(j?.message)}` }
  const state = POLL_STATE[j?.data?.code]
  if (!state) return { state: 'error', fatal: true, error: `没见过的扫码状态 ${scrub(j?.data?.code)} ${scrub(j?.data?.message)}（B站 的扫码接口可能改了）` }
  if (state !== 'success') return { state }
  return { state, cookies: cookiesFrom(r, j.data.url), refreshToken: String(j.data.refresh_token ?? '') }
}

/** 设备号 buvid3（不绑账号；有些接口要）。拿不到就空着 —— 手动填那条路也允许空 */
export async function fetchBuvid3({ fetch: f } = {}) {
  try {
    const r = await getFetch(f)('https://api.bilibili.com/x/frontend/finger/spi', { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
    const v = String((await r.json())?.data?.b_3 ?? '')
    return /^[0-9A-Za-z-]{20,64}$/.test(v) ? v : ''
  } catch { return '' }
}

// ─────────────── 画二维码 ───────────────
// 用工作室的 Python（.studio-venv 里装了 qrcode）算出黑白格；登录链接从 stdin 传进去，不放命令行参数（别的进程能看到命令行）
const PY = `import sys, qrcode
q = qrcode.QRCode(border=3, error_correction=qrcode.constants.ERROR_CORRECT_M)
q.add_data(sys.stdin.read().strip()); q.make(fit=True)
print("\\n".join("".join("1" if c else "0" for c in row) for row in q.get_matrix()), flush=True)
if len(sys.argv) > 1:
    try: q.make_image(fill_color="black", back_color="white").save(sys.argv[1])
    except Exception as e: print("png failed: " + type(e).__name__, file=sys.stderr)
`
function pythons() {
  if (process.env.BILI_WHALE_QR_PYTHON) return [process.env.BILI_WHALE_QR_PYTHON]   // 指定用哪个 Python（装了 qrcode 的）
  const venv = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return fs.existsSync(venv) ? [venv] : [process.platform === 'win32' ? 'python' : 'python3']
}
/** 二维码的黑白格（true = 黑），算不出来 = null。png：顺便存一张图片版 */
export function qrMatrix(text, { png = null, python = null } = {}) {
  for (const py of python ? [python] : pythons()) {
    const r = spawnSync(py, ['-I', '-c', PY, ...(png ? [png] : [])], { input: String(text), encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const rows = String(r.stdout ?? '').split(/\r?\n/).filter((l) => /^[01]+$/.test(l))
    if (r.status === 0 && rows.length >= 21 && rows.every((l) => l.length === rows.length)) return rows.map((l) => [...l].map((c) => c === '1'))
  }
  return null
}
/** 终端里画出来：一个字符 = 上下两格（▀ 的前景色 = 上格，背景色 = 下格），颜色写死黑白，深色 / 浅色终端都扫得出 */
export function qrText(m) {
  const lines = []
  for (let y = 0; y < m.length; y += 2) {
    let s = ''
    for (let x = 0; x < m.length; x += 1) s += `\x1b[${m[y][x] ? 30 : 97};${m[y + 1]?.[x] ? 40 : 107}m▀`
    lines.push(s + '\x1b[0m')
  }
  return lines.join('\n')
}

// ─────────────── 扫码登录一次 ───────────────
const fail = (reason) => ({ ok: false, saved: false, reason })
const shownName = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 40)

/**
 * io：{ show(url) → 画出来了没有（true/false）, say(line), ask(question) → 一行输入（EOF = null）, sleep(ms)?, now()? }
 * → { ok, saved, reason?, self?, switched? } —— 只有 saved=true 时动过凭据和配置里的 self
 */
export async function qrLogin(io, { fetch: f, pollMs = 2000, rounds = 3 } = {}) {
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = io.now ?? Date.now
  let got = null
  for (let round = 1; round <= rounds && !got; round += 1) {
    const g = await qrGenerate({ fetch: f })
    if (!g.ok) return fail(g.error)
    if (!(await io.show(g.url))) return fail('二维码画不出来')
    io.say(`↑ 用【她那个号】的 B站 App 扫一扫（App 首页左上角 / 我的 → 扫一扫），二维码 ${QR_TTL_MS / 60_000} 分钟内有效。按 Ctrl+C 取消。`)
    const deadline = now() + QR_TTL_MS + 15_000
    let scanned = false, expired = false, lastGood = now()
    while (!got && !expired) {
      await sleep(pollMs)
      const p = await qrPoll(g.key, { fetch: f })
      if (p.state === 'error') {
        // 网络抖一下不放弃（按时间算，不按次数）；接口回了没见过的状态就别等了
        if (p.fatal) return fail('查扫码结果出错：' + p.error)
        if (now() - lastGood >= POLL_GIVE_UP_MS) return fail(`一直查不到扫码结果（${POLL_GIVE_UP_MS / 1000} 秒都没查成）：` + p.error)
      } else {
        lastGood = now()
        if (p.state === 'scanned' && !scanned) { scanned = true; io.say('已扫码 —— 在手机上点「确认登录」') }
        if (p.state === 'success') got = p
        if (p.state === 'expired') expired = true
      }
      if (!got && now() > deadline) expired = true   // B站 一直不说过期（或一直出错）也别死等
    }
    if (expired) {
      if (round === rounds) return fail(`二维码过期了（已经换了 ${rounds} 张）`)
      const a = await io.ask('二维码过期了。再来一张？[Y/n] ')
      if (a == null || /^\s*n/i.test(a)) return fail('取消了')
    }
  }
  if (!got) return fail('二维码过期了')
  io.say('手机上确认了，正在核对是哪个号…')
  return finishLogin(got, io, { fetch: f, now })
}

async function finishLogin(got, io, { fetch: f, now }) {
  const c = got.cookies ?? {}
  const sessdata = c.SESSDATA ?? '', bili_jct = c.bili_jct ?? ''
  if (sessdata.length < 20 || !/^[0-9a-fA-F]{32}$/.test(bili_jct)) return fail('B站 说登录成功了，但回包里没拿到完整的 cookie（SESSDATA / bili_jct）—— 没保存')
  // 配置读不出来：核对不了「是不是你自己的号」，回写还会把整份配置冲成默认值 —— 不往下走
  const conf = readConfigStrict()
  if (!conf.ok) return fail(conf.error + '\n  配置读不出来就没法核对这是不是你自己的号 —— 没保存，原来的凭据没动')
  const old = readSavedCred()
  // 设备号不绑账号，旧的能用就接着用；旧的格式坏了（比如手抄时带进了空格）就重新要一个
  const oldB3 = normCred(old?.buvid3)
  const buvid3 = (/^[0-9A-Za-z-]{20,64}$/.test(oldB3) && oldB3) || await fetchBuvid3({ fetch: f })
  const who = await whoIs({ sessdata, bili_jct, buvid3 }, { fetch: f })
  if (!who.ok) return fail(`用新 cookie 问 B站「这是谁」没问出来（${whoIsWhyNot(who)}）—— 没保存，原来的凭据没动`)
  if (c.DedeUserID && c.DedeUserID !== who.mid) return fail('回包里的 UID 和 B站 说的对不上 —— 没保存，原来的凭据没动')
  const name = shownName(who.name)
  io.say(`扫码登录的是：${name}（UID ${who.mid}）`)
  const cfg = conf.cfg
  if (cfg.owner?.mid && String(cfg.owner.mid) === who.mid) {
    return fail('这是你（主人）自己的号 —— 她得用她自己的号。没保存，原来的凭据没动（这次登录在 B站「登录设备管理」里能看到，可以顺手移除）')
  }
  if (!cfg.owner?.mid) io.say('⚠️ 还没填主人（你）的 UID，没法替你核对这是不是你自己的号 —— 确认扫的是她的号再保存（填：node host/cli.mjs config set owner.mid 你的UID）')
  // 以前她是哪个号：配置里记的 → 旧凭据里的 UID → 宿主上次检查登录时看到的 UID
  const prevMid = String(cfg.self?.mid || old?.dedeuserid || readLoginState()?.mid || '')
  const switched = Boolean(prevMid && prevMid !== who.mid)
  let yes
  if (switched) {
    const prevName = String(cfg.self?.mid) === prevMid ? shownName(cfg.self?.name) || '?' : '?'
    io.say(`⚠️ 换号了：之前她用的是 ${prevName}（UID ${prevMid}），这次扫的是 ${name}（UID ${who.mid}）。`)
    io.say('   换了之后她就用这个号看视频、回评论、私信你、投稿；以前的日记、观众记忆、额度账本都留着，记的是旧号时候的事。')
    const a = await io.ask(`确认换成这个号，就把新 UID 打一遍（${who.mid}）；别的输入都算不换：`)
    yes = a != null && a.trim() === who.mid
  } else {
    const a = await io.ask(`保存成她的 B站 登录？[y/N] `)
    yes = a != null && /^\s*y(es)?\s*$/i.test(a)
  }
  if (!yes) return fail('你没确认 —— 没保存，原来的凭据没动')
  const at = new Date(now()).toISOString()
  try {
    saveCredentials({ sessdata, bili_jct, buvid3, dedeuserid: who.mid, ...(got.refreshToken ? { refresh_token: got.refreshToken } : {}), via: 'qr', savedAt: at })
  } catch (e) { return fail('写凭据失败：' + scrub(e?.message ?? e) + ' —— 原来的凭据没动') }
  const self = { mid: who.mid, name: who.name }
  let warn = null
  try { setSelf(self) } catch (e) { warn = '凭据存好了，但配置里「她的号」没更新：' + scrub(e?.message ?? e) }
  markLoginOk(self, at)
  return { ok: true, saved: true, self: { mid: who.mid, name }, switched, buvid3: Boolean(buvid3), refreshToken: Boolean(got.refreshToken), warn }
}

// ─────────────── 宿主每小时查一次：登录还有效吗 ───────────────
/**
 * 用存着的凭据问一次 nav（只读），结果写进 login-state.json（面板 / 体检看），失效 / 号不对时提醒你一次。
 * 网络不通、B站 出错：记「这次没查到」，不算失效、不提醒。
 * 查到一半凭据换了（你重新扫码 / 填了新的 / 换了号）：这次问的是旧凭据，结果作废 —— 不写状态、不提醒（stale: true）。
 * → 新的状态 + changed（和上次比状态变了没有）
 */
export async function probeLogin({ fetch: f, now = Date.now, notify = null } = {}) {
  const prev = readLoginState() ?? {}
  const at = new Date(now()).toISOString()
  // 这次查的是哪一份凭据：原文读一次，判断、请求都用它；提醒和写状态之前再读一遍对一下
  const snap = readCredFile()
  const cred = parseCred(snap.text)
  let next, hint = null
  // 多数工具是原样读凭据文件、原样把值放进请求头的：文件开头有 BOM（记事本存的）、SESSDATA / bili_jct 带了首尾空白 / 引号 / 换行，
  // 那些工具会读不了或发不出去 —— 这时就算问 nav 能问出来也不算「好的」，要重新登录（扫码 / 重填都会存成干净的值）
  const dirty = !cred ? null
    : snap.text.startsWith(BOM) ? '凭据文件开头有 BOM（记事本存的），很多工具读不了'
      : ['sessdata', 'bili_jct'].some((k) => typeof cred[k] === 'string' && cred[k] && (normCred(cred[k]) !== cred[k] || !COOKIE_SAFE.test(cred[k]))) ? '凭据里的 SESSDATA / bili_jct 带了空格、引号、换行这类字符（手改或旧版本留下的），很多工具会原样发出去'
        : null
  if (!normCred(cred?.sessdata) || !normCred(cred?.bili_jct)) next = { state: 'missing', why: '还没存她那个号的登录' }
  else if (dirty) next = { state: 'invalid', code: null, why: dirty }
  else {
    // buvid3 是设备号、不绑账号：它的格式坏了不等于登录失效 —— 不带它去问；SESSDATA / bili_jct 坏了才算（工具发请求时会真的出错）
    const b3 = normCred(cred.buvid3)
    const b3Bad = Boolean(b3) && !COOKIE_SAFE.test(b3)
    const who = await whoIs({ sessdata: normCred(cred.sessdata), bili_jct: normCred(cred.bili_jct), buvid3: b3Bad ? '' : b3 }, { fetch: f })
    if (b3Bad) hint = '存着的 buvid3（设备号）格式坏了：大部分功能不受影响，重新扫码会换一个好的'
    if (who.ok) {
      // 配置等 B站 回了话再读：换号时是先存凭据、再改配置里她的号，检查开始那会儿读到的可能还是换之前的
      const cfg = readConfig()
      next = { state: 'ok', mid: who.mid, name: who.name, lastOkAt: at }
      if (cfg.owner?.mid && String(cfg.owner.mid) === who.mid) next.problem = 'owner'
      else if (cfg.self?.mid && String(cfg.self.mid) !== who.mid) { next.problem = 'mismatch'; next.expected = String(cfg.self.mid) }
    } else if (who.invalid || who.badFormat) next = { state: 'invalid', code: who.code, why: whoIsWhyNot(who) }   // 存着的值格式坏了：一样得重新登录
    else next = { state: 'unknown', why: '这次没查到（' + whoIsWhyNot(who) + '）' }
  }
  if (hint) next.hint = hint
  // 「这次没查到」时把上次知道的号和最后一次有效的时间留着
  if (next.state !== 'ok') { next.mid = prev.mid ?? null; next.name = prev.name ?? null; next.lastOkAt = prev.lastOkAt ?? null }
  next.checkedAt = at
  const same = prev.state === next.state && (prev.problem ?? null) === (next.problem ?? null)
  // since = 现在这个「查得到的状态」（有效 / 失效 / 是你的号 / 是另一个号 / 没登录）从什么时候开始的；
  // 中间有几次查不到（unknown）不算断开：失效 → 查不到 → 还是失效，since 还是第一次失效那会儿
  const knownKey = next.state === 'unknown' ? prev.knownKey ?? null : `${next.state}|${next.problem ?? ''}${next.problem === 'mismatch' ? ':' + next.mid : ''}`
  next.knownKey = knownKey
  next.since = next.state === 'unknown' ? prev.since ?? at : knownKey === prev.knownKey ? prev.since ?? at : at
  // 提醒按「问题」算：同一个问题（失效 / 是你的号 / 是另一个号）只提醒一次。
  // 中间有几次网络不通、查不到，不算问题结束（不然网络一抖一抖就每小时提醒一次）；查到正常了才算结束
  const key = next.state === 'invalid' ? 'invalid' : next.problem ? `${next.problem}:${next.mid}` : null
  if (next.state === 'unknown') { next.alertKey = prev.alertKey ?? null; next.notifiedAt = prev.notifiedAt ?? null }
  else { next.alertKey = key; next.notifiedAt = key && key === prev.alertKey ? prev.notifiedAt ?? null : null }
  const alert = !key ? null
    : key === 'invalid' ? `她那个号的 B站 登录${next.code == null ? '用不了了' : '失效了'}（${next.why}）。她现在多半看不了、也发不了东西。重新扫码：node host/cli.mjs cookie --qr`
      : next.problem === 'owner' ? '存着的 B站 凭据登录的是你自己的号 —— 她会用你的号说话。重新扫她的号：node host/cli.mjs cookie --qr'
        : `存着的 B站 凭据登录的号（UID ${next.mid}）和配置里她的号（UID ${next.expected}）不一样。要是没打算换号，重新扫她的号：node host/cli.mjs cookie --qr`
  let notifyError = null
  // 等 B站 回话的这会儿你重新登录了：结果说的是旧凭据，不能拿它提醒你、也不能盖掉新登录记下的状态（下一次检查查新的）
  if (credMoved(snap)) return dropped(at, notifyError)
  if (alert && !next.notifiedAt && notify) {
    try { await notify('bili-whale：' + alert); next.notifiedAt = at } catch (e) { notifyError = scrub(e?.message ?? e) }   // 没推成：下次再试；宿主会把原因记进日志
  }
  if (credMoved(snap)) return dropped(at, notifyError)   // 推送也要等一会儿：写之前再对一次（已经推出去的收不回）
  writeLoginState(next)
  return { ...next, changed: !same, alert, notifyError }
}

// 凭据文件原文（读不了 = text null + 错误码）：只在内存里比「检查途中换没换」，不打印、不写进任何地方
function readCredFile() {
  try { return { text: fs.readFileSync(CRED_FILE, 'utf8'), err: null } } catch (e) { return { text: null, err: String(e?.code ?? 'ERR') } }
}
const credMoved = (snap) => { const n = readCredFile(); return n.text !== snap.text || n.err !== snap.err }
// 和 core.readSavedCred 一样的读法（带 BOM 也认），只是用上面那份原文：判断的和比对的是同一份
function parseCred(text) {
  if (text == null) return null
  try { const j = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text); return j && typeof j === 'object' ? j : null } catch { return null }
}
// 作废的那次检查交给调用方（体检那一行 / 宿主日志）的：算「这次没查到」，状态文件不动
function dropped(at, notifyError) {
  const cur = readLoginState() ?? {}
  return { state: 'unknown', why: '这次没查到（查到一半凭据换了，这次的结果作废）', mid: cur.mid ?? null, name: cur.name ?? null, lastOkAt: cur.lastOkAt ?? null, checkedAt: at, stale: true, changed: false, alert: null, notifyError }
}

/** 宿主里怎么排登录检查：启动 firstMs 后查一次，之后每 everyMs 一次（单独拿出来好测） → [timer, timer] */
export function scheduleLoginChecks(fn, { firstMs = 20_000, everyMs = 60 * 60_000, setTimeoutFn = setTimeout, setIntervalFn = setInterval } = {}) {
  return [setTimeoutFn(fn, firstMs), setIntervalFn(fn, everyMs)]
}

/** 体检 / 别处显示用：登录状态 → { level: ok | bad | warn, text, line（带 ✓ / ✗ / ⚠️ 的整行） } */
export function describeLogin(l) {
  const d = describeLevel(l)
  return { ...d, line: `  ${{ ok: '✓', bad: '✗', warn: '⚠️' }[d.level]} ${d.text}` }
}
function describeLevel(l) {
  const name = shownName(l?.name)
  if (l?.state === 'ok' && !l.problem) return { level: 'ok', text: `她的 B站 登录有效：${name}（UID ${l.mid}）${l.hint ? '（' + l.hint + '）' : ''}` }
  if (l?.state === 'ok') return { level: 'bad', text: l.alert ?? (l.problem === 'owner' ? '存着的 B站 登录是你自己的号 —— node host/cli.mjs cookie --qr 重新扫她的号' : `存着的 B站 登录是 UID ${l.mid}，和配置里她的号（UID ${l.expected}）不一样 —— 没打算换号的话 node host/cli.mjs cookie --qr`) }
  if (l?.state === 'invalid') return { level: 'bad', text: `她的 B站 登录失效了（${l.why}）—— 重新扫码：node host/cli.mjs cookie --qr` }
  if (l?.state === 'missing') return { level: 'bad', text: '还没登录她那个 B站 号：node host/cli.mjs cookie --qr' }
  return { level: 'warn', text: `她的 B站 登录${l?.why ?? '这次没查到'}${l?.lastOkAt ? '；上次确认有效：' + String(l.lastOkAt).slice(0, 16).replace('T', ' ') : ''}` }
}

/**
 * 宿主每小时跑一次的登录检查（host/daemon.mjs 调；单独拿出来好测）：风控熔断中就不去碰 B站；
 * 状态变了记一行日志；要提醒你的事走「推送」—— 推送方式是「B站 私信」时靠的就是她这个号，登录出了问题就发不出去：
 * 只记进日志（面板「最近的错误」能看到），当作提醒过了，不每小时重试；推送失败记日志、下次检查再试。
 */
export async function runLoginCheck({ log, runBili, fetch: f, now = Date.now, banned = () => apiState()?.banned } = {}) {
  try {
    if (banned()) return null
    const s = await probeLogin({ fetch: f, now, notify: async (m) => {
      // 只有「B站 私信、而且没有别的备用方式」时才发不出去；备用方式是 QQ / 桌面之类的，照样推（私信失败后改用备用的）
      const nt = readConfig().notify ?? {}
      if (nt.type === 'dm' && (!nt.fallback || ['dm', 'none'].includes(nt.fallback))) { log('⚠️ 登录提醒没推送（推送方式是 B站 私信，要用她这个号发）：' + m); return }
      const r = await runBili(['notify', m, '--title', 'bili-whale'], { timeout: 60_000 })
      if (!r.ok) throw new Error(String(r.err ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || '推送命令失败（没有出错信息）')
    } })
    if (s.stale) log('B站 登录检查到一半凭据换了（刚重新登录过？）：这次的结果作废，没写状态')
    if (s.changed) log(`B站 登录状态：${s.state}${s.problem ? '（' + s.problem + '）' : ''}${s.why ? ' · ' + s.why : ''}`)
    if (s.notifyError) log('⚠️ 登录提醒没推送成（下次检查再试）：' + s.notifyError)
    return s
  } catch (e) { log('登录检查出错：' + scrub(e?.message ?? e)); return null }
}
