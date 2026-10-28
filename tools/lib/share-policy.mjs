// Both comment and DM sharing must obey the same user settings.
import { wordList } from './prefs.mjs'
import { shareEnabled, minScoreOf } from './config.mjs'

/**
 * 分享门槛（share.minScore）：没填 = 13；0 到 20 的整数 = 那个数；别的（-1、10.5、空串、true、「十分」）= NaN，分享一律拦下。
 * 和存配置同一套读法（tools/lib/config.mjs minScoreOf）。以前 Number('') = 0、Number(true) = 1，写坏了的门槛会变成「什么都能发」（2026-10-25）
 */
export const shareThreshold = (cfg) => minScoreOf(cfg?.share?.minScore)

/**
 * 只发第一名吗（share.topOnly）：默认是 —— 一轮里只有排第一的那条能分享（--rank 1）。
 * 主人 2026-10-25 把自己的关了：一轮里每条够分的都可以 @ 主人（同一视频 7 天一次、理由和分数照旧）。
 * 只有写成 false 才算关（写坏了按「只发第一名」，不能因为写坏了反而放开）
 */
export const topOnly = (cfg) => cfg?.share?.topOnly !== false

export function validateShare(cfg, { reason, score, rank = 1 }) {
  if (!shareEnabled(cfg)) throw new Error('分享已关闭（share.enabled=false）')
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('分享需要 --reason（至少 8 字）')
  const n = Number(score), threshold = shareThreshold(cfg)
  if (score === undefined || score === '' || typeof score === 'boolean' || !Number.isFinite(n) || n < 0 || n > 20)
    throw new Error('分享需要 --score（0–20）')
  if (!Number.isFinite(threshold)) throw new Error(`分享门槛 share.minScore 读不出来（${String(cfg.share?.minScore).slice(0, 20)}）：先别分享，让主人修配置`)
  if (n < threshold) throw new Error(`评分 ${n} 未达到阈值 ${threshold}`)
  if (topOnly(cfg)) {
    if (typeof rank === 'boolean' || Number(rank) !== 1) throw new Error('分享只允许 --rank 1')
    return { score: n, reason: reason.trim(), rank: 1 }
  }
  // 够分就能发：--rank 可以不写；写了就得是名次（1、2、3…）
  const noRank = rank === undefined || rank === null || rank === ''
  if (!noRank && (typeof rank === 'boolean' || !Number.isInteger(Number(rank)) || Number(rank) < 1)) throw new Error('--rank 要是名次（1、2、3…），也可以不写')
  return { score: n, reason: reason.trim(), rank: noRank ? 1 : Number(rank) }
}

/**
 * 评分卡（debrief --score）：照配置写「偏好交集」对照什么、几分才发、只发第一名还是够分都能发。最后一行就是能不能发（她的守则这么说）。
 * 以前写死「超过 12 就发」、只说「和 config.like 重合吗」—— 改了门槛和爱看，评分卡不跟着变 ✗（2026-10-25）
 */
export function scoreCardLines(cfg) {
  const p = cfg?.preferences ?? {}
  const show = (v) => wordList(v).join(' · ') || '（没填）'
  const kw = wordList(p.keywords)
  const t = shareThreshold(cfg)
  const verdict = !shareEnabled(cfg)
    ? '  → 合计 __/20；分享现在关着（share.enabled=false），分数只写进日记'
    : !Number.isFinite(t)
      ? `  → 合计 __/20；分享门槛 share.minScore 读不出来（${String(cfg.share?.minScore).slice(0, 20)}），这次分享会被拦 —— 告诉主人修配置`
      : topOnly(cfg)
        ? `  → 合计 __/20；**≥ ${t} 才发，只发这一轮的第一名**（不到 ${t} = 今天没有值得发的 ✓）`
        : `  → 合计 __/20；**≥ ${t} 就可以发**：这一轮每条够分的都可以 @ 主人（同一视频 7 天一次）；不到 ${t} = 今天没有值得发的 ✓`
  return [
    '══════════ 评分卡（每项 0-4 分，满 20）══════════',
    '  信息密度 __/4   看完学到东西了吗',
    '  偏好交集 __/4   和主人的爱看重合吗（碰到不爱看的扣分）',
    `                  爱看：${show(p.like)}`,
    ...(kw.length ? [`                  也算：${kw.join(' · ')}`] : []),
    `                  不爱看：${show(p.dislike)}`,
    '  新颖度   __/4   对照日记「看过的」，主人大概率不知道吗',
    '  情绪价值 __/4   好笑 / 治愈 / 震撼，至少占一样',
    '  表达质量 __/4   UP 讲得清楚吗，还是标题党',
    '  （填完写进日记：日期 + BV + 分数 + 一句理由）',
    verdict,
  ]
}
