// 读书请求（2026-10-28，A 版）：她在醒来那一轮（或主人跟她聊天的时候）写「想读什么」，宿主之后单独开一轮读书回合去读（那一轮看不到主人的任何东西），
// 读完的笔记下次醒来时附给她。
//   node bili.mjs read-request --topic "…" [--start <https 网址>] --dry|--go
// 只在醒来那一轮（按作息醒来、主人叫醒）和主人跟她聊天的回合（小窗、当面聊，2026-10-28 主人定）；主人没打开读书（web.enabled 不是 true）就不收。
// 题目 2–40 字，比信还严（会经搜索引擎和网站出门）：链接、联系方式、号码、主人的号和名字、「主人」、像编码的一长串都不收。
// 起点只能是主人批准的网站（web.allow）里的 https 网址。同时只能有一条没了结的请求；主人要批准的（默认）会推送给主人。
// 退出码：0 好了 · 2 用法 / 这一回合不能用 / 内容不收 · 4 账本读写出错
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAgent } from '../lib/paths.mjs'
import { readConfigStrict, webOpts } from '../lib/config.mjs'
import { canRequestReading, READ_REQUEST_WHERE } from '../lib/turn-policy.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'
import { checkTopic, checkStart, addRequest } from '../lib/webstate.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const TURN = String(process.env.BILI_WHALE_TURN ?? '')
const USAGE = '用法：read-request --topic "想读什么（≤40 字）" [--start https://<主人批准的网站>/…] --dry|--go（醒来那一轮，或主人跟你聊天的时候）'
const done = (m, code = 0) => { (code ? console.error : console.log)(m); process.exit(code) }

if (!isAgent()) done('✗ 这是她的命令 —— 主人加读书请求：node host/cli.mjs web add --topic "…"', 2)
if (!canRequestReading(TURN)) done('✗ ' + READ_REQUEST_WHERE, 2)
const cfg = readConfigStrict()
if (!cfg) done('✗ 主人的配置现在读不出来，先不收读书请求', 4)
const o = webOpts(cfg)
if (!o.enabled) done('✗ 主人还没打开读书（web.enabled）', 2)
if (Boolean(opt.dry) === Boolean(opt.go)) done('✗ 要给 --dry（先看洗过的样子）或 --go（真的交）其中一个\n' + USAGE, 2)
if (typeof opt.topic !== 'string') done('✗ 要给 --topic "…"\n' + USAGE, 2)
const t = checkTopic(opt.topic, { cfg })
if (!t.ok) done('✗ 不收：' + t.why, 2)
let start = []
if (opt.start !== undefined) {
  const s = checkStart(opt.start, { cfg })
  if (!s.ok) done('✗ 不收：' + s.why, 2)
  start = [s.url]
}
if (opt.dry) {
  console.log(`（预览，还没交）想读：「${t.topic}」${start.length ? `\n起点：${start[0]}` : '（没有起点：读书回合会先搜索）'}`)
  console.log(o.approve ? '交了以后要主人批准才排队；读完的笔记下次醒来时附给你。没问题就把 --dry 换成 --go' : '交了就排队（今天还有轮数时）；读完的笔记下次醒来时附给你。没问题就把 --dry 换成 --go')
  process.exit(0)
}
try {
  const r = addRequest({ topic: t.topic, start, by: 'her', turn: TURN, cfg })
  if (r.status === 'pending') {
    // 推给主人：话是写死的，只带她的题目（查过的）、起点和编号
    const text = `【她想读点东西，等你批准】「${r.topic}」${start.length ? `\n起点：${start[0]}` : '（没有起点，会先搜索）'}\n批准：node host/cli.mjs web approve ${r.id}\n不批：node host/cli.mjs web reject ${r.id}`
    const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs')
    console.log(`✓ 交了（${r.id}）：等主人批准；批准以后宿主单独开一轮读书，笔记下次醒来时附给你`)
    execFile(NODE_EXE, [notifier, text, '--title', '读书请求'], { windowsHide: true, timeout: 60_000 }, (err) => {
      if (err) console.log('  ⚠️ 推送没发成：主人可能不知道有一条读书请求在等他 —— 下次和主人说话时提一句')
      process.exit(0)
    })
  } else done(`✓ 交了（${r.id}）：排队了，宿主会单独开一轮读书；笔记下次醒来时附给你`)
} catch (e) {
  done('✗ ' + String(e?.message ?? e).slice(0, 300), Number(e?.exitCode) || 4)
}
