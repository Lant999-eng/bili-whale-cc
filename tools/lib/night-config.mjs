import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from './paths.mjs'
/** night.maxVideos 没写时的默认值（新装）：一轮最多筛 5 条。主人写 0 = 不限 */
export const DEFAULT_MAX_VIDEOS = 5
export function readNightConfig(home = DSH_HOME) {
  let user = {}, legacy = {}
  try { user = JSON.parse(fs.readFileSync(process.env.BILI_WHALE_CONFIG || path.join(home, 'bili-whale.config.json'), 'utf8').replace(/^\uFEFF/, '')).night ?? {} } catch {}
  try { legacy = JSON.parse(fs.readFileSync(path.join(home, 'whale-night.config.json'), 'utf8').replace(/^\uFEFF/, '')) } catch {}
  return { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: DEFAULT_MAX_VIDEOS, ...user, ...legacy }
}
/**
 * night.maxVideos：一轮最多筛几条。没写（undefined / null）= 默认 5；0 / 不是正数 = 不限（2026-10-24 主人取消了自己的上限，以前最多 20）。
 * 存配置、宿主的唤醒提示、手动叫醒都用它
 */
export const videosPerWake = (v) => {
  if (v === undefined || v === null) return DEFAULT_MAX_VIDEOS
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
}
