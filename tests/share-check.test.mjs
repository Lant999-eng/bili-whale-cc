// 分享评论（comment --share）核对「--bvid 就是 --oid 那个视频」—— 2026-10-25 修：
//   以前联网查不签名、不带登录的旧 /x/web-interface/view，B站 回 412 风控页，解析失败被报成「BV 号和 aid 对不上」，
//   她 @ 主人的分享连失败两次。BV 号和 aid 是固定的一一换算 → 现在本地算（bv2av），不联网（--go 时核对，和以前一样）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bv2av } from '../tools/lib/video-id.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const BV = 'BV1b4W1eeE2g'   // 虚构的 BV 号，只为测换算和核对（下面打错一位的 BV1b4W1eeE2z 也是）
const AID = bv2av(BV)   // 113024680135791（新式 BV，aid 超过 2^32）

function sandbox(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-share-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'portable/profile')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, listen: { comment: false, dm: false, live: false } }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test-buvid' }))
  return {
    ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'),
    TEST_REQUESTS: path.join(home, 'requests.jsonl'), REPLY_LOG: path.join(home, 'replies.log'), VIEW_AID: String(AID), SHARE_VIEW: 'ok',
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/share-view-fetch.mjs')).href, ...extraEnv,
  }
}
const run = (env, { oid = AID, bvid = BV, mode = '--go' } = {}) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment.mjs'), '--oid', String(oid), '--bvid', bvid, '--message', '@Owner 这条短片最后三十秒值得看',
    '--share', '--auto', '--reason', '这是值得分享的视频', '--score', '15', '--rank', '1', mode], { env, encoding: 'utf8', timeout: 30000 })
  assert.ifError(r.error)
  return { ...r, all: (r.stdout ?? '') + (r.stderr ?? '') }
}
const requests = (env) => fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const posted = (env) => fs.existsSync(env.REPLY_LOG) ? fs.readFileSync(env.REPLY_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0
const viewCalls = (env) => requests(env).filter((q) => /\/x\/web-interface\/(wbi\/)?view$/.test(q.path))

test('share check: a correct BV/oid pair goes through without looking the video up (B站 answers 412 to the old lookup)', (t) => {
  assert.equal(AID, 113024680135791)
  const env = sandbox(t)
  const r = run(env)
  assert.equal(r.status, 0, r.all)
  assert.equal(posted(env), 1, '发出去一条')
  assert.deepEqual(viewCalls(env), [], '不再联网查视频（BV↔aid 本地换算）')
  assert.doesNotMatch(r.all, /对不上|查不到/)
})

test('share check: a real mismatch is refused with the aid the BV stands for, and nothing is sent', (t) => {
  const env = sandbox(t)
  const r = run(env, { oid: 12345 })
  assert.equal(r.status, 2, r.all)
  assert.match(r.all, new RegExp(`是 aid ${AID} 那个视频，和 --oid 12345 对不上`))
  assert.equal(posted(env), 0)
  assert.deepEqual(viewCalls(env), [])
})

test('share check: a mistyped BV (decodes to some other aid) is refused as a mismatch, not as a network problem', (t) => {
  const env = sandbox(t)
  const typo = 'BV1b4W1eeE2z'
  assert.notEqual(bv2av(typo), AID)
  const r = run(env, { bvid: typo })
  assert.equal(r.status, 2, r.all)
  assert.match(r.all, /对不上/)
  assert.doesNotMatch(r.all, /查不到|暂时/)
  assert.equal(posted(env), 0)
})
