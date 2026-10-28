// 测试用：把 node 硬链接成 venv 里的 python.exe，再用 NODE_OPTIONS=--import 预加载这个文件 ——
// 跑 `python studio.py render …` 时这里冒充 studio.py（不需要真 Python / 配音 / ffmpeg），其他 node 进程里它什么都不做。
//   FAKE_EDIT_DURING_RENDER=1   渲染途中改作品目录里的 script.json（模拟她在渲染的几分钟里改稿）
//   FAKE_SWAP_FINAL=1           渲染完、回报之后把成片换掉（模拟回报和落盘之间被动过）
//   FAKE_RECORD_CONFIG=<文件>   把收到的渲染配置复制到这个文件（测试看 node 给了什么）
//   FAKE_RENDER_FAIL=silent|junk|hang   渲染失败的几种样子：一声不吭退出（码 3）/ 只打一行不是 JSON 的话 / 一直不结束（等着被超时停掉）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const a = process.argv
if (a[1] && path.basename(a[1]) === 'studio.py') {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  if (a[2] === 'render') {
    if (process.env.FAKE_RENDER_FAIL === 'silent') process.exit(3)
    if (process.env.FAKE_RENDER_FAIL === 'junk') { console.log('Traceback (most recent call last): FAKE_BOOM'); process.exit(1) }
    if (process.env.FAKE_RENDER_FAIL === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000); process.exit(0) }   // 同步地干等：等着被超时停掉
    const proj = a[3]
    const si = a.indexOf('--script')
    const bytes = fs.readFileSync(si > 0 ? a[si + 1] : path.join(proj, 'script.json'))
    const s = JSON.parse(bytes.toString('utf8'))
    if (process.env.FAKE_EDIT_DURING_RENDER === '1') fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify({ ...s, title: '渲染中被改了' }))
    fs.writeFileSync(path.join(proj, 'final.mp4'), 'video:' + JSON.stringify(s.scenes ?? []))
    fs.writeFileSync(path.join(proj, 'cover.jpg'), 'cover:' + s.title)
    const hashes = { 'script.json': sha(bytes), 'final.mp4': sha(fs.readFileSync(path.join(proj, 'final.mp4'))), 'cover.jpg': sha(fs.readFileSync(path.join(proj, 'cover.jpg'))) }
    if (process.env.FAKE_SWAP_FINAL === '1') fs.writeFileSync(path.join(proj, 'final.mp4'), 'swapped')
    if (process.env.FAKE_RECORD_CONFIG) fs.copyFileSync(a[a.indexOf('--config') + 1], process.env.FAKE_RECORD_CONFIG)   // 留下 node 交给 studio.py 的渲染配置
    const outfits = s.outfit && typeof s.outfit === 'object' ? s.outfit : {}   // 真 studio.py 回报这次每个角色穿的换装
    console.log(JSON.stringify({ ok: true, seconds: 60, title: s.title, final: path.join(proj, 'final.mp4'), cover: path.join(proj, 'cover.jpg'), scenes: 1, lines: 1, ai_images: 0, ai_images_total: 3, ai_images_limit: 12, outfits, hashes }))
    process.exit(0)
  }
  if (a[2] === 'voices' && process.env.FAKE_RENDER_FAIL === 'silent') process.exit(3)   // 试听也一声不吭地退出
  console.log(JSON.stringify({ ok: false, error: 'fake studio.py: ' + a[2] + ' not supported' }))
  process.exit(1)
}
