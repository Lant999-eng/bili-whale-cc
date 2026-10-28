// 测试用（自查图，v0.11.20）：和 fake-studio-py.mjs 一样冒充 `python studio.py render …`（node 硬链接成 venv 的 python.exe，
// 再用 NODE_OPTIONS=--import 预加载这个文件；别的 node 进程里它什么都不做），另外按 FAKE_SHEET 造自查图、在回报里带 check_pages / check_error
// （真 studio.py 的样子见 make_check_sheet）：
//   FAKE_SHEET=1 | 2    造 build/check.jpg（2：再加 check-2.jpg）+ check.json + frame-s01.jpg，回报 check_pages = 1 / 2
//   FAKE_SHEET=missing  回报 check_pages = 1，文件却不在
//   FAKE_SHEET=string   回报 check_pages = "1"（不是整数）
//   FAKE_SHEET=fail     回报 check_pages = 0 + check_error（带换行和终端转义）
//   FAKE_SHEET=old      回报里没有 check_pages（老版本的 studio.py）—— 不设 FAKE_SHEET 也是这样
//   FAKE_GLYPHS=1       回报里带 missing_glyphs（字体里没有的字），夹几条坏的（场景号不是整数、只有终端控制符、chars 不是字符串）
// 和真 studio.py 一样，渲染一开始先清掉上次的自查图，最后把回报也写进作品目录的 render.json
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const a = process.argv
if (a[1] && path.basename(a[1]) === 'studio.py' && a[2] === 'render') {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  const proj = a[3]
  const si = a.indexOf('--script')
  const bytes = fs.readFileSync(si > 0 ? a[si + 1] : path.join(proj, 'script.json'))
  const s = JSON.parse(bytes.toString('utf8'))
  const build = path.join(proj, 'build')
  fs.mkdirSync(build, { recursive: true })
  for (const f of fs.readdirSync(build)) if (/^(check|frame-)/.test(f)) fs.rmSync(path.join(build, f), { force: true })
  fs.writeFileSync(path.join(proj, 'final.mp4'), 'video:' + JSON.stringify(s.scenes ?? []))
  fs.writeFileSync(path.join(proj, 'cover.jpg'), 'cover:' + s.title)
  const mode = process.env.FAKE_SHEET ?? 'old'
  if (mode === '1' || mode === '2') {
    for (let i = 1; i <= Number(mode); i += 1) fs.writeFileSync(path.join(build, i === 1 ? 'check.jpg' : `check-${i}.jpg`), 'sheet ' + i)
    fs.writeFileSync(path.join(build, 'check.json'), '{"v":1}')
    fs.writeFileSync(path.join(build, 'frame-s01.jpg'), 'frame')
  }
  const extra = {
    1: { check_pages: 1, check_error: null }, 2: { check_pages: 2, check_error: null }, missing: { check_pages: 1, check_error: null },
    string: { check_pages: '1', check_error: null }, fail: { check_pages: 0, check_error: '抽不出 c0003.mp4 的\n1.20 秒：\u001b[31m坏了' }, old: {},
  }[mode] ?? {}
  const glyphs = process.env.FAKE_GLYPHS
    ? { missing_glyphs: [{ scene: 0, chars: '♪' }, { scene: 3, chars: 'ℝ⊆\uFE0F\u202E' }, { scene: '4', chars: 'x' }, { scene: 5, chars: '\u001b\u0007' }, { scene: 6, chars: 7 }] }
    : {}
  const hashes = { 'script.json': sha(bytes), 'final.mp4': sha(fs.readFileSync(path.join(proj, 'final.mp4'))), 'cover.jpg': sha(fs.readFileSync(path.join(proj, 'cover.jpg'))) }
  const info = { ok: true, seconds: 60, title: s.title, final: path.join(proj, 'final.mp4'), cover: path.join(proj, 'cover.jpg'), scenes: 1, lines: 1,
    ai_images: 0, ai_images_total: 0, ai_images_limit: 12, outfits: {}, hashes, ...extra, ...glyphs }
  fs.writeFileSync(path.join(proj, 'render.json'), JSON.stringify(info, null, 2))
  console.log(JSON.stringify(info))
  process.exit(0)
}
