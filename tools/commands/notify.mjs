// 通知分发器 —— 她看完一轮，把摘要送到哪。
//
// 2026-10-18 主人重定：方式只有四种（不推送 / 桌面通知 / Webhook / 自定义命令）。
//   · Webhook **按域名自动适配**飞书/钉钉/企业微信/QQ机器人/WorkBuddy 的报文格式
//     （它们各自的 JSON 结构不一样 ✗，让用户去记格式不现实 ✓）
//   · 自定义命令：`cmd` = 可执行文件、`args` = 参数数组，消息自动作为**最后一个参数**传入 ✓
//     （`$MSG` 占位已于 2026-10-18 弃用 ✗ —— 走 shell 有命令注入风险，来源是陌生评论/弹幕）
//   · 兼容旧配置：stdout / file 仍然可用（不删，免得老配置炸 ✗）
//
// 用法：
//   node notify.mjs "消息正文" [--title 标题] [--dry]   （--dry = 只算报文，不真发）
//   node notify.mjs --test                              （发一条测试消息；设置页「发条测试」用它）
//
// 配置（<数据目录>/bili-whale.config.json 的 notify 段；数据目录默认 ~/.bili-whale）：
//   { "type": "none|desktop|webhook|command|dm", "url": "", "template": "text|markdown", "cmd": "", "fallback": "" }
//   · 模块还能登记别的方式（2026-10-28）：tools/lib/<方式>-notify.mjs 在，type / fallback 写它的名字就走它（它的说明写在那个文件里）；不在 = 不认得这种方式
//   · fallback：主推送失败时改用的方式（比如私信失败 → desktop）；空 = 不改用 —— 只有自定义命令例外：没配就默认改用桌面通知
//     （以前是「命令不存在」时写死改用桌面、连配好的备用方式都不看；2026-10-24 Codex 审第 12 版后统一走这里）；none = 明确不改用
//
// 时间预算（2026-10-24，Codex 审第 12 版）：整个 notify 最多花 WHALE_NOTIFY_BUDGET_MS（默认 45 秒，调用方按自己的超时设）。
//   配了备用方式时主方式只用 60%，剩下的留给备用方式 —— 以前 webhook 没有超时、私信 90 秒、命令 60 秒，
//   都不比宿主等它的 60 秒短：主方式一卡住，宿主先把 notify 结束掉，备用方式根本轮不到
import { spawnSync } from 'node:child_process'
import { execFileSync } from '../lib/capture.mjs'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { dshPath } from '../lib/paths.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { credDirty, DIRTY_CRED_MSG } from '../lib/cred.mjs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const TEST = argv.includes('--test')
const ti = argv.indexOf('--title')
const title = ti >= 0 ? (argv[ti + 1] ?? '通知') : '通知'

const T0 = Date.now()
const BUDGET_MS = (() => {
  const v = Number(process.env.WHALE_NOTIFY_BUDGET_MS)
  return Number.isFinite(v) && v > 0 ? Math.min(300_000, Math.max(5_000, Math.floor(v))) : 45_000
})()
const left = () => BUDGET_MS - (Date.now() - T0)

let text
if (TEST) {
  text = `这是一条测试消息 ✓\n如果你看到它，说明「消息推送」配好了。\n（${new Date().toLocaleString('zh-CN', { hour12: false })}）`
} else {
  // 第一个不以 -- 开头、且不是 --title 的值的参数
  const skip = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--title') { skip.add(i); skip.add(i + 1) }
    if (argv[i] === '--dry' || argv[i] === '--test') skip.add(i)
  }
  text = argv.find((a, i) => !skip.has(i) && !a.startsWith('--'))
}
if (!text) { console.error('用法: node notify.mjs "消息正文" [--title 标题] | --test'); process.exit(2) }

const n = config().notify ?? { type: 'none' }
const type = String(n.type ?? 'none')
const payload = { title, text, at: new Date().toISOString() }
const clip = (s, k) => (s.length > k ? s.slice(0, k) + '…' : s)
const cutChars = (s, k) => (s.length > k ? s.slice(0, /[\uD800-\uDBFF]/.test(s[k - 1]) ? k - 1 : k) : s)

/**
 * 推送地址里藏着 key（钉钉的 access_token、各种 sendkey……）：出错信息、对方回的内容里出现了就抹掉 ——
 * 整个地址、账号密码、每个参数值、长一点的路径段，连同网址编码的写法（她看得到 notify 的输出，地址本来是不给她看的）
 */
const URL_WORDS = new Set(['webhook', 'webhooks', 'cgi-bin', 'open-apis', 'services', 'message', 'messages', 'notify', 'notification', 'trigger',
  'robot', 'robots', 'hooks', 'markdown', 'actioncard', 'interactive', 'bot', 'send', 'hook', 'push', 'api', 'v1', 'v2', 'v3', 'json', 'text'])
function urlScrubber(url) {
  const s = String(url ?? '').trim()
  const found = new Set()
  if (s) { found.add(s); try { found.add(decodeURI(s)) } catch {} }
  let u = null
  try { u = new URL(s) } catch { try { u = new URL('http://' + s) } catch {} }
  if (u) {
    if (u.search) found.add(u.search.slice(1))
    // 路径段和参数值：像 webhook、cgi-bin、open-apis 这种各家地址里都有的普通词不算（以前连它们一起抹，报错变成「*** 5 秒没回」）
    for (const v of [u.username, u.password, ...u.searchParams.values(), ...u.pathname.split('/')]) if (v && !URL_WORDS.has(v.toLowerCase())) found.add(v)
  }
  const list = [...found].flatMap((v) => [v, encodeURIComponent(v)]).filter((v) => v.length >= 6).sort((a, b) => b.length - a.length)
  return (t) => { let out = String(t ?? ''); for (const v of list) out = out.split(v).join('***'); return out }
}
const scrubUrl = urlScrubber(n.url)

/** 按域名猜服务，生成它认的报文（飞书 / 钉钉 / 企微 / WorkBuddy / 通用）。 */
function buildWebhookBody(url, tpl) {
  const md = tpl === 'markdown'
  const line = `${title}\n${text}`
  const u = String(url)
  if (u.includes('open.feishu.cn') || u.includes('larksuite.com')) {
    return md
      ? { msg_type: 'post', content: { post: { zh_cn: { title, content: [[{ tag: 'text', text: line }]] } } } }
      : { msg_type: 'text', content: { text: line } }
  }
  if (u.includes('oapi.dingtalk.com')) {
    return md
      ? { msgtype: 'markdown', markdown: { title, text: line } }
      : { msgtype: 'text', text: { content: line } }
  }
  if (u.includes('qyapi.weixin.qq.com')) {
    return md ? { msgtype: 'markdown', markdown: { content: line } } : { msgtype: 'text', text: { content: line } }
  }
  if (u.includes('workbuddy')) return { title, text: line, format: md ? 'markdown' : 'text' }
  // 通用兜底（含 QQ 机器人常见的 { content } 约定）
  return { title, text: line, content: line, format: md ? 'markdown' : 'text' }
}

/**
 * HTTP 200 不等于发成了：钉钉 / 企微 / 飞书拒收（关键词、签名、IP 白名单不对，或者一分钟超过 20 条被限流）时
 * 回的也是 200，错误码在正文里（2026-10-24 审查发现：以前一律当成功，备用方式永远轮不到）。返回拒收原因，null = 发成了
 */
function webhookRefused(url, raw) {
  let j
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const u = String(url)
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  if (u.includes('oapi.dingtalk.com') || u.includes('qyapi.weixin.qq.com')) return num(j.errcode) === 0 ? null : `errcode=${j.errcode} ${j.errmsg ?? ''}`.trim()
  if (u.includes('open.feishu.cn') || u.includes('larksuite.com')) {
    const c = num(j.code ?? j.StatusCode)
    return c === 0 ? null : `code=${j.code ?? j.StatusCode} ${j.msg ?? j.StatusMessage ?? ''}`.trim()
  }
  // 通用：只认很明确的失败写法（不看 code —— 有的服务成功也回 code=200）
  for (const k of ['errcode', 'retcode']) { const c = num(j[k]); if (c !== undefined && Number.isFinite(c) && c !== 0) return `${k}=${j[k]} ${j.errmsg ?? j.msg ?? j.message ?? ''}`.trim() }
  if (j.status === 'failed' || j.ok === false || j.success === false) return String(j.message ?? j.msg ?? 'failed')
  return null
}

async function sendWebhook(url, tpl, ms) {
  const body = buildWebhookBody(url, tpl)
  if (DRY) { console.log('[dry] webhook 报文：\n' + JSON.stringify(body, null, 2)); return }
  let r, raw
  try {
    // 整个请求（连上、等回、读完正文）共用一个超时
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })
    raw = await r.text().catch((e) => { if (e?.name === 'TimeoutError') throw e; return '' })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`webhook ${Math.round(ms / 1000)} 秒没回`)
    throw new Error(`webhook 没发出去：${e?.message ?? e}${e?.cause?.code ? `（${e.cause.code}）` : ''}`)
  }
  if (!r.ok) throw new Error(`webhook HTTP ${r.status} ${clip(scrubUrl(raw), 160)}`)
  const refused = webhookRefused(url, raw)
  if (refused) throw new Error(`webhook 回了 HTTP ${r.status}，但对方说没收：${clip(scrubUrl(refused), 160)}`)
  console.log(`webhook ${r.status} ✓ ${clip(scrubUrl(raw), 120)}`)
}

// 弹通知用 PowerShell 自己的程序身份（Windows 认得它）：以前用的「DeepSeek Harness」只有装了 DSH 才注册过，
// 没注册的身份 Windows 可能悄悄不弹
const TOAST_APP = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

function sendDesktop(ms) {
  if (DRY) { console.log('[dry] 桌面通知：' + String(text).slice(0, 60)); return }
  // 不是 Windows 就弹不出来：明说失败（以前只往输出里打一行就算成功，备用方式永远轮不到）
  if (process.platform !== 'win32') throw new Error(`桌面通知只支持 Windows（这台电脑是 ${process.platform}）`)
  // 任何一步出错都让 PowerShell 以 1 退出（以前出错照样走完、以 0 退出，notify 就说「已发送」）
  const ps = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '"<toast><visual><binding template=""ToastGeneric""><text></text><text></text></binding></visual></toast>" | Out-File -Encoding utf8 $env:DW_XML',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml([IO.File]::ReadAllText($env:DW_XML))',
    '$node = $xml.GetElementsByTagName("text")',
    '$node.Item(0).AppendChild($xml.CreateTextNode($env:DW_TITLE)) | Out-Null',
    '$node.Item(1).AppendChild($xml.CreateTextNode($env:DW_TEXT)) | Out-Null',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DW_APP).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    'finally { Remove-Item $env:DW_XML -Force -ErrorAction SilentlyContinue }',
  ].join('\n')
  const script = path.join(os.tmpdir(), `dw-toast-${process.pid}-${Date.now()}.ps1`)
  const xml = path.join(os.tmpdir(), `dw-toast-${process.pid}-${Date.now()}.xml`)
  fs.writeFileSync(script, ps, 'utf8')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, DW_TITLE: String(title), DW_TEXT: String(text), DW_XML: xml, DW_APP: TOAST_APP },
      encoding: 'utf8', timeout: Math.min(20_000, ms), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
  } finally {
    fs.rmSync(script, { force: true }); fs.rmSync(xml, { force: true })
  }
  console.log('桌面通知已发送 ✓')
}

function sendCommand(cmd, ms) {
  const c = String(cmd ?? '')
  if (!c.trim()) throw new Error('config.notify.cmd 没配')
  // 这几样检查放在 --dry 前面：预演也要看得出真发时会失败（2026-10-24）
  if (c.includes('$MSG')) {
    // 2026-10-18 弃用（KIMI 评审指出）✗：$MSG 要走 shell，而 cmd.exe **不认 \" 转义** →
    //   消息里一个英文双引号就能破开引号边界，等于**遥控执行命令** ✗（消息来源是陌生评论/弹幕）
    //   要拼命令请用 cmd + args 那条路 ✓（execFileSync，不走 shell ✓）
    throw new Error('$MSG 已弃用（有命令注入风险）：请把 cmd 填成可执行文件、把参数放 args，消息会自动作为最后一个参数传入 ✓')
  }
  // 命令不存在（换电脑 / 插件被删 / 写死的路径变了）：明说失败，由外面统一改用备用方式（没配就是桌面通知）
  if (/[\\/]/.test(c) && !fs.existsSync(c)) throw new Error(`推送命令不存在：${c}（去设置里改「消息推送」）`)
  if (DRY) { console.log('[dry] 命令：' + c + '  (消息作为最后一个参数)'); return }
  // 2026-10-18 加：支持 cmd + args（推荐用法 ✓）—— 消息作为**最后一个参数**传进去，
  // 不走 shell → 中文/emoji/引号都不会被 cmd.exe 弄坏 ✓（比如 dsh-wechat-send）
  const args = Array.isArray(n.args) ? n.args.map(String) : []
  execFileSync(c, [...args, String(text)], {
    stdio: 'inherit', timeout: Math.min(60_000, ms),
    env: { ...process.env, WHALE_NOTIFY_TEXT: String(text), WHALE_NOTIFY_TITLE: String(title) },
  })
  console.log('命令已执行 ✓')
}

const DM_MAX = 300   // dm.mjs 只收 300 字以内（多了算刷屏）：长的截短再发，免得报备一长就整条发不出去
/**
 * 截到 300 字以内，但保住最后一行：各处的推送都把要主人做的事（pending approve <id>、videos approve <id>……）放在最后一行，
 * 只截开头会把它切掉（2026-10-24 复核）。最后一行本身太长（超过一半）就只能从开头截
 */
function fitDm(s) {
  if (s.length <= DM_MAX) return s
  const mark = '…（太长，中间省略了）'
  const cut = s.lastIndexOf('\n')
  const last = cut >= 0 ? s.slice(cut + 1) : ''
  if (last.trim() && last.length <= DM_MAX / 2) return cutChars(s.slice(0, cut), DM_MAX - mark.length - 1 - last.length) + mark + '\n' + last
  return cutChars(s, DM_MAX - 9) + '…（太长，截断了）'
}

/**
 * 模块登记的推送方式（2026-10-28）：tools/lib/<方式>-notify.mjs，导出 send({ text, title, dry, ms })（失败就抛错）。
 * 名字只认小写字母；文件不在 → null（模块没装 = 不认得这种方式）；文件在、加载出错 → 抛错（这种方式就算失败，照样改用备用方式）
 */
async function moduleChannel(kind) {
  if (!/^[a-z]+$/.test(kind)) return null
  const u = new URL(`../lib/${kind}-notify.mjs`, import.meta.url)
  if (!fs.existsSync(u)) return null
  try { return await import(u.href) } catch (e) {
    // 加载出错的原话不往外说（里面有电脑上的路径）：只说出错的种类
    throw new Error(`推送方式「${kind}」加载出错（${[e?.name ?? 'Error', e?.code].filter(Boolean).join(' ')}）`)
  }
}

/** 用一种方式发出去，最多花 ms 毫秒；失败就抛错（2026-10-24：从顶层挪进函数，好在主推送失败时改用 notify.fallback） */
async function deliver(kind, ms) {
  if (kind === 'none') {
    console.log(DRY ? '[dry] 方式=none（不推送）→ 什么也不做 ✓' : '（方式=none：不推送）')
  } else if (kind === 'desktop') {
    sendDesktop(ms)
  } else if (kind === 'webhook') {
    if (!n.url) throw new Error('config.notify.url 没配')
    await sendWebhook(n.url, n.template, ms)
  } else if (kind === 'command') {
    sendCommand(n.cmd, ms)
  } else if (kind === 'dm') {
    // 2026-10-19 加：B站私信（专属通道）—— 调 commands/dm.mjs 的发送逻辑
    //   私信自带三道闸（只发主人 / 必须互相关注 / 一天只锁定一个收信人）
    // 2026-10-19：DSH 的 Windows 沙箱禁止捕获子进程输出（管道 → EPERM）——
    //   用文件句柄重定向拿输出（不走管道），再原样转贴到 stdout/stderr。
    // 2026-10-21 修（审查 P1-1）：原来这里写死 --go，且没有 DRY 判断 ✗ → notify "…" --dry 在 type=dm 时会【真的发出私信】✗
    const msg = fitDm(String(text))
    if (!String(config().owner?.mid ?? '').trim()) throw new Error('配置里 owner.mid 为空 —— 私信只发给主人，没配就发不了')
    // 凭据里的 cookie 带了换行 / 控制字符：dm.mjs 一发请求，Node 的报错就带着整条 cookie —— 不起它，直接算失败（好改用备用方式）。
    // bili.mjs 入口的同一道检查管不到这里：notify 是直接起 dm.mjs 的（2026-10-24 复核）
    if (credDirty()) throw new Error(`私信发不了：${DIRTY_CRED_MSG}`)
    if (DRY) { console.log('[dry] B站私信（不发送）：' + msg.slice(0, 80) + (msg !== String(text) ? `（原文 ${String(text).length} 字，超过 ${DM_MAX} 字会截短）` : '')); return }
    const dmPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dm.mjs')
    const outF = path.join(os.tmpdir(), `whale-dm-out-${process.pid}-${Date.now()}.txt`)
    const errF = path.join(os.tmpdir(), `whale-dm-err-${process.pid}-${Date.now()}.txt`)
    const fdO = fs.openSync(outF, 'w'); const fdE = fs.openSync(errF, 'w')
    let r
    try {
      r = spawnSync(NODE_EXE, [dmPath, '--msg', msg, '--go'], { stdio: ['ignore', fdO, fdE], timeout: Math.min(90_000, ms), windowsHide: true })
    } finally {
      try { fs.closeSync(fdO) } catch {}
      try { fs.closeSync(fdE) } catch {}
    }
    // 转贴 dm.mjs 的输出之前先抹掉 cookie 的样子（兜底：上面已经挡住了带控制字符的凭据）
    const noCookie = (s) => String(s).replace(/\b(SESSDATA|bili_jct|buvid3|DedeUserID\w*)=[^;\s"]+/gi, '$1=***')
    if (fs.existsSync(outF)) process.stdout.write(noCookie(fs.readFileSync(outF, 'utf8')))
    if (r?.status !== 0) console.error(noCookie((fs.existsSync(errF) ? fs.readFileSync(errF, 'utf8') : '').trim()) || '（私信发送失败）')
    fs.rmSync(outF, { force: true }); fs.rmSync(errF, { force: true })
    if (r?.error?.code === 'ETIMEDOUT') throw new Error(`私信 ${Math.round(ms / 1000)} 秒没发完，未确认送达`)
    if (r?.error || r?.status !== 0) throw new Error('私信推送失败，未确认送达')
  } else if (kind === 'stdout') {
    console.log(`[通知] ${title}\n${text}`)
  } else if (kind === 'file') {
    const p = n.path || dshPath('whale-notify.log')   // 没写、写了空字符串都算没填（示例配置的 notify 是 type: "none"，不带 path）
    if (DRY) { console.log(`[dry] 通知文件：${p}（不写入）`); return }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(payload) + '\n')
    console.log(`已写入通知文件：${p}`)
  } else {
    const ch = await moduleChannel(kind)
    if (!ch) throw new Error(`未知的推送方式：${kind}`)
    await ch.send({ text, title, dry: DRY, ms })
  }
}

// 备用方式：配了用配的；自定义命令没配时默认用桌面通知（兼容以前「命令不存在就改用桌面」的老配置）；none / 和主方式一样 = 不改用
const fallbackSet = String(n.fallback ?? '').trim()
const fallback = fallbackSet || (type === 'command' ? 'desktop' : '')
const canFallback = Boolean(fallback) && fallback !== type && fallback !== 'none'
// 退出：先把退出码定下，留一点时间让输出写完；万一有连接没关，1.5 秒后也一定退出
const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref() }

try {
  await deliver(type, canFallback ? Math.floor(BUDGET_MS * 0.6) : BUDGET_MS - 1_000)
  finish(0)
} catch (e) {
  console.error(`通知失败（${type}）：${scrubUrl(e?.message ?? e)}`)
  let ok = false
  if (canFallback) {
    const ms = left() - 500
    if (ms < 1_000) console.error(`没时间改用备用方式「${fallback}」了（推送总共只有 ${Math.round(BUDGET_MS / 1000)} 秒）`)
    else {
      try {
        console.error(`→ 改用备用方式「${fallback}」${fallbackSet ? '' : '（自定义命令没配备用方式时默认用桌面通知）'}`)
        await deliver(fallback, ms)
        ok = true
      } catch (e2) { console.error(`备用方式也失败了（${fallback}）：${scrubUrl(e2?.message ?? e2)}`) }
    }
  }
  if (!ok) console.error(`原文：${title} / ${String(text).slice(0, 200)}`)
  finish(ok ? 0 : 1)
}
