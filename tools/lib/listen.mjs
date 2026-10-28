// 「听」（2026-10-26 主人：「她现在没法听声音」）：视频的声音在本机转成文字，附带情绪和声音事件 ——
//   SenseVoiceSmall（int8）+ silero VAD，跑在 sherpa-onnx 上，只用 CPU（不跟 VoxCPM 配音抢显卡）。
//   依赖和模型都由主人装：node host/cli.mjs listen-setup（.listen-venv + 模型目录）。她只能用 `node bili.mjs listen <BV>`，
//   没装好时这条命令只说「主人还没装」，help 里也不列它。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshPath } from './paths.mjs'

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LISTEN_VENV = process.env.BILI_WHALE_LISTEN_VENV || path.join(PROJECT_ROOT, '.listen-venv')
export const LISTEN_MODELS = process.env.BILI_WHALE_LISTEN_MODELS || dshPath('listen-models')
export const LISTEN_WORKER = process.env.BILI_WHALE_LISTEN_WORKER || path.join(PROJECT_ROOT, 'studio', 'listen_worker.py')
export const LISTEN_TMP = dshPath('listen-tmp')
export const listenPython = () => process.env.BILI_WHALE_LISTEN_PYTHON ||
  path.join(LISTEN_VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
// 模型目录里的固定名字（listen-setup 放好；listen_worker.py 照这几个名字找）
export const MODEL_FILES = ['sense-voice/model.int8.onnx', 'sense-voice/tokens.txt', 'silero_vad.onnx']
// listen-setup 最后一步才写的「装完了」记号：记着每个模型文件的大小。装到一半断掉（没有记号）、文件被截短（大小对不上）都不算装好
export const READY_FILE = 'ready.json'
/** 模型可信吗：记号在、三个模型文件都在而且大小和记号里的一样（listen-setup 也拿它决定要不要重下） */
export function modelsValid() {
  let mark
  try { mark = JSON.parse(fs.readFileSync(path.join(LISTEN_MODELS, READY_FILE), 'utf8')) } catch { return false }
  return MODEL_FILES.every((f) => {
    const want = Number(mark?.files?.[f])
    try { return want > 0 && fs.statSync(path.join(LISTEN_MODELS, f)).size === want } catch { return false }
  })
}
/** 装好了没有：Python 在、模型可信 */
export const listenReady = () => fs.existsSync(listenPython()) && modelsValid()

/**
 * ffmpeg：先按 lib/ffmpeg.mjs 的顺序找（FFMPEG 环境变量 → PATH → …）；都没有就用工作室依赖（.studio-venv）里 imageio-ffmpeg 带的那个 ——
 * studio-setup 装过的话它一定在。找不到 → null
 */
export async function listenFfmpeg() {
  try { const { requireFfmpeg } = await import('./ffmpeg.mjs'); return requireFfmpeg() } catch {}
  const venv = process.env.BILI_WHALE_STUDIO_VENV || path.join(PROJECT_ROOT, '.studio-venv')
  for (const d of [path.join(venv, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'), path.join(venv, 'lib')]) {
    try {
      if (d.endsWith('binaries')) { const x = fs.readdirSync(d).find((n) => /^ffmpeg/i.test(n)); if (x) return path.join(d, x) }
      else for (const py of fs.readdirSync(d)) { const b = path.join(d, py, 'site-packages', 'imageio_ffmpeg', 'binaries'); const x = fs.existsSync(b) && fs.readdirSync(b).find((n) => /^ffmpeg/i.test(n)); if (x) return path.join(b, x) }
    } catch {}
  }
  return null
}

// 一次最多听几分钟、默认几分钟；给她看的字数上限（长视频不把她的会话撑爆）
export const MAX_MIN = 20
export const DEFAULT_MIN = 8
export const MAX_CHARS = 2500

const EMOTION = { HAPPY: '开心', SAD: '难过', ANGRY: '生气', FEARFUL: '害怕', DISGUSTED: '厌恶', SURPRISED: '惊讶' }
const EVENT = { BGM: '背景音乐', Applause: '掌声', Laughter: '笑声', Cry: '哭声', Sneeze: '喷嚏', Breath: '呼吸声', Cough: '咳嗽' }
const LANG = { en: '英语', ja: '日语', ko: '韩语', yue: '粤语' }
const FIRST_MAX = 40   // 重听过的句子后面附的「一开始听成的」最多几个字

// 转写出来的字是别人视频里的话：控制字符、改方向的字去掉；像〔宿主〕【主人私信】的括号换成圆括号（冒充不了宿主的提示）
const ch = (...cs) => cs.map((c) => String.fromCharCode(c)).join('')
const INVISIBLE = new RegExp('[' + ch(0) + '-' + ch(0x1f) + ch(0x7f) + '-' + ch(0x9f) + ch(0x200b) + '-' + ch(0x200f) + ch(0x061c, 0x2028, 0x2029, 0xfeff) +
  ch(0x202a) + '-' + ch(0x202e) + ch(0x2066) + '-' + ch(0x2069) + ']', 'g')
export const cleanHeard = (s) => String(s ?? '').replace(INVISIBLE, ' ').replace(/[【〖〔［\[「『]/g, '（').replace(/[】〗〕］\]」』]/g, '）')
  .replace(/\s+/g, ' ').trim()

const mmss = (sec) => { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

/**
 * worker 的结果 → 给她看的几行：「00:12 [笑声·开心] 原话」。情绪是 NEUTRAL、事件是 Speech、语种是中文的不标；
 * 按中文重听过的标「按中文重听」，后面括号里附一开始听成的（「00:03 [按中文重听] 哈哈。（一开始听成日语：は？）」）；
 * 整块（连换行、连最后那句「还有几段没列出」）不超过 maxChars，到了就停。不认识的标记照原样不标（不当成她能信的东西）
 */
export function formatHeard(res, { maxChars = MAX_CHARS } = {}) {
  const segs = Array.isArray(res?.segments) ? res.segments : []
  const lines = []
  const NOTE_ROOM = 40   // 给「…（后面还有 N 段没列出：字数到上限了）」留的位置
  let used = 0, shown = 0
  for (const s of segs) {
    const text = cleanHeard(s?.text)
    if (!text) continue
    // 按中文重听过的（worker 记着一开始听成的语种和字）：标出来，括号里附上一开始听成的样子 —— 万一那句真是外语，她看得出来
    const first = LANG[s?.first_lang] ? cleanHeard(s?.first_text).slice(0, FIRST_MAX) : ''
    const tags = [EVENT[s?.event], LANG[s?.lang], EMOTION[s?.emotion], LANG[s?.first_lang] && '按中文重听'].filter(Boolean)
    const line = `${mmss(s?.start)} ${tags.length ? `[${tags.join('·')}] ` : ''}${text}${first ? `（一开始听成${LANG[s.first_lang]}：${first}）` : ''}`
    if (used + line.length + 1 > maxChars - NOTE_ROOM) break
    lines.push(line)
    used += line.length + 1
    shown += 1
  }
  const left = segs.filter((s) => cleanHeard(s?.text)).length - shown + (Number(res?.truncated) || 0)
  if (left > 0) lines.push(`…（后面还有 ${left} 段没列出：字数到上限了）`)
  return { lines, shown, total: segs.length }
}
