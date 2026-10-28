// 抓取若干视频的元信息 + 封面（供 agent 看图），封面存到 <数据目录>/shots/covers/<BV>.jpg（她能 Read 的地方，和 debrief 一样）
//   node fetch-covers.mjs BV1xxx BV2yyy ...
import fs from 'node:fs'
import path from 'node:path'
import { dshPath, credentialsPath } from '../lib/paths.mjs'
import { resolveVideoRef } from '../lib/video-id.mjs'
const cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }
const outDir = dshPath('shots', 'covers')   // 以前写进代码目录 tools/covers：她读不到，还往代码树里塞文件
fs.mkdirSync(outDir, { recursive: true })

for (const arg of process.argv.slice(2)) {
  // av 号 / 视频链接 / b23.tv 短链先换成 BV 号（lib/video-id.mjs）；BV 号会拼进封面文件名，认不出来的照旧跳过
  const ref = await resolveVideoRef(arg)
  if (!ref.ok) { console.log(`${String(arg).slice(0, 40)}: ${ref.error}，跳过`); continue }
  const bv = ref.bvid
  if (ref.note) console.log(ref.note)
  try {
    const d = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H })).json()
    if (d.code !== 0) { console.log(`${bv}: code=${d.code} ${d.message}`); continue }
    const v = d.data
    const cover = path.join(outDir, `${bv}.jpg`)
    const img = await fetch(v.pic, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
    fs.writeFileSync(cover, Buffer.from(await img.arrayBuffer()))
    console.log(`\n===== ${bv} =====`)
    console.log(`标题: ${v.title}`)
    console.log(`UP: ${v.owner?.name} (mid ${v.owner?.mid})   播放=${v.stat?.view} 点赞=${v.stat?.like} 弹幕=${v.stat?.danmaku} 回复=${v.stat?.reply}`)
    console.log(`分区: ${v.tname}   时长=${v.duration}s   发布=${new Date(v.pubdate * 1000).toLocaleString('zh-CN')}`)
    console.log(`封面: ${cover}  (${(fs.statSync(cover).size / 1024).toFixed(0)} KiB)`)
    console.log(`简介: ${String(v.desc ?? '').slice(0, 400)}`)
  } catch (e) {
    console.log(`${bv}: 失败 ${e.message}`)
  }
}
