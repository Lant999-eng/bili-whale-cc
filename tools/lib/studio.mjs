// 工作室的共用部分（她的 `studio` 命令 和 主人的 `cli.mjs videos` 都用）
//
//   <数据目录>/whale-work/studio/<作品id>/   一个作品：script.json（她写）· meta.json（只是显示用的状态，她能改，不当依据）· final.mp4 · cover.jpg
//   ~/.bili-ai/review/<作品id>/        审片快照 + 交审 / 发布的账（她写不到；名额、集数、防重投都看这里）
//   ~/.bili-ai/renders/<作品id>.json   渲染回执
//   <项目目录>/.studio-venv/           Python 侧依赖（edge-tts / pillow / imageio-ffmpeg / bilibili-api）
//                                     ⚠️ 故意不放数据目录：她能写数据目录，而主人批准投稿时会跑这里的 Python
//   ~/.bili-ai/pending-videos.json     等主人审的成片
//   ~/.bili-ai/image-api-key           AI 配图的 key（只存这里，不进配置文件、不回显）
//
// 硬限制（写在这里，不靠她自觉）：
//   · 发视频只有主人 `videos approve` 一条路 —— 她的工具里没有上传
//   · 每 7 天最多 studio.maxPerWeek 条（已发 + 在审都算）· 同时在审最多 2 条
//   · 时长 15 秒 ~ studio.maxSeconds · 必须选分区 · 提交要写理由
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DSH_HOME, HOME, AI_HOME, aiPath, dshPath, pathInside } from './paths.mjs'
import { config } from './config.mjs'
import { withFileLock, pidAlive, procName, renameRetry } from './filelock.mjs'

export const STUDIO_DIR = aiPath('studio')                 // 作品稿子：她写 script.json，渲染结果也在这里
export const CAST_DIR = path.join(DSH_HOME, 'cast')        // 角色：cast/<id>/profile.json · ref*.png（主人给的参考图）· sprites/<换装>/<表情>.png（老的 sprites/<表情>.png 也认；profile.outfit = 默认换装）
export const BGM_DIR = path.join(DSH_HOME, 'bgm')          // 背景音乐：只放主人确认能用的音乐
export const CACHE_DIR = dshPath('cache', 'images')        // AI 出图缓存（按提示词 + 参考图）—— 她写不到，免得被换图
export const TTS_CACHE_DIR = dshPath('cache', 'tts')       // 配音缓存（mp3 + 字幕时间轴）—— 同理：以前在她的 build/ 里，改了字幕文字会被烧进成片
export const STATS_DIR = dshPath('stats')                  // studio stats 的存档
export const SUBS_DIR = path.join(DSH_HOME, 'shots', 'subs') // 她看过的视频字幕（查重用）

// ─────────────── 频道设定：她自己提，主人确认 ───────────────
//   <数据目录>/whale-work/channel.md            她写的频道设定（定位 / 内容方向 / 栏目 / 封面风格 / 和别的 AI UP 主的区别）
//   <数据目录>/whale-work/channel-feedback.md   主人没通过时的意见（她下次改设定时读）
//   ~/.bili-ai/channel-approved.json 主人确认过的那一版的指纹 —— 她写不到这个目录；设定一改指纹就对不上，要重新确认
export const CHANNEL_FILE = aiPath('channel.md')
export const CHANNEL_FEEDBACK = aiPath('channel-feedback.md')
export const CHANNEL_APPROVAL = path.join(HOME, '.bili-ai', 'channel-approved.json')

export const CHANNEL_TEMPLATE = `# 我的频道设定（草稿）

<!-- 你自己写，写完跑 studio channel submit，主人确认后才能交审视频。改了要重新确认。 -->

## 一句话定位
（这个频道是什么、为什么值得关注 —— 用你自己的话）

## 想讲给谁听

## 内容方向
（你最想做的 2–3 类内容。每一类：讲什么、为什么只有你能讲、大概多长、多久一条）

## 栏目 / 系列（可以没有）
（如果要做系列：系列叫什么、编号方式。别用别人用过的系列名和标题句式）

## 角色与说话方式
（主角是谁、性格、口吻；其他角色是谁、和主角什么关系）

## 封面与画面风格
（色调、构图、封面字怎么放 —— 要一眼认得出是你的，不像任何别的号）

## 和已有的 AI UP 主有什么不同
（必填。B站 上已经有 AI 自己运营的账号了：你知道的有哪些、他们在做什么、你**不做**什么、你的不同在哪）

## 不做的事
`

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/**
 * 她**现在文件里**那一版的状态：none = 还没写 · draft = 写了没确认 · approved = 主人确认的就是这一版 · changed = 确认后又改过。
 * approvedSha = 主人确认的是哪一版（主人那边显示「交上来的那一版」的状态要拿它比，不能拿这里的 state —— 文件和交上来的可能不是同一版）
 */
export function channelStatus() {
  let text = ''
  const appr = readJson(CHANNEL_APPROVAL, null)
  try { text = fs.readFileSync(CHANNEL_FILE, 'utf8') } catch { return { state: 'none', approvedAt: appr?.at, approvedSha: appr?.sha } }
  if (!appr?.sha) return { state: 'draft', text }
  return { state: appr.sha === sha(text) ? 'approved' : 'changed', text, approvedAt: appr.at, approvedSha: appr.sha }
}

// 她交给主人确认的那一版（studio channel submit 时由工具存进 ~/.bili-ai，她写不到）。
// 主人看的、确认的都是这一版 —— 以前确认的是「确认那一刻文件里写着什么」，她交了 A、主人读的是 A、确认前她改成 B，确认的就成了 B
export const CHANNEL_SUBMITTED = path.join(HOME, '.bili-ai', 'channel-submitted.json')
export function submitChannel(text) { const s = sha(text); writeJson(CHANNEL_SUBMITTED, { text, sha: s, at: new Date().toISOString() }); return s }
export const submittedChannel = () => readJson(CHANNEL_SUBMITTED, null)

/**
 * 确认：必须带上主人看到的那一版的指纹（`cli channel` 会显示）—— 他看完之后她又交了一版，指纹就对不上，确认不了
 * （以前确认的是「确认那一刻交上来的那一版」：她在主人看和确认之间重交一次，主人确认的就是他没看过的版本）
 */
export function approveChannel(expectSha) {
  const sub = submittedChannel()
  if (!sub?.sha || typeof sub.text !== 'string') return { ok: false, error: '她还没把频道设定交给你确认（她要先 studio channel submit）' }
  if (sha(sub.text) !== sub.sha) return { ok: false, error: '交上来的那一版记录对不上，让她重新交一次' }
  const want = String(expectSha ?? '').trim().toLowerCase()
  if (want.length < 8 || !sub.sha.startsWith(want)) {
    return { ok: false, error: '要带上你看到的那一版的指纹：先 node host/cli.mjs channel 看一遍，再 channel approve <指纹>（她在你看完之后又交过的话，指纹就变了）' }
  }
  writeJson(CHANNEL_APPROVAL, { sha: sub.sha, at: new Date().toISOString() })
  if (sub.rejectedAt) { const { rejectedAt, ...rest } = sub; writeJson(CHANNEL_SUBMITTED, rest) }   // 退回过、后来又确认了：以确认为准
  try { fs.rmSync(CHANNEL_FEEDBACK, { recursive: true, force: true }) } catch {}
  const now = channelStatus()
  return { ok: true, changedSince: now.state === 'changed' }
}

/** 退回：先撤掉主人那边的确认（这一步不能被她家里的文件挡住），再把意见写给她（写不进去也不影响退回） */
export function rejectChannel(note) {
  fs.rmSync(CHANNEL_APPROVAL, { force: true })
  const sub = submittedChannel()
  if (sub) writeJson(CHANNEL_SUBMITTED, { ...sub, rejectedAt: new Date().toISOString() })   // 被退回的那一版不再算「等你确认」
  let feedback = true
  try {
    fs.rmSync(CHANNEL_FEEDBACK, { recursive: true, force: true })   // 她在那个位置放了个目录之类的，也不能挡住
    fs.mkdirSync(path.dirname(CHANNEL_FEEDBACK), { recursive: true })
    fs.writeFileSync(CHANNEL_FEEDBACK, `# 主人对频道设定的意见（${new Date().toLocaleString('zh-CN')}）\n\n${String(note || '（没写理由）')}\n`)
  } catch { feedback = false }
  return { ok: true, feedback }
}
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const VENV_DIR = process.env.BILI_WHALE_STUDIO_VENV || path.join(PROJECT_ROOT, '.studio-venv')
export const PENDING_VIDEOS = path.join(HOME, '.bili-ai', 'pending-videos.json')
export const IMAGE_KEY_FILE = path.join(HOME, '.bili-ai', 'image-api-key')
export const STUDIO_PY = path.join(PROJECT_ROOT, 'studio', 'studio.py')

export const STUDIO_DEFAULTS = {
  enabled: true,
  host: '',                        // 主角的角色 id（cast/<id>）；空 = 第一个角色
  series: '',                      // 默认不进任何系列；栏目名由她在频道设定里自己定，做视频时用 --series 指定
  style: '',                       // 统一画风，比如 "soft anime illustration, warm light"
  voice: 'zh-CN-XiaoxiaoNeural',   // 没有角色时的旁白音色
  rate: '+0%',
  maxPerWeek: 3,                   // 每 7 天最多交审几条（只是上限；节奏按她的频道设定来；新装默认 3，想多就 config set studio.maxPerWeek 7）
  maxSeconds: 1200,                // 最长 20 分钟（睡前故事要长一点）
  dynamicDaily: 2,
  bgmVolume: 0.16,                 // 背景音乐（先统一到和人声一样的响度）再压到多少：0.16 ≈ 比人声低 16 dB（主人 2026-10-25 试听定的）
  bgmSynth: true,                  // 没用主人放的音乐时，自动用代码合成一段（studio/bgm_synth.py；不下载、没有版权问题）。false = 不合成
  font: '',
  aiStatement: '作者声明：该视频使用人工智能合成技术',   // 必须是 B站 预设的原文（bilibili_api 的 video_uploader_meta_pre.json 里那 6 条之一）
  avoidCreators: [],               // 「别碰」的 UP 主 mid：她的标题跟他们的视频太像就拦
  image: { provider: 'none', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst', quality: 'medium', maxPerVideo: 12 },   // gpt-image-1 已于 2026-10-23 停用
  tts: { model: 'gpt-4o-mini-tts', baseUrl: '' },   // 角色设了 tts=openai 时用（和画图共用 OpenAI key）
  // 角色设了 tts=voxcpm 时用：主人自己装的 VoxCPM 虚拟环境里的 python.exe + VoxCPM2 模型目录（本地、免费，要 NVIDIA 显卡）。
  // 默认留空：这里的默认值会在下次 config set 时整份写进配置文件，不能放某台机器上的路径
  voxcpm: { python: '', model: '' },
}

/** 交给 studio.py 的渲染配置 */
export function renderConfig() {
  const s = studioConfig()
  return { voice: s.voice, rate: s.rate, font: s.font, image: s.image, tts: { ...STUDIO_DEFAULTS.tts, ...(s.tts ?? {}) }, voxcpm: { ...STUDIO_DEFAULTS.voxcpm, ...(s.voxcpm ?? {}) },
    host: s.host, style: s.style, bgmVolume: s.bgmVolume, bgmSynth: s.bgmSynth !== false,
    cast_dir: CAST_DIR, bgm_dir: BGM_DIR, cache_dir: CACHE_DIR, tts_cache_dir: TTS_CACHE_DIR, subs_dir: SUBS_DIR, avoidCreators: s.avoidCreators ?? [] }
}

/**
 * VoxCPM 本地配音的配置有什么问题（没问题 = null）。主人的试听和她的渲染都会跑这个 Python、加载这个模型（torch 读权重能执行代码）——
 * 所以两样都必须在、写绝对路径，而且不能在她能写的家里（不然她换掉 python.exe / 权重 = 在主人的进程里跑她的代码）
 */
export function voxcpmProblem(v = studioConfig().voxcpm ?? {}) {
  const py = String(v?.python ?? '').trim(), model = String(v?.model ?? '').trim()
  if (!py) return '没配 VoxCPM 的 Python：node host/cli.mjs config set studio.voxcpm.python <VoxCPM 虚拟环境里的 python.exe>'
  if (!model) return '没配 VoxCPM2 模型目录：node host/cli.mjs config set studio.voxcpm.model <模型目录>'
  const why = voxcpmPathProblem('python', py) ?? voxcpmPathProblem('model', model)
  if (why) return why
  if (!fs.statSync(py, { throwIfNoEntry: false })?.isFile()) return `VoxCPM 的 Python 不在：${py}`
  if (!fs.statSync(model, { throwIfNoEntry: false })?.isDirectory()) return `VoxCPM2 模型目录不在：${model}`
  return null
}

/**
 * 交给 studio.py 的配音配置：去掉首尾空白以后查一遍，交过去的就是查过的这一份（第五轮审查：以前查的是 trim 过的，交过去的却是原样的）。
 * → { voxcpm: { python, model }, why }（why 不是 null 就别把它交出去）
 */
export function checkedVoxcpm(v = studioConfig().voxcpm ?? {}) {
  const voxcpm = { python: String(v?.python ?? '').trim(), model: String(v?.model ?? '').trim() }
  // 显卡门槛和等待时间（主人可调，见 studio.py 的 _gpu_busy / _voxcpm_synthesize）：只交范围内的数字，别的不交（studio.py 用默认值）。
  // 以前这里只交 python / model，这几项配了也不生效（2026-10-25 第一条视频前的审查）
  for (const [k, [lo, hi]] of Object.entries(VOXCPM_TUNING)) {
    const raw = v?.[k]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN
    if (Number.isFinite(n) && n >= lo && n <= hi) voxcpm[k] = n
  }
  return { voxcpm, why: voxcpmProblem(voxcpm) }
}
/**
 * 可调的几项 → [下限, 上限]：minFreeMB 空闲显存够多少 MB 才开配；maxBusyPct 显卡一直高于这个占用率就不配；idleTimeout 秒，一句也没配完就算卡死；
 * lockWait 秒，等别的配音让出显卡。上限故意压在外面的超时里面（试听 15 分钟、渲染 30 分钟会把 studio.py 整个停掉，
 * 但它起的配音进程不跟着停）：等锁 + 加载模型 + 卡死判定一定在那之前到，配音进程由 studio.py 自己收掉
 */
export const VOXCPM_TUNING = { minFreeMB: [0, 65536], maxBusyPct: [0, 100], idleTimeout: [1, 600], lockWait: [0, 120] }

/**
 * 剧本里的分区号 → 整数；不认的一律 NaN。和 studio.py 的 parse_tid 同一个规矩：正整数（JSON 里写 21.0 解析出来也是 21），
 * 或者只有 ASCII 数字的字符串（前后可以有空白）；"21.0"、"0x15"、"2e1"、[21]、true 都不认 —— 两边认的一样，交审放过的上传也认
 */
export function parseTid(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : NaN
  // 前后只认 ASCII 的空格 / 制表 / 换行：JS 的 \s 还认 BOM、全角空格这些，Python 的不认 —— 两边就对不上了（第二轮审查）
  if (typeof v === 'string' && /^[ \t\r\n]*[0-9]+[ \t\r\n]*$/.test(v)) return Number(v.replace(/[ \t\r\n]/g, ''))
  return NaN
}

let partitionsCache
/**
 * B站 投稿页的分区表（工作室虚拟环境里 bilibili_api 自带的 video_uploader_meta_pre.json，studio.py 上传前也按它查）：
 * Map<子分区 id, '大区·子分区'>。找不到 / 读不了 → null（那就不拿它挡；studio.py 上传前还会再查一次）
 */
export function uploadPartitions() {
  if (partitionsCache !== undefined) return partitionsCache
  const rel = ['bilibili_api', 'data', 'video_uploader_meta_pre.json']
  const cands = [path.join(VENV_DIR, 'Lib', 'site-packages', ...rel)]
  try { for (const d of fs.readdirSync(path.join(VENV_DIR, 'lib'))) if (/^python\d/.test(d)) cands.push(path.join(VENV_DIR, 'lib', d, 'site-packages', ...rel)) } catch {}
  partitionsCache = null
  for (const f of cands) {
    try {
      const pre = JSON.parse(fs.readFileSync(f, 'utf8'))
      const m = new Map()
      for (const p of Array.isArray(pre?.tid_list) ? pre.tid_list : []) {
        for (const c of Array.isArray(p?.children) ? p.children : []) if (Number.isInteger(c?.id)) m.set(c.id, `${p.name ?? ''}·${c.name ?? ''}`)
      }
      if (m.size) { partitionsCache = m; break }
    } catch {}
  }
  return partitionsCache
}

/** studio.voxcpm.python / model 这一个路径本身有没有问题（存配置时、渲染前都查）：绝对路径、不是网络 / 设备路径、不在她的家里；python 必须是 python.exe */
export function voxcpmPathProblem(k, p) {
  // 看不见的字符（BOM、换行、零宽…）一律不认：这边能去掉、Python 那边不一定去得掉，两边看到的就不是同一个路径（2026-10-25 第五轮审查）
  if (/[\p{Cc}\p{Cf}]/u.test(p) || p !== p.trim()) return `studio.voxcpm.${k} 里有看不见的字符或首尾空白：重新输一遍路径`
  if (!path.isAbsolute(p)) return `studio.voxcpm.${k} 要写绝对路径（现在是 ${p}）`
  if (/^[\\/]{2}/.test(p)) return `studio.voxcpm.${k} 不能是网络路径或 \\\\?\\ 开头的路径：${p}`
  if (pathInside(p, AI_HOME)) return `studio.voxcpm.${k} 在她能写的目录里（${AI_HOME}）—— 挪到别处`
  if (k === 'python' && process.platform === 'win32' && !/^pythonw?\.exe$/i.test(path.basename(p))) return `studio.voxcpm.python 要指向 python.exe（现在是 ${path.basename(p)}）`
  return null
}

/** 给人看的「这个角色用什么声音」（VoxCPM 的参考音是文件，不把路径显示出来） */
export const castVoiceLabel = (c, fallback = '默认') => c.tts === 'voxcpm' ? 'VoxCPM 本地（主人选定的音色）' : (c.tts === 'openai' ? `OpenAI ${c.voice ?? ''}` : c.voice ?? fallback)

/** 表情名 / 换装名：和 studio.py 的 EXPR_RE 同一个规矩（字母或汉字开头，只能有字母、汉字、数字、- 和 _，最多 32 个字）。JS 的 \w 不认汉字，所以用 \p{…} */
export const SPRITE_NAME_RE = /^[\p{L}\p{Nl}\p{No}][\p{L}\p{N}_-]{0,31}$/u
export const TALK_DIR = '说话'   // sprites/<换装>/说话/：和闭嘴那张同名的张嘴版（渲染时说话的人一张一合用，见 studio.py 的 talk_sprite）；不是一套换装

/**
 * 立绘有哪些（和 studio.py 的 Cast.outfits / use_outfit 同一套规矩）：
 *   outfits sprites/<换装>/<表情>.png：名字合法、不是「说话」、是真目录（不是链接 / 联接）、里面至少一张能用的立绘的子目录，按名字排序
 *   flat    老的平铺 sprites/<表情>.png：只在一套换装都没有时用（有换装时它们是搬家剩下的 → flatIgnored，主人那边提醒）
 *   能用的立绘：名字是合法表情名的 .png 普通文件（不是链接）
 *   默认穿哪套：profile.json 的 outfit（不在 = outfitBroken，渲染会报错）→ 排第一的那套 → 没有换装就是平铺
 */
function spriteSets(dir, prof) {
  const root = path.join(dir, 'sprites')
  const pngs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && /\.png$/i.test(e.name))
        .map((e) => e.name.slice(0, -4)).filter((n) => SPRITE_NAME_RE.test(n)).sort()
    } catch { return [] }
  }
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch {}
  const flat = pngs(root)
  const outfits = ents.filter((e) => e.isDirectory() && e.name !== TALK_DIR && SPRITE_NAME_RE.test(e.name)).map((e) => e.name).sort()
    .map((name) => ({ name, exprs: pngs(path.join(root, name)), talking: pngs(path.join(root, name, TALK_DIR)) })).filter((o) => o.exprs.length)
  const want = prof?.outfit
  const valid = typeof want === 'string' && SPRITE_NAME_RE.test(want) && want !== TALK_DIR
  let defaultOutfit = null, outfitProblem = null, missing = false
  if (want != null && want !== '' && !valid) outfitProblem = `profile.json 里的默认换装「${String(want).slice(0, 32)}」不是合法的名字（不算数）`
  else if (valid && outfits.some((o) => o.name === want)) defaultOutfit = want
  else if (valid) { outfitProblem = `默认换装「${want}」不在 sprites/ 里 —— 渲染会报错`; missing = true }
  if (!defaultOutfit && !missing && outfits.length) defaultOutfit = outfits[0].name
  const sprites = defaultOutfit ? outfits.find((o) => o.name === defaultOutfit).exprs : (missing ? [] : flat)
  return { sprites, outfits, defaultOutfit, outfitProblem, outfitBroken: missing, flatIgnored: outfits.length ? flat : [] }
}

/** 有两套以上换装时，一行字列出来（「居家（默认） / 外出」）；只有一套或没有时返回空串 */
export const outfitLabel = (c) => c.outfits?.length >= 2 ? c.outfits.map((o) => o.name + (o.name === c.defaultOutfit ? '（默认）' : '')).join(' / ') : ''

/** 角色表：[{ id, name, voice, refs, sprites[]（默认那套的表情）, outfits[{ name, exprs, talking }], defaultOutfit, outfitProblem, outfitBroken, flatIgnored[] }] */
export function listCast() {
  let ids = []
  try { ids = fs.readdirSync(CAST_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  return ids.filter((id) => fs.existsSync(path.join(CAST_DIR, id, 'profile.json'))).map((id) => {
    const dir = path.join(CAST_DIR, id)
    const prof = readJson(path.join(dir, 'profile.json'), {})
    let files = []
    try { files = fs.readdirSync(dir) } catch {}
    return { id, ...prof, refs: files.filter((f) => /^ref.*\.(png|jpe?g|webp)$/i.test(f)), ...spriteSets(dir, prof) }
  })
}

/** 下一集的集数：这个系列里已交审 / 已发布的最大集数 + 1 */
/**
 * 交审 / 发布的账：从 ~/.bili-ai/review/<id>/ 读（她写不到）—— 作品目录里的 meta.json 她能改，不能拿来算名额和集数
 *   submitted.json  { at, title, series, episode, rejectedAt? }   交审时写，被否掉时补 rejectedAt
 *   published.json  { at, bvid }
 */
export function reviewRecords() {
  let ids = []
  try { ids = fs.readdirSync(REVIEW_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  return ids.map((id) => {
    const dir = path.join(REVIEW_DIR, id)
    return { id, submitted: readJson(path.join(dir, 'submitted.json'), null), published: readJson(path.join(dir, 'published.json'), null) }
  })
}

const liveSubmission = (r) => r.published || (r.submitted && !r.submitted.rejectedAt)

export function recordSubmission(id, rec) { writeJson(path.join(reviewDir(id), 'submitted.json'), { ...rec, at: new Date().toISOString() }) }

export function markRejected(id) {
  const f = path.join(reviewDir(id), 'submitted.json')
  const cur = readJson(f, null)
  if (cur) writeJson(f, { ...cur, rejectedAt: new Date().toISOString() })
}

/** 栏目名统一去掉首尾空白（studio.py 拼标题时也 strip —— 不统一的话「鲸鱼手记 」会从第 1 集重新编号） */
export const normSeries = (s) => String(s ?? '').trim()

/** 下一集的集数：这个系列里已交审（没被否）/ 已发布的最大集数 + 1 */
export function nextEpisode(series) {
  let max = 0
  for (const r of reviewRecords()) {
    if (!liveSubmission(r) || normSeries(r.submitted?.series) !== normSeries(series)) continue
    max = Math.max(max, Number(r.submitted.episode) || 0)
  }
  return max + 1
}

/** 标题开头的【…】前缀（去掉空白）：真正上传的标题里「哪个栏目第几集」就看它 */
export const titlePrefix = (title) => (String(title ?? '').trim().match(/^【([^】]*)】/)?.[1] ?? '').replace(/\s+/g, '')

/**
 * 别的作品是不是已经用了这个完整标题（交审没被否 / 已发布 / 被否了但还有结果不确定的投稿）。
 * 撞了的话，去 B站 核对「那次投稿到底投没投出去」时就分不清是哪个作品的稿件 —— 交审时就拦下
 */
export function titleTaken(id, title) {
  const t = String(title ?? '').trim()
  if (!t) return null
  return reviewRecords().find((r) => r.id !== id && String(r.submitted?.title ?? '').trim() === t
    && (liveSubmission(r) || readAttempts(r.id).unresolved.length)) ?? null
}

/** 别的作品里（交审没被否 / 已发布）有没有同一个【栏目 n】前缀 —— 比对的是真正上传的标题，不是 script 里的栏目字段 */
export function prefixTaken(id, title) {
  const p = titlePrefix(title)
  if (!p) return null
  return reviewRecords().find((r) => r.id !== id && liveSubmission(r) && titlePrefix(r.submitted?.title) === p) ?? null
}

// 已停用的画图模型 → 官方推荐的替代（老配置文件里可能还写着它们）
const RETIRED_IMAGE_MODELS = { 'gpt-image-1': 'gpt-image-2.5-sunburst', 'gpt-image-1-mini': 'gpt-image-2.5-flare', 'gpt-image-1.5': 'gpt-image-2.5-sunburst', 'dall-e-3': 'gpt-image-2.5-sunburst', 'dall-e-2': 'gpt-image-2.5-flare' }

export function studioConfig() {
  const s = config().studio ?? {}
  const image = { ...STUDIO_DEFAULTS.image, ...(s.image ?? {}) }
  if (RETIRED_IMAGE_MODELS[image.model]) image.model = RETIRED_IMAGE_MODELS[image.model]
  const out = { ...STUDIO_DEFAULTS, ...s, image }
  if (out.aiStatement === '该视频使用人工智能合成技术') out.aiStatement = STUDIO_DEFAULTS.aiStatement   // 老默认值少了「作者声明：」，不是 B站 预设原文
  return out
}

export const venvPython = () => path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

export function imageKey() {
  if (process.env.BILI_WHALE_IMAGE_KEY) return process.env.BILI_WHALE_IMAGE_KEY.trim()
  try { return fs.readFileSync(IMAGE_KEY_FILE, 'utf8').trim() } catch { return '' }
}

export const projectDir = (id) => {
  if (!/^[0-9A-Za-z_-]{3,80}$/.test(String(id ?? ''))) throw new Error(`作品 id 不对：${id}`)
  return path.join(STUDIO_DIR, id)
}

const readJson = (f, d) => {
  try {
    const s = fs.readFileSync(f, 'utf8')
    return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)   // 记事本 / PowerShell 存的会带 BOM
  } catch { return d }
}
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = f + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n')
  renameRetry(tmp, f)   // Windows：目标正被别的进程读着时改名会短暂失败
}
export { readJson, writeJson }

// meta.json 在她的家里（她能改）：只当显示用的提示，读的时候什么形状都要扛得住，别让主人那边的命令被它弄崩
export function readMeta(id) {
  const m = readJson(path.join(projectDir(id), 'meta.json'), null)
  return m && typeof m === 'object' && !Array.isArray(m) ? m : { id, status: 'draft', history: [] }
}

export function writeMeta(id, patch, note = '') {
  const m = readMeta(id)
  const history = Array.isArray(m.history) ? m.history.slice(-50) : []
  const next = { ...m, ...patch, history: [...history, { at: new Date().toISOString(), status: patch.status ?? m.status, note }] }
  writeJson(path.join(projectDir(id), 'meta.json'), next)
  return next
}

export function listProjects() {
  let ids = []
  try { ids = fs.readdirSync(STUDIO_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  // 只认作品目录：studio/ 下还有出图缓存 .cache、数据存档 stats 之类，不是作品
  ids = ids.filter((id) => /^[0-9A-Za-z_-]{3,80}$/.test(id) && fs.existsSync(path.join(STUDIO_DIR, id, 'script.json')))
  return ids.sort().map((id) => ({ id, ...readMeta(id) }))
}

/** 交审那一刻的文件指纹：主人审的是哪几个文件，投稿时就必须还是那几个（她能写作品目录，所以要核对） */
export const REVIEWED_FILES = ['final.mp4', 'cover.jpg', 'script.json']
export function fileHashes(dir) {
  const out = {}
  for (const f of REVIEWED_FILES) {
    try { out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex') } catch { out[f] = null }
  }
  return out
}

// ─────────────── 审片快照：主人看的、最终上传的，都是这一份 ───────────────
//   ~/.bili-ai/review/<id>/{final.mp4,cover.jpg,script.json}   交审时从作品目录复制过来（她写不到 ~/.bili-ai）
//   ~/.bili-ai/review/<id>/.uploading                          上传锁（独占创建：两个批准同时来也只有一个拿得到）
//   ~/.bili-ai/review/<id>/published.json                      投过了就有它 —— 再也不会投第二次
export const REVIEW_DIR = path.join(HOME, '.bili-ai', 'review')
// 渲染回执：渲染完成时记下成片 / 封面 / 剧本的指纹和时长（她写不到）。交审时核对 —— 作品目录在她的家里，
// render.json 她能改、成片她能换，所以不能信目录里的东西，只信回执
export const RENDER_RECEIPTS = path.join(HOME, '.bili-ai', 'renders')
/** rec.hashes 由调用方给：渲染前的剧本指纹 + studio.py 刚写出来的成片 / 封面指纹（不在渲染完再去读剧本 —— 那时候可能已经被改了） */
export const writeRenderReceipt = (id, rec) => writeJson(path.join(RENDER_RECEIPTS, `${id}.json`), { ...rec, at: new Date().toISOString() })
export const readRenderReceipt = (id) => readJson(path.join(RENDER_RECEIPTS, `${id}.json`), null)
// 每条视频的 AI 出图账本（她写不到）：studio.py 每出一张图之前在这里预留，maxPerVideo 按这条视频所有渲染加起来算
export const IMAGE_LEDGERS = path.join(HOME, '.bili-ai', 'images')
export const imageLedger = (id) => { projectDir(id); return path.join(IMAGE_LEDGERS, `${id}.json`) }
/** 给 studio.py 的临时配置放系统临时目录（不放她的家里：免得在读之前被换掉） */
export function tempConfigFile(obj) {
  const f = path.join(os.tmpdir(), `whale-cfg-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`)
  fs.writeFileSync(f, JSON.stringify(obj))
  return f
}
export const reviewDir = (id) => { projectDir(id); return path.join(REVIEW_DIR, id) }   // projectDir 顺带校验 id

// ─────────────── 交审：先在私有暂存区里查完，再整份放进快照 ───────────────
// 以前交审时：先读一次剧本做查重，再另外读文件算指纹，最后才复制快照 —— 三次读之间作品目录可以被换掉，
// 查重查的是 A，快照里却是 B。现在：先把三个文件复制进 ~/.bili-ai/staging/（她写不到），
// 指纹核对、字段检查、原创查重全都只看这一份，查重报告绑定这一份剧本的指纹；通过了再整份挪进快照目录
export const STAGING_DIR = path.join(HOME, '.bili-ai', 'staging')

export function stageCopy(id, fromDir) {
  projectDir(id)
  fs.mkdirSync(STAGING_DIR, { recursive: true })
  const dir = fs.mkdtempSync(path.join(STAGING_DIR, `${id}-`))
  for (const f of REVIEWED_FILES) {
    if (fs.existsSync(path.join(fromDir, f))) fs.copyFileSync(path.join(fromDir, f), path.join(dir, f))
  }
  return { dir, hashes: fileHashes(dir), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

/** 暂存区 → 快照目录（只换审片文件和查重报告；上传锁、投稿记录、不确定的投稿尝试都留着）。返回快照里的指纹 */
export function promoteSnapshot(id, stage) {
  const dir = reviewDir(id)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of [...REVIEWED_FILES, 'originality.json']) {
    fs.rmSync(path.join(dir, f), { force: true })
    if (fs.existsSync(path.join(stage.dir, f))) fs.renameSync(path.join(stage.dir, f), path.join(dir, f))
  }
  return fileHashes(dir)
}

/** 每一次交审一个新的编号：批准 / 退回 / 投稿结果都认这个编号，不只认作品 id（同一个作品可以被退回再交好几轮） */
export const newSubmissionId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`

// ─────────────── 上传锁 + 不确定的投稿尝试 ───────────────
//   ~/.bili-ai/review/<id>/.uploading      正在上传（独占创建；里面记着哪个进程、哪一轮交审、什么标题）
//   ~/.bili-ai/review/<id>/attempts.json   结果不确定的投稿尝试：上传报错 / 中途崩掉 —— B站 那边可能其实已经收到了。
//                                          这份记录**退回、重新交审都不会清掉**；只有去 B站 核对过（或者主人亲自确认）才算了结。
//                                          有没了结的尝试时，再投之前一定先去 B站 查。
export function acquireUploadLock(id, info = {}) {
  const file = path.join(reviewDir(id), '.uploading')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const fd = fs.openSync(file, 'wx')
    const token = crypto.randomBytes(8).toString('hex')   // 这把锁是谁的：放锁时核对，免得放掉别人的锁
    fs.writeSync(fd, JSON.stringify({ ...info, pid: process.pid, at: new Date().toISOString(), token }))
    fs.closeSync(fd)
    return { ok: true, token }
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e
    // 和 readUploadLock 同一个形状（读不出来 = { pid: null, at: null, unreadable: true }）：放锁时按它核对，
    // 不然一把空的 / 坏掉的锁（崩在建文件和写内容之间）永远对不上、永远清不掉
    return { ok: false, lock: readUploadLock(id) ?? { pid: null, at: null, unreadable: true } }
  }
}
export const readUploadLock = (id) => {
  const f = path.join(reviewDir(id), '.uploading')
  if (!fs.existsSync(f)) return null
  return readJson(f, null) ?? { pid: null, at: null, unreadable: true }   // 锁文件在、但读不出来：当成上次崩掉的上传
}
/**
 * 放掉上传锁 —— 只放自己那一把。owner = 拿锁时得到的 token，或者（崩溃恢复时）之前读到、判断过的那把锁。
 * 锁已经换成了别人的 → 不动，返回 false。拿锁、接手、放锁都应在队列锁里做（host/core.mjs 就是这样调用的）
 */
export function releaseUploadLock(id, owner) {
  if (!owner) return false
  const cur = readUploadLock(id)
  if (!cur) return false
  const want = typeof owner === 'string' ? { token: owner } : owner
  const same = want.token != null ? cur.token === want.token
    : cur.token == null && cur.pid === want.pid && cur.at === want.at   // 旧版本的锁 / 读不出来的锁：按读到时的样子核对
  if (!same) return false
  fs.rmSync(path.join(reviewDir(id), '.uploading'), { force: true })
  return true
}
/**
 * 上传锁的主人还活着吗（活着 = 真的有一个批准正在投）。只认：进程还在、程序是 node、锁不超过 2 小时
 * （一次上传最多跑 60 分钟）—— 进程号会被系统复用，光看进程号在不在，崩掉的上传可能永远像「还在投」
 */
const UPLOAD_LOCK_MAX_MS = 2 * 3600_000
export const uploadLockLive = (lock) => Boolean(lock?.pid) && pidAlive(lock.pid)
  && !(Date.now() - Date.parse(lock.at ?? '') > UPLOAD_LOCK_MAX_MS) && /node/i.test(procName(lock.pid) || 'node')

/** 读「防重投」用的记录：文件不存在 = 没有；存在但读不出来 = 状态未知 → 抛错（不能当成「没有」接着投、接着覆盖） */
export function readJsonStrict(f) {
  let raw
  try { raw = fs.readFileSync(f, 'utf8') } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw new Error(`${f} 读不了（${e?.code ?? e}）—— 不知道之前的状态，先不动；请主人看一下这个文件`)
  }
  try { return JSON.parse(raw) } catch { throw new Error(`${f} 坏了（不是合法 JSON）—— 不知道之前的状态，先不动；请主人看一下这个文件`) }
}

const ATTEMPTS = (id) => path.join(reviewDir(id), 'attempts.json')
export const readAttempts = (id) => {
  const a = readJsonStrict(ATTEMPTS(id))
  return { unresolved: Array.isArray(a?.unresolved) ? a.unresolved : [], resolved: Array.isArray(a?.resolved) ? a.resolved : [] }
}
/** 记一次结果不确定的投稿尝试 */
export function addUncertainAttempt(id, att) {
  const a = readAttempts(id)
  a.unresolved.push({ at: att.at ?? new Date().toISOString(), submissionId: att.submissionId ?? null, title: att.title ?? null, error: String(att.error ?? '').slice(0, 300), kind: att.kind ?? 'failed' })
  writeJson(ATTEMPTS(id), a)
  return a
}
/** 了结：核对过了（how = 'not-found' | 'found:<BV>' | 'owner:…'） */
export function resolveAttempts(id, how, pred = () => true) {
  const a = readAttempts(id)
  const keep = [], done = []
  for (const x of a.unresolved) (pred(x) ? done : keep).push(x)
  a.unresolved = keep
  a.resolved = [...a.resolved, ...done.map((x) => ({ ...x, resolvedAt: new Date().toISOString(), how }))].slice(-50)
  writeJson(ATTEMPTS(id), a)
  return done.length
}
/** 上次崩在上传途中（锁还在、进程已经不在）：把它记成一次不确定的尝试，再清掉锁 */
export function crashedLockToAttempt(id, lock) {
  addUncertainAttempt(id, { at: lock?.at, submissionId: lock?.submissionId, title: lock?.title, error: '上传途中进程退出了（崩溃 / 被关掉），不知道 B站 收到没有', kind: 'crashed' })
  releaseUploadLock(id, lock)   // 只清掉判断过的那一把
}

export const publishedRecord = (id) => readJsonStrict(path.join(reviewDir(id), 'published.json'))
export const markPublished = (id, rec) => writeJson(path.join(reviewDir(id), 'published.json'), { ...rec, at: new Date().toISOString() })
/** 已经记着一条发布、又投出了另一条（主人 --force 接手时原来的上传其实还在跑）：不覆盖原记录，多出来的这条记在 duplicates 里 */
export function notePublishedDuplicate(id, bvid) {
  const f = path.join(reviewDir(id), 'published.json')
  const p = readJsonStrict(f) ?? {}
  writeJson(f, { ...p, duplicates: [...(Array.isArray(p.duplicates) ? p.duplicates : []), { bvid: bvid ?? null, at: new Date().toISOString() }] })
}

export const pendingVideos = () => readJson(PENDING_VIDEOS, { items: [] }).items ?? []
export const savePendingVideos = (items) => writeJson(PENDING_VIDEOS, { items })
/** 这条现在是不是「交审了、主人还没处理完」（看的是主人那边的队列，不是她能改的 meta.json） */
export const isPending = (id) => pendingVideos().some((x) => x.id === id)

// ─────────────── 审片队列锁 ───────────────
// 交审 / 批准 / 否掉 都是「读整个队列 → 改 → 写回」。以前各读各写：她同时交两条会丢一条（名额和集数却记上了），
// 主人否掉的那一刻她正在交另一条，会把否掉的那条又写回去。现在三处都先拿这把锁（独占创建的文件）
export const QUEUE_LOCK = path.join(HOME, '.bili-ai', 'pending-videos.lock')
export const withQueueLock = (fn, opts = {}) => withFileLock(QUEUE_LOCK, fn, { busy: '审片队列正被占着（另一个交审 / 批准 / 否掉还没做完），稍后再试', ...opts })

/** 从队列里拿掉一条（带锁）。给了交审编号就只拿掉那一轮（老的上传结束时不会误删新一轮的待审） */
export const dequeueVideo = (id, submissionId = null) => withQueueLock(() =>
  savePendingVideos(pendingVideos().filter((x) => !(x.id === id && (!submissionId || subId(x) === submissionId)))))
/** 队列条目的交审编号（老条目没有编号：用交审时间顶上） */
export const subId = (item) => item?.submissionId ?? (item?.at ? `legacy-${item.at}` : null)

/** 上传用的私有副本：从快照复制到系统临时目录、在副本上核对指纹、从副本上传 —— 上传那几分钟里快照被动过也影响不到 */
export function uploadCopy(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-up-'))
  for (const f of REVIEWED_FILES) {
    const src = path.join(reviewDir(id), f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  return { dir, hashes: fileHashes(dir), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

/** 最近 7 天占用的名额：已发布 + 在审 */
/** 最近 7 天占用的名额：交审过（没被否）或已发布的 —— 按交审时间算 */
export function weeklyUsed(now = Date.now()) {
  const week = 7 * 86400000
  return reviewRecords().filter((r) => liveSubmission(r) && r.submitted?.at && now - new Date(r.submitted.at).getTime() < week).length
}
