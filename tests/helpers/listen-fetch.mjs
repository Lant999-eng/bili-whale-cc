// 测试用（NODE_OPTIONS=--import 预加载）：「听」那条命令要的几样接口 ——
//   /x/web-interface/view → 一条 300 秒的单 P 视频（LISTEN_PARTS=2 → 两 P，P1 120 秒）
//   /x/player/playurl → dash 声音流两条（码率高的在前，命令要挑码率低的那条）；LISTEN_PLAYURL=none → 没有声音流
//   声音地址 → 回 LISTEN_AUDIO_FILE 的字节（照 Range 截；LISTEN_IGNORE_RANGE=1 → 不理 Range，整条都给）
//   TEST_REQUESTS：每个请求记一行（路径、range 头、fnval）
import fs from 'node:fs'

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })
export const LOW = 'https://upos-fake.bilivideo.com/audio-low.m4s', HIGH = 'https://upos-fake.bilivideo.com/audio-high.m4s'

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url))
  const range = opts.headers?.range ?? opts.headers?.Range ?? null
  if (process.env.TEST_REQUESTS) fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ host: u.host, path: u.pathname, range, fnval: u.searchParams.get('fnval') }) + '\n')
  if (u.pathname === '/x/web-interface/nav') {   // WBI 签名要的密钥（apiGet 会先来拿）
    return json({ code: 0, data: { isLogin: true, uname: '测试角色', mid: 1, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })
  }
  if (u.pathname === '/x/web-interface/view' || u.pathname === '/x/web-interface/wbi/view') {
    const two = process.env.LISTEN_PARTS === '2'
    return json({ code: 0, data: { aid: 170001, bvid: u.searchParams.get('bvid'), cid: 111, title: '测试视频', duration: two ? 400 : 300,
      owner: { mid: 42, name: '某 UP' }, pages: two ? [{ cid: 111, duration: 120 }, { cid: 112, duration: 280 }] : [{ cid: 111, duration: 300 }] } })
  }
  if (u.pathname === '/x/player/playurl' || u.pathname === '/x/player/wbi/playurl') {
    if (process.env.LISTEN_PLAYURL === 'none') return json({ code: -404, message: '啥都木有', data: null })
    return json({ code: 0, data: { dash: { audio: [
      { id: 30280, bandwidth: 320000, baseUrl: HIGH, backupUrl: [] },
      { id: 30216, bandwidth: 64000, base_url: LOW, backup_url: ['https://upos-fake-backup.bilivideo.com/audio-low.m4s'] },
    ] } } })
  }
  if (u.host.endsWith('bilivideo.com')) {
    const all = fs.readFileSync(process.env.LISTEN_AUDIO_FILE)
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(range ?? ''))
    const body = m && process.env.LISTEN_IGNORE_RANGE !== '1' ? all.subarray(Number(m[1]), m[2] ? Number(m[2]) + 1 : undefined) : all
    return new Response(body, { status: m && process.env.LISTEN_IGNORE_RANGE !== '1' ? 206 : 200, headers: { 'content-type': 'video/mp4' } })
  }
  return json({ code: 0, data: {} })
}
