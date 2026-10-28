// 给明天的信（她写给明天的自己的便条；宿主收着，下次醒来时最近两封附在提示里 —— 见 tools/lib/letters.mjs）：
//   node bili.mjs letter write --text "…" --dry|--go   只在醒来那一轮（按作息醒来 / 主人叫醒），一轮最多一封，6–300 字；写下就改不了、删不掉
//   node bili.mjs letter show [--n 2]                  看最近几封（最多 5 封；主人收起的不列，只说收起了几封）
// 没有改、删、收起：收起只有主人能做（node host/cli.mjs letters hide <id>）。
// 主人没打开（letters.enabled 不是 true，默认关）：什么都不做，只说一句「（主人关掉了给明天的信）」，退出码 0。
// 陌生人私信回合（bili-whale-sdm-…）一律不能用：bili.mjs 入口先挡一道，这里再挡一道（直接起这个脚本也一样）。
// 退出码：0 好了（「这一轮已经写过同样的一封」也算）· 2 用法 / 这一回合写不了 / 内容不收 · 4 信箱正被占着、读写出错
import { isAgent } from '../lib/paths.mjs'
import { LETTER_MAX, SHOW_MAX, WRITE_TURN_RE, KIND_LABEL, lettersEnabled, readCfgNow, cleanLetter, appendLetter, readLetters, stampOf } from '../lib/letters.mjs'

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
const USAGE = '用法：letter write --text "…" --dry|--go（只在醒来那一轮，一轮最多一封，6–300 字）· letter show [--n 2]（没有改、删、收起）'
const done = (m, code = 0) => { (code ? console.error : console.log)(m); process.exit(code) }

if (TURN.startsWith('bili-whale-sdm-')) done('✗ 陌生人私信回合里不能用 letter（只能用 sdm 和 memory）', 2)
const cfg = readCfgNow()
if (!lettersEnabled(cfg)) done('（主人关掉了给明天的信）')

try {
  if (sub === 'write') {
    if (!isAgent()) done('✗ 这是她写给明天的自己的信，只有她在醒来那一轮能写 —— 想跟她说什么：node host/cli.mjs say "…"（或者私信）；看她写的：node host/cli.mjs letters', 2)
    if (!WRITE_TURN_RE.test(TURN)) done('✗ 信只在醒来那一轮写（按作息醒来、主人叫醒你的那一轮）—— 这一回合写不了：想到的先记进私人日记，下次醒来再写', 2)
    if (Boolean(opt.dry) === Boolean(opt.go)) done('✗ 要给 --dry（先看洗过的样子）或 --go（真的写下）其中一个\n' + USAGE, 2)
    if (typeof opt.text !== 'string') done('✗ 要给 --text "…"\n' + USAGE, 2)
    if (opt.dry) {
      const c = cleanLetter(opt.text, { cfg })
      if (!c.ok) done('✗ 写不了：' + c.why, 2)
      const r = readLetters({ cfg })
      const mine = r.letters.find((x) => x.turn === TURN)
      console.log(`（预览，还没写）${c.len}/${LETTER_MAX} 字：`)
      console.log('  ' + c.text)
      console.log(mine ? `⚠️ 这一轮已经写过一封了（${mine.id}）：一轮最多一封，--go 会被拒` : '没问题就把 --dry 换成 --go（写下就改不了、删不掉；下次醒来会附在提示里）')
    } else {
      const r = appendLetter({ text: opt.text, turn: TURN, cfg })
      console.log(r.result === 'dup' ? `（这一轮已经写过同样的一封（${r.id}），没再写）` : `✓ 写好了（${r.id}）；下次醒来会附在提示里`)
    }
  } else if (sub === 'show') {
    const n = Math.min(SHOW_MAX, Math.max(1, Math.floor(Number(opt.n ?? 2)) || 2))
    const r = readLetters({ cfg })
    if (r.broken) done(`✗ 信箱读不出来（${r.broken}）—— 请主人看一下`, 4)
    const live = r.letters.filter((x) => !r.hidden.has(x.id))
    const hidden = r.letters.length - live.length
    if (!live.length) console.log('（还没有给明天的信）')
    for (const x of live.slice(-n)) console.log(`${x.id} · ${stampOf(x.at)}（${KIND_LABEL[x.kind]}）：${x.text}`)
    if (hidden) console.log(`（主人收起了 ${hidden} 封，不列）`)
  } else done(USAGE, 2)
} catch (e) {
  done('✗ ' + String(e?.message ?? e).slice(0, 300), Number(e?.exitCode) || 4)
}
