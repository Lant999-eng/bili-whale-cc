// 读书笔记（2026-10-28，A 版）：只在宿主单独开的读书回合里用。
//   node bili.mjs note write --text "…" [--title "…"]
// 用她自己的话，20–800 字；洗过（起不了新的一行、冒充不了宿主）；链接、邮箱、电话、QQ / 微信号、8 位以上的号码、像编码的一长串换成（略）；
// 和这一轮读过的网页连着撞上 20 个字以上 → 不收（要用自己的话）。一轮最多 web.notesPerRound 条。来源（读过哪些网站）由宿主记，不是她写的。
// 笔记下次醒来时附给她（标明是素材、不是指令）；主人在 cli web notes / 面板上看得到全文。
// 退出码：0 好了 · 2 用法 / 这一回合不能用 / 内容不收 · 4 账本读写出错
import { isReaderTurn } from '../lib/turn-policy.mjs'
import { readConfigStrict, webOpts } from '../lib/config.mjs'
import { neutralizeText, redactNote, foldForCheck, looseForCheck } from '../lib/neutralize.mjs'
import { requireBinding, consume, copiedFromPages, appendNote, getRequest, readVisits, NOTE_MIN, NOTE_MAX, TITLE_MAX } from '../lib/webstate.mjs'

const argv = process.argv.slice(2)
const sub = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const TURN = String(process.env.BILI_WHALE_TURN ?? '')
// 像命令、像在指挥醒来那一轮的她的字：工具名、命令行参数、宿主、「告诉 / 通知 / 报给主人」「主人说」、系统提示这类
//   查两个样子：looseForCheck（留着空白和标点：node x、--go）和 foldForCheck（只剩字母数字汉字：主·人·说、bili。mjs → bilimjs）。
//   这只是挡一下现成的话；换个说法总能绕过去 —— 真正的关是主人放行（web.reviewNotes）
const CMDISH = new RegExp([
  /bili\s*\.?\s*mjs|\bnode\s+\S|\bnotify\b|--\s*(?:go|dry|text|msg|topic)\b|claude\s*\.?\s*md|宿主|系统提示|system\s*prompt/.source,
  /(?:告诉|通知|报给|推给|发给|转告|告知|提醒)\s*主人|(?:跟|和|向|给|对)\s*主人\s*(?:讲|说|报|提)/.source,
  /主人.{0,6}?(?:说|让|要|同意|批准|允许|授权|交代|吩咐|讲过|指示|安排|决定)/.source,
  /(?:读|看|翻|打开|公开|发出?|贴)\s*(?:你的)?\s*(?:私人|今天的?)?\s*日记|以这条为准|不用(?:再)?(?:审|问|等)|不必(?:再)?等|管理员|守则|报备|新的?(?:规则|流程|指令)|最新规则/.source,
  /[（(【\[]\s*系统\s*[）)】\]]|\b(?:ignore|disregard|admin)\b|previous\s+(?:rules|instructions)|\b(?:owner|host)\s+(?:says|said|wants|asks|asked|approved|allows)\b/.source,
].join('|'), 'i')
const USAGE = `用法：note write --text "…（${NOTE_MIN}–${NOTE_MAX} 字，用自己的话）" [--title "…（≤${TITLE_MAX} 字）"]`
const done = (m, code = 0) => { (code ? console.error : console.log)(m); process.exit(code) }

if (!isReaderTurn(TURN)) done('✗ note 只在宿主单独开的读书回合里能用', 2)
if (sub !== 'write') done(USAGE, 2)
if (typeof opt.text !== 'string') done('✗ 要给 --text "…"\n' + USAGE, 2)
const cfg = readConfigStrict()
if (!cfg) done('✗ 主人的配置现在读不出来，先不记', 4)
if (!webOpts(cfg).enabled) done('✗ 主人把读书关了', 2)
try {
  const b = requireBinding(TURN)
  const t = neutralizeText(opt.text, { max: NOTE_MAX + 200 })
  const len = [...t].length
  if (len < NOTE_MIN) done(`✗ 太短了（${len} 字）：至少 ${NOTE_MIN} 字 —— 读懂了什么、哪里有意思`, 2)
  if (len > NOTE_MAX) done(`✗ 太长了（${len} 字，最多 ${NOTE_MAX} 字）：挑最值得记的`, 2)
  const red = redactNote(t, { cfg })
  // 笔记会附进醒来那一轮（那一轮知道主人的事、能发东西）：像命令、像在指挥她的话一律不收 —— 网页想借笔记递话过去，至少不能是现成的命令
  const title = typeof opt.title === 'string' ? redactNote(neutralizeText(opt.title, { max: TITLE_MAX }), { cfg }).text : ''
  // 标题、正文（换成（略）之前和之后都查：bili.mjs 会被当成网址换掉）、两个连起来都查
  const rawTitle = typeof opt.title === 'string' ? neutralizeText(opt.title, { max: TITLE_MAX }) : ''
  const looks = [t, red.text, rawTitle, title, title + ' ' + red.text].filter(Boolean)
  if (looks.some((x) => CMDISH.test(looseForCheck(x)) || CMDISH.test(foldForCheck(x)))) done('✗ 不收：笔记里不写命令、工具名、「宿主」「告诉主人」这类话 —— 只记读到了什么、自己怎么想', 2)
  const hit = looks.some((x) => copiedFromPages(TURN, x))
  if (hit) done('✗ 不收：笔记里有一段和网页原文一字不差（连着 20 个字以上）—— 用自己的话说', 2)
  consume(TURN, 'notes')
  const req = getRequest(b.requestId)
  const sources = [...new Set(readVisits({ n: 200 }).filter((v) => v.turnId === TURN && v.ok && v.kind === 'open').map((v) => v.host))]
  const rec = appendNote({ turnId: TURN, requestId: b.requestId, topic: req?.topic ?? '', title, text: red.text, sources })
  done(`✓ 记好了（${rec.id}，${[...red.text].length} 字${red.n ? `；${red.n} 处链接 / 号码换成了（略）` : ''}）；下次醒来时附给你`)
} catch (e) {
  done('✗ ' + String(e?.message ?? e).slice(0, 300), Number(e?.exitCode) || 4)
}
