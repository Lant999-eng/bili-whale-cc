// 审片 / 频道设定：cli（videos 列表）和小窗的审核面板共用的那几样。只读：批准 / 退回照旧走 cli（小窗也是去跑 cli）。
//   这里给的都是原样的数据（她写的字没净化）：cli 显示前过 shown()，小窗服务发给页面前自己再净化、截短
import fs from 'node:fs'
import path from 'node:path'
import { listVideos, readMeta, videoFile } from './core.mjs'
import { channelStatus, submittedChannel, uploadPartitions, parseTid, subId } from '../tools/lib/studio.mjs'

export const VIDEO_ID_RE = /^[0-9A-Za-z_-]{3,80}$/           // 和 studio.projectDir 认的一样
export const SUB_RE = /^[0-9A-Za-z:._+-]{1,100}$/             // 这一轮交审的编号（studio.newSubmissionId；老的是 legacy-<交审时刻>）
const safely = (fn, d = null) => { try { return fn() } catch { return d } }

// 和 studio.py 的 TAG_MAX / TAG_LEN / DESC_MAX / AI_TAG / AI_NOTE 一样（tests/window-act.test.mjs 对着 studio.py 查）
export const TAG_MAX = 10, TAG_LEN = 20, DESC_MAX = 2000, AI_TAG = 'AI生成'
export const TAG_SHOW = TAG_MAX - 1   // 她的标签最多投几个（再加一个 AI生成）：审核面板和 cli 都只显示这么多
export const AI_NOTE = '本视频由 AI 自主创作：选题、文案、配音（语音合成）与画面均由 AI 生成，人类审核后发布。'
// Python 的空白（str.strip() 去的、re 的 \s 认的）。JS 的 trim() / \s 不一样：多一个 U+FEFF，少 \x1c-\x1f 和 \x85
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const PY_WS_CODES = new Set([...range(0x09, 0x0d), ...range(0x1c, 0x20), 0x85, 0xa0, 0x1680, ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
const PY_WS = '[' + [...PY_WS_CODES].map((c) => '\\u' + c.toString(16).padStart(4, '0')).join('') + ']'
const TAG_SPLIT = new RegExp(`(?:[,，、]|${PY_WS})+`, 'u')   // studio.py：re.split(r"[,，、\s]+", raw)
// 一个个字往里收（都在 BMP 里，按 UTF-16 看就行）：用正则的 /\s+$/ 碰上中间一大段空白会变得很慢
function pyStrip(s, { lead = true } = {}) {
  let a = 0, b = s.length
  if (lead) while (a < b && PY_WS_CODES.has(s.charCodeAt(a))) a += 1
  while (b > a && PY_WS_CODES.has(s.charCodeAt(b - 1))) b -= 1
  return s.slice(a, b)
}

/**
 * 审片快照里的剧本 → 会一起投上去的标签 / 简介 / 分区。整理规则和 studio.py upload_meta 一模一样（按字符数算长度：表情之类的字不会被算错）：
 * 标签写成一个字符串的按逗号 / 顿号 / 空白拆开；简介只投前 room 个字（后面要留给 AI 创作声明）—— desc 就是会投上去的那一截（不含声明），
 * descLen：她写的简介一共几个字，descDropped：投不上去的几个字。
 * part：分区名（照 bilibili_api 自带的分区表）；partKnown：分区表读到了没有（读到了、却对不上 = 不是投稿用的子分区，上传前会被挡下）
 */
export function uploadMeta(sc) {
  const seen = new Set(), tags = []
  const raw = typeof sc?.tags === 'string' ? sc.tags.split(TAG_SPLIT) : Array.isArray(sc?.tags) ? sc.tags : []
  for (const t0 of raw) {
    const t = pyStrip(String(t0).replace(/[,，]/g, '')).replace(/^#+/, '')
    if (!t || t === AI_TAG || seen.has(t) || [...t].length > TAG_LEN) continue
    seen.add(t); tags.push(t)
  }
  const body = [...pyStrip(sc?.desc ? String(sc.desc) : '')]
  const room = DESC_MAX - [...AI_NOTE].length - 2
  const desc = pyStrip(body.slice(0, room).join(''), { lead: false })   // 截完再 rstrip()
  const parts = uploadPartitions()
  return { tags, desc, descLen: body.length, descDropped: Math.max(0, body.length - room), tid: sc?.tid ?? null,
    part: parts?.get(parseTid(sc?.tid)) ?? null, partKnown: Boolean(parts) }
}

/** 快照里的剧本（就是会上传的那一份）；读不到 = null */
export function snapshotScript(id) {
  return safely(() => JSON.parse(fs.readFileSync(path.join(path.dirname(videoFile(id)), 'script.json'), 'utf8')))
}

/**
 * 等你审的视频：cli videos 列出来的那些，每条一张卡片的数据。
 * sub：这一轮交审的编号 —— 她退回后重交，id 不变、编号会变：小窗的按钮带着它，对不上就不替你批（批的得是你看到的那一版）
 */
export function videoCards() {
  const items = safely(() => listVideos(), [])
  return (Array.isArray(items) ? items : []).filter((it) => VIDEO_ID_RE.test(String(it?.id ?? ''))).map((it) => {
    const m = safely(() => readMeta(it.id), {}) ?? {}
    const sc = snapshotScript(it.id)
    const o = it.originality && typeof it.originality === 'object' ? it.originality : {}
    return {
      id: it.id, sub: (() => { const s = safely(() => subId(it)); return typeof s === 'string' && SUB_RE.test(s) ? s : null })(),
      title: String(it.title ?? ''), seconds: Number(it.seconds) || null, at: typeof it.at === 'string' ? it.at : null,
      reason: String(it.reason ?? ''),
      outfits: it.outfits && typeof it.outfits === 'object' && !Array.isArray(it.outfits) ? Object.entries(it.outfits).map(([k, v]) => [String(k), String(v)]) : [],
      checked: o.passed === true,                                        // false = 老版本交的，没查重
      flags: Array.isArray(o.flags) ? o.flags.map(String) : [],          // 和参考材料对得上的地方（没拦，你看一下）
      notes: Array.isArray(o.notes) ? o.notes.map(String) : [],
      references: Array.isArray(o.references) ? o.references.map((r) => String(r?.name ?? '')).filter(Boolean) : null,
      history: Array.isArray(m.history) ? m.history.map((h) => String(h?.note ?? '')).filter(Boolean).slice(-2) : [],
      meta: sc ? uploadMeta(sc) : null,
      hasFile: safely(() => fs.statSync(videoFile(it.id)).isFile(), false),
    }
  })
}

/**
 * 频道设定：她交上来等你确认的那一版（approve 要带它的指纹）；还没交就是草稿（确认不了）；都没有 = null。
 * state：waiting（等你确认）/ approved / rejected（你退回了，等她重交）/ draft；current：她现在文件里的那一版和交上来的是不是同一份
 */
export function channelCard() {
  const st = safely(() => channelStatus(), { state: 'none' })
  const subm = safely(() => submittedChannel())
  if (subm && typeof subm.text === 'string' && typeof subm.sha === 'string') {
    const state = st.approvedSha && st.approvedSha === subm.sha ? 'approved' : subm.rejectedAt ? 'rejected' : 'waiting'
    const current = st.state === 'none' ? 'missing' : subm.text === st.text ? 'same' : st.state === 'approved' ? 'other-approved' : 'other'
    return { kind: 'submitted', text: subm.text, sha: subm.sha, at: subm.at ?? null, state, current, approvedAt: st.approvedAt ?? null, rejectedAt: subm.rejectedAt ?? null }
  }
  if (st.state === 'none' || typeof st.text !== 'string') return null
  return { kind: 'draft', text: st.text, state: st.state === 'approved' ? 'approved' : 'draft', approvedAt: st.approvedAt ?? null }
}
