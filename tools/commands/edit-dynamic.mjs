// 编辑已存在的动态：POST /x/dynamic/feed/edit/dyn（端点从网页 JS 里扒出来的）
//   "/x/dynamic/feed/" + (dyn_id_str ? "edit" : "create") + "/dyn"
// 用法: node edit-dynamic.mjs <dyn_id> <文本文件> [--go]
//   不给 --go 就只打印将要发送的 payload（预演）。
import fs from 'node:fs'
import path from 'node:path'
// 2026-10-21 修（外部审计）：下面 --go 路径里调了 gate()，但从来没导入过 ✗
//   一跑到那儿就是 ReferenceError（danmaku.mjs 早就踩过同一个坑，这次补齐三条）
import { gate, writeBlocked, readWriteResult, record } from '../lib/quota-gate.mjs'
import { agentPathAllowed, AI_HOME } from '../lib/paths.mjs'
import { publicGate } from '../lib/outbound.mjs'

const dyn = process.argv[2]
const textFile = process.argv[3]
const go = process.argv.includes('--go')
if (!dyn || !textFile) { console.error('用法: node edit-dynamic.mjs <dyn_id> <文本文件> [--go]'); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: `https://www.bilibili.com/opus/${dyn}`,
  origin: 'https://www.bilibili.com',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
// bili-whale-cc：她只能用自己家里的文本文件（不然能把凭据之类的文件当动态内容发出去）
if (textFile && !agentPathAllowed(textFile, [AI_HOME])) { console.error('文本文件必须在你自己的目录里'); process.exit(2) }
const text = fs.readFileSync(textFile, 'utf8').replace(/\r\n/g, '\n')
// 2026-10-26 公开发言的出门检查（tools/lib/outbound.mjs）：新正文在联网（取原动态）、记账之前先查（不带 --go 的预演也查）
{
  const bad = publicGate(text, { channel: 'dynamic-edit' })
  if (bad) { console.error(bad.msg); process.exit(bad.code) }
}

// 先把当前动态的图片原样取出来（编辑时带上，免得把图弄丢）
const d = await (await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${dyn}&features=itemOpusStyle`, { headers: H })).json()
const major = d.data?.item?.modules?.module_dynamic?.major
const opus = major?.opus ?? major?.draw
const pics = (opus?.pics ?? []).map((p) => ({ img_src: p.url, img_width: p.width, img_height: p.height }))
console.log(`当前 major.type = ${major?.type}`)
console.log(`当前图片 ${pics.length} 张：${pics.map((p) => `${p.img_width}x${p.img_height}`).join(', ')}`)

const payload = {
  dyn_id_str: String(dyn),
  dyn_req: {
    scene: pics.length ? 2 : 1,
    content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
    ...(pics.length ? { pics } : {}),
    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
  },
}
console.log(`\n新正文长度：${text.length} 字（上限 1000）`)
console.log('—— 新正文 ——')
console.log(text)
console.log('—— payload 摘要 ——')
console.log(JSON.stringify(payload).slice(0, 400) + '…')

if (!go) { console.log('\n[预演] 未发送。确认无误加 --go。'); process.exit(0) }

// P0-5（Kimi 评审 #5）：写通道也要过限额闸；不通过就停手
if (!gate({ type: 'dynamic', target: 'dynamic', auto: process.argv.includes('--auto') })) { console.error('拒绝：限额闸不通过（额度/白名单）'); process.exit(2) }
if (writeBlocked()) { console.error('✗ ' + writeBlocked()); process.exit(2) }
const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/edit/dyn?csrf=${cred.bili_jct}&platform=web`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
const j = await readWriteResult(r, 'edit/dyn')   // 先看风控（熔断）再解析
console.log(`\n[go] HTTP ${r.status}  code=${j.code} message=${j.message ?? ''}`)
if (j.code === 0 || (j.code === undefined && !j._risk && r.ok)) {
  console.log('  ✅ 看起来成功了，去回读复核')
  record({ type: 'dynamic-edit', target: `dyn:${dyn}`, note: String(text ?? '').slice(0, 40), auto: process.argv.includes('--auto') })
  try {
    const { execFileSync: run } = await import('node:child_process')
    const { fileURLToPath: f2p } = await import('node:url')
    const { NODE_EXE: NODE } = await import('../lib/nodebin.mjs')
    run(NODE, [f2p(new URL('./notify.mjs', import.meta.url)), `[自主发言] 改了一条已发布的动态 https://t.bilibili.com/${dyn}\n改成：${String(text ?? '').slice(0, 600)}`, '--title', '自主发言报备'], { stdio: 'inherit', windowsHide: true, timeout: 60_000 })
  } catch (e) { console.log('  [通知] 发出去了但报备失败：' + String(e?.message ?? e).slice(0, 120)) }
}
else console.log('  ❌ 失败：' + JSON.stringify(j).slice(0, 300))
