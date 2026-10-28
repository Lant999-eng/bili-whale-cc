// 评论里的图（tools/commands/comment-images.mjs）：只看 TA 那一条的图 —— 楼中楼绝不拿楼主的图顶替；
// 有图 / 没图 / 下载失败 / 找不到评论 各有清楚的说法；图只从 B站 图床下、下到她能看的 shots 目录；同一张图不重复下
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))

const IMG = (n) => `http://i0.hdslb.com/bfs/new_dyn/pic${n}.png`
const top = (pics = []) => ({ rpid: 1001, rpid_str: '1001', mid: 501, root: 0, parent: 0, content: { message: '楼主说：看我的猫', pictures: pics.map((p) => ({ img_src: p, img_width: 904, img_height: 1095, img_size: 537 })) } })
const sub = (rpid, mid, msg, pics = []) => ({ rpid: Number(rpid), rpid_str: String(rpid), mid, root: 1001, parent: 1001, content: { message: msg, pictures: pics.map((p) => ({ img_src: p, img_width: 800, img_height: 600, img_size: 100 })) } })

function sandbox(t, spec) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-pics-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'SECRET_SESSDATA_VALUE_123456', bili_jct: 'c'.repeat(32), buvid3: '' }))
  const specFile = path.join(home, 'pics.json')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: path.join(home, 'data'), BILI_WHALE_CONFIG: path.join(home, 'data', 'c.json'), BILI_NO_CACHE: '1',
    TEST_PICS_FILE: specFile, TEST_REQUESTS: path.join(home, 'req.jsonl'), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/reply-pics-fetch.mjs')).href }
  const set = (s) => fs.writeFileSync(specFile, JSON.stringify(s))
  set(spec)
  const run = (...args) => {
    try { fs.rmSync(env.TEST_REQUESTS, { force: true }) } catch {}
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'bili.mjs'), 'comment-images', ...args], { env, encoding: 'utf8', timeout: 60_000 })
    const reqs = fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l).url) : []
    return { code: r.status, out: r.stdout + r.stderr, reqs }
  }
  return { env, set, run, imgDir: path.join(env.DSH_HOME, 'shots', 'comment-img') }
}

test('a reply in a thread gets ITS OWN pictures, never the thread starter\'s — even when only its rpid is given', (t) => {
  const s = sandbox(t, { root: top([IMG(1), IMG(2)]), replies: [sub(2001, 601, '路过'), sub(2002, 602, '我也有一张', [IMG(9)])] })
  // TA 的楼中楼没有图：说没有，不拿楼主的两张
  let r = s.run('--oid', '7', '--rpid', '2001', '--root', '1001', '--type', '1')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /楼中楼/); assert.match(r.out, /没有附图/)
  assert.ok(!r.reqs.some((u) => u.includes('pic1') || u.includes('pic2')), '不该去下楼主的图')
  // 只给了楼中楼自己的 rpid（root 不知道）：接口回的 data.root 是楼主那条 —— 照样认得出来
  r = s.run('--oid', '7', '--rpid', '2001')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /没有附图/); assert.ok(!r.reqs.some((u) => u.includes('pic1')))
  // 楼中楼自己带图：只下它自己的
  r = s.run('--oid', '7', '--rpid', '2002', '--root', '1001', '--json')
  const j = JSON.parse(r.out)
  assert.equal(j.where, '楼中楼'); assert.equal(j.total, 1); assert.equal(j.images[0].status, 'downloaded')
  assert.ok(r.reqs.some((u) => u.includes('pic9'))); assert.ok(!r.reqs.some((u) => u.includes('pic1') || u.includes('pic2')))
  // 楼主自己那条（顶层）：下楼主的图
  r = s.run('--oid', '7', '--rpid', '1001', '--root', '0', '--json')
  assert.equal(JSON.parse(r.out).where, '顶层评论'); assert.equal(JSON.parse(r.out).total, 2)
})

test('the reply is found on a later page (newest last), and a missing / deleted one says "don\'t know" instead of guessing', (t) => {
  const many = Array.from({ length: 65 }, (_, i) => sub(3000 + i, 700 + i, '第' + i + '条'))
  many[63] = sub(3063, 763, '看这个', [IMG(5)])
  const s = sandbox(t, { root: top([IMG(1)]), replies: many })
  let r = s.run('--oid', '7', '--rpid', '3063', '--root', '1001', '--json')
  const j = JSON.parse(r.out)
  assert.equal(j.found, true); assert.equal(j.total, 1); assert.equal(j.images[0].status, 'downloaded')
  assert.ok(r.reqs.some((u) => u.includes('pn=4')), '应从最后一页往前找')
  // 楼里没有这条
  r = s.run('--oid', '7', '--rpid', '9999', '--root', '1001')
  assert.equal(r.code, 3); assert.match(r.out, /没找到这条评论/); assert.match(r.out, /别猜/)
  assert.ok(!r.reqs.some((u) => /hdslb/.test(u)), '找不到就一张图都不下')
  // 接口出错
  s.set({ root: top([IMG(1)]), replies: [], code: -404 })
  r = s.run('--oid', '7', '--rpid', '1001')
  assert.equal(r.code, 3); assert.match(r.out, /code=-404/); assert.match(r.out, /不知道它有没有附图/)
})

test('--mid: a comment that is not from that person is refused (wrong coordinates), nothing downloaded', (t) => {
  const s = sandbox(t, { root: top([IMG(1)]), replies: [sub(2001, 601, 'hi', [IMG(3)])] })
  let r = s.run('--oid', '7', '--rpid', '2001', '--root', '1001', '--mid', '999')
  assert.equal(r.code, 3); assert.match(r.out, /不是 mid 999 发的/); assert.ok(!r.reqs.some((u) => /hdslb/.test(u)))
  r = s.run('--oid', '7', '--rpid', '2001', '--root', '1001', '--mid', '601')
  assert.equal(r.code, 0); assert.match(r.out, /下好了/)
})

test('--mid beyond 2^53: mid_str / rpid_str are used, so the right person is accepted and the neighbouring id is refused', (t) => {
  // 回包里 mid / rpid 是不带引号的 JSON 数字，JSON.parse 后 9007199254740993 会变成 ...992；mid_str / rpid_str 是精确的
  const BIG = '9007199254740993', NEAR = '9007199254740992'
  const big = { ...sub(BIG, 0, '大号', [IMG(3)]), rpid: '#raw:' + BIG, mid: '#raw:' + BIG, mid_str: BIG }
  const s = sandbox(t, { root: top([IMG(1)]), replies: [big] })
  let r = s.run('--oid', '7', '--rpid', BIG, '--root', '1001', '--mid', BIG, '--json')
  assert.equal(r.code, 0, r.out)
  const j = JSON.parse(r.out)
  assert.equal(j.mid, BIG); assert.equal(j.images[0].status, 'downloaded'); assert.ok(r.reqs.some((u) => u.includes('pic3')))
  // 数字失真后的那个邻居编号不能蒙混过关（--mid 按字符串比，不走 Number）
  r = s.run('--oid', '7', '--rpid', BIG, '--root', '1001', '--mid', NEAR)
  assert.equal(r.code, 3, r.out); assert.match(r.out, new RegExp(`不是 mid ${NEAR} 发的（是 mid ${BIG}）`)); assert.ok(!r.reqs.some((u) => /hdslb/.test(u)))
  // 顶层那条（data.root）也一样
  s.set({ root: { ...top([IMG(1)]), mid: '#raw:' + BIG, mid_str: BIG }, replies: [] })
  r = s.run('--oid', '7', '--rpid', '1001', '--mid', BIG, '--json')
  assert.equal(r.code, 0, r.out); assert.equal(JSON.parse(r.out).mid, BIG)
  // 假回包确实会失真（不然上面测了等于没测）：只给数字 mid 时读出来就是 ...992，对不上就拒绝
  s.set({ root: { ...top([IMG(1)]), mid: '#raw:' + BIG }, replies: [] })
  r = s.run('--oid', '7', '--rpid', '1001', '--mid', BIG)
  assert.equal(r.code, 3, r.out); assert.match(r.out, new RegExp(`是 mid ${NEAR}`))
  // 没有 mid / mid_str 时退回 member.mid
  s.set({ root: top([]), replies: [{ ...sub(2001, 0, 'hi'), mid: undefined, member: { mid: '601' } }] })
  r = s.run('--oid', '7', '--rpid', '2001', '--root', '1001', '--mid', '601')
  assert.equal(r.code, 0, r.out)
})

test('each picture gets a clear result: small version, fallback to original, failed with reason, skipped over --max, cached on the second run', (t) => {
  const s = sandbox(t, { root: top([IMG(1), IMG(2), IMG(3), IMG(4), IMG(5), IMG(6)]), replies: [],
    imgs: { [IMG(1)]: 'jpg', [IMG(2)]: 'small404', [IMG(3)]: '404', [IMG(4)]: 'html', [IMG(5)]: 'big', [IMG(6)]: 'jpg' } })
  let r = s.run('--oid', '7', '--rpid', '1001', '--max', '5', '--json')
  const j = JSON.parse(r.out)
  assert.equal(j.total, 6)
  const st = j.images.map((x) => x.status)
  assert.deepEqual(st, ['downloaded', 'downloaded', 'failed', 'failed', 'failed', 'skipped'])
  assert.equal(j.images[0].small, true); assert.equal(j.images[1].small, false)   // 缩小版 404 → 退回原图（png）
  assert.match(j.images[1].file, /\.png$/)
  assert.match(j.images[2].why, /HTTP 404/); assert.match(j.images[3].why, /不是图片/); assert.match(j.images[4].why, /太大/)
  // 图下到她能看的 shots/comment-img，用 https、带 referer 的缩小版
  for (const x of j.images.filter((i) => i.file)) { assert.ok(x.file.startsWith(s.imgDir)); assert.ok(fs.statSync(x.file).size > 0) }
  assert.ok(r.reqs.every((u) => !u.startsWith('http://')), '图片一律走 https')
  assert.ok(r.reqs.some((u) => u.endsWith('pic1.png@1280w_1e.jpg')))
  assert.deepEqual(fs.readdirSync(s.imgDir).filter((f) => f.endsWith('.tmp')), [])
  // 人读的输出：每张一句
  r = s.run('--oid', '7', '--rpid', '1001', '--max', '5')
  assert.match(r.out, /第 1 张（原图 904×1095）：之前下过，用缓存/)
  assert.match(r.out, /第 3 张.*没下成（HTTP 404）—— 这张你没看到/)
  assert.match(r.out, /第 6 张.*没下（只下前 5 张/)
  assert.match(r.out, /没看到的别描述、别猜/)
  // 第二次：下过的两张不再请求
  assert.ok(!r.reqs.some((u) => u.includes('pic1') || u.includes('pic2')))
})

test('only Bilibili image hosts are fetched; bad arguments are refused; the cookie never goes to the image host or the output', (t) => {
  const s = sandbox(t, { root: top(['http://evil.example.com/x.png', 'https://i0.hdslb.com.evil.com/a.png', IMG(1)]), replies: [] })
  let r = s.run('--oid', '7', '--rpid', '1001', '--json')
  const j = JSON.parse(r.out)
  assert.deepEqual(j.images.map((x) => x.status), ['failed', 'failed', 'downloaded'])
  assert.ok(!r.reqs.some((u) => u.includes('evil')))
  assert.ok(!r.out.includes('SECRET_SESSDATA_VALUE'))
  for (const bad of [['--oid', 'x', '--rpid', '1'], ['--oid', '7'], ['--oid', '7', '--rpid', '1', '--root', '1;rm'], ['--oid', '7', '--rpid', '1', '--type', 'abc']]) {
    r = s.run(...bad)
    assert.equal(r.code, 2, bad.join(' ')); assert.equal(r.reqs.length, 0)
  }
  // 评论原文里的控制字符不进输出
  s.set({ root: { ...top([]), content: { message: 'a\u001b[2Jb\u202ec', pictures: [] } }, replies: [] })
  r = s.run('--oid', '7', '--rpid', '1001')
  assert.ok(!/[\u001b\u202e]/.test(r.out))
})

test('a half-written .tmp is never served as a cached picture; an over-size picture without Content-Length is refused; pictures are written atomically', (t) => {
  const s = sandbox(t, { root: top([IMG(1), IMG(2)]), replies: [], imgs: { [IMG(2)]: 'bignolen' } })
  const base = `1001-1-${crypto.createHash('sha1').update(IMG(1).replace(/^http:/, 'https:')).digest('hex').slice(0, 10)}`
  fs.mkdirSync(s.imgDir, { recursive: true })
  fs.writeFileSync(path.join(s.imgDir, `${base}.jpg.12345.tmp`), 'partial')
  s.env.TEST_FS_LOG = path.join(s.env.USERPROFILE, 'fs.jsonl')
  const r = s.run('--oid', '7', '--rpid', '1001', '--json')
  const j = JSON.parse(r.out)
  assert.equal(j.images[0].status, 'downloaded'); assert.ok(!j.images[0].file.endsWith('.tmp'))
  assert.equal(j.images[1].status, 'failed'); assert.match(j.images[1].why, /太大/)
  assert.ok(!fs.readdirSync(s.imgDir).some((f) => f.startsWith('1001-2-')), '太大的那张一个字节都不留')
  const ops = fs.readFileSync(s.env.TEST_FS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(!ops.some((o) => o.op === 'write' && o.f === j.images[0].file), '图片不能直接写到最终路径')
  assert.ok(ops.some((o) => o.op === 'rename' && o.to === j.images[0].file))
  assert.equal(s.run('--oid', '7', '--rpid', '1001', '--mid', 'abc').code, 2)
})

test('a very long thread stops after 10 pages ("楼太长"); an API error on a later page is reported, not guessed around', (t) => {
  const s = sandbox(t, { root: top([IMG(1)]), replies: Array.from({ length: 1000 }, (_, i) => sub(5000 + i, 900, 'x')) })
  let r = s.run('--oid', '7', '--rpid', '9999', '--root', '1001')
  assert.equal(r.code, 3); assert.match(r.out, /楼太长/)
  assert.ok(r.reqs.filter((u) => u.includes('/reply/reply')).length <= 10)
  assert.ok(!r.reqs.some((u) => /hdslb/.test(u)))
  s.set({ root: top([IMG(1)]), replies: Array.from({ length: 65 }, (_, i) => sub(6000 + i, 900, 'x')), failFromPage: 2 })
  r = s.run('--oid', '7', '--rpid', '9999', '--root', '1001')
  assert.equal(r.code, 3); assert.match(r.out, /code=-412/); assert.match(r.out, /翻到第 4 页/); assert.match(r.out, /别猜/)
})

test('a slow image host cannot make the command hang: results are printed as they come, the rest is marked "没来得及下"', (t) => {
  const s = sandbox(t, { root: top([IMG(1), IMG(2), IMG(3)]), replies: [], imgs: { [IMG(1)]: 'slow', [IMG(2)]: 'slow', [IMG(3)]: 'slow' } })
  s.env.COMMENT_IMAGES_DEADLINE_S = '1'
  const t0 = Date.now()
  const r = s.run('--oid', '7', '--rpid', '1001')
  assert.equal(r.code, 0, r.out); assert.ok(Date.now() - t0 < 15_000)
  assert.match(r.out, /第 1 张.*没下成（超时）/); assert.match(r.out, /没来得及下/)
  assert.match(r.out, /附了 3 张图/); assert.match(r.out, /没看到的别描述、别猜/)
})

test('slow comment pages count against the overall limit; output is printed while the pictures are still downloading; --json says ok / not ok', async (t) => {
  const s = sandbox(t, { root: top([IMG(1)]), replies: Array.from({ length: 65 }, (_, i) => sub(7000 + i, 900, 'x')), slowPages: 60000 })
  s.env.COMMENT_IMAGES_DEADLINE_S = '2'
  const t0 = Date.now()
  let r = s.run('--oid', '7', '--rpid', '9999', '--root', '1001')
  assert.equal(r.code, 3, r.out); assert.ok(Date.now() - t0 < 15_000, '翻楼也要在总时限里收住'); assert.match(r.out, /别猜/)
  r = s.run('--oid', '7', '--rpid', '9999', '--root', '1001', '--json')
  assert.equal(JSON.parse(r.out).ok, false)
  // 边下边说：第一张的结果在命令结束前就打出来
  s.set({ root: top([IMG(1), IMG(2), IMG(3)]), replies: [], imgs: { [IMG(1)]: 'slow', [IMG(2)]: 'slow', [IMG(3)]: 'slow' } })
  s.env.COMMENT_IMAGES_DEADLINE_S = '60'
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [path.join(root, 'tools', 'bili.mjs'), 'comment-images', '--oid', '7', '--rpid', '1001'], { env: s.env })
  let firstAt = null, out = ''
  child.stdout.on('data', (d) => { out += d; if (firstAt == null && out.includes('第 1 张')) firstAt = Date.now() })
  const exitAt = await new Promise((res) => child.on('close', () => res(Date.now())))
  assert.ok(firstAt != null, out); assert.ok(exitAt - firstAt >= 1000, `第 1 张的结果 ${exitAt - firstAt}ms 前才出来`)
  r = s.run('--oid', '7', '--rpid', '1001', '--json')
  assert.equal(JSON.parse(r.out).ok, true)
})
