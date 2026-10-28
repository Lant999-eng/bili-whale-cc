/**
 * 统一的路径解析（DSH home 与用户主目录）。
 *
 * 为什么需要它：插件宿主半边（lib/index.js）用的是
 *   process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
 * 而工具链（tools/ 下的脚本）此前各自硬编码 path.join(HOME, '.dsh')，
 * **完全不读 DSH_HOME**。两边的 home 语义一旦不一致就会分叉：
 *
 *   · DSH_HOME 被自定义（多个 profile 根、便携安装、CI）时，
 *     宿主把配置写进 $DSH_HOME/bili-whale.config.json，
 *     工具链却去 $HOME/.dsh/ 读 → 读不到（或读到另一份），
 *     生物钟、日记、日志、配置全部错位。
 *
 * 因此所有 tools/ 脚本都应从这里取路径，别再本地拼 '.dsh'。
 *
 * 注意保留旧行为：USERPROFILE 优先于 HOME，`BILI_WHALE_CONFIG` 仍可覆盖配置文件位置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，保持与原实现一致）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边 (lib/index.js) 完全一致的解析顺序。 */
// bili-whale-cc：不再依赖 DSH，默认数据目录换成 ~/.bili-whale（想沿用 DSH 版数据就设 DSH_HOME=~/.dsh）
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.bili-whale')

/** 拼一个位于 DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 拼一个位于用户主目录下的路径（.bili-ai 等凭据/状态目录用）。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（保留 BILI_WHALE_CONFIG 覆盖）。 */
export const configPath = process.env.BILI_WHALE_CONFIG || dshPath('bili-whale.config.json')

/** Credentials are per OS user, independent of DSH_HOME. */
export const credentialsPath = homePath('.bili-ai', 'credentials.json')

// ─────────────── 她（AI）能写的地方：只有这一个目录 ───────────────
// bili-whale-cc 安全边界（外部审查 2026-10-22）：她的 Claude Code 会话只对这个目录有 Write/Edit 权限。
// 放在这里的只能是「她自己的东西」：两本日记、频道设定、作品稿子。
// 配置、宿主状态、额度账本、审片快照、角色素材、看过的字幕（查重依据）都不在这里 —— 她改不了。
export const AI_HOME = process.env.BILI_WHALE_AI_HOME || dshPath('whale-work')
export const aiPath = (...parts) => path.join(AI_HOME, ...parts)
export const diaryPath = aiPath('whale-diary.md')
export const privateDiaryPath = aiPath('whale-diary-private.md')

/** 宿主在她的会话里设 BILI_WHALE_AGENT=1：工具据此把她的发言一律按「自主」计额度，主人专用的命令也不让她用 */
export const isAgent = () => process.env.BILI_WHALE_AGENT === '1'

/**
 * 她的会话里，工具读 / 写的文件路径只能落在这几个目录里（解析真实路径后判断，挡住 ..、符号链接）。
 * 起因（外部审查）：dynamic-edit / dynamic-image 会把指定的文件读出来发布 —— 不限制的话，
 * 她能把 ~/.bili-ai/credentials.json 当动态内容发出去；subtitles --out 等能把输出写到任意目录。
 * 主人自己跑（不是她的会话）不受限。
 */
export function agentPathAllowed(p, roots = [AI_HOME, dshPath('shots')]) {
  if (!isAgent()) return true
  let real
  try { real = fs.realpathSync(path.resolve(String(p))) } catch {
    try { real = path.join(fs.realpathSync(path.dirname(path.resolve(String(p)))), path.basename(String(p))) } catch { return false }
  }
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x)
  return roots.some((r) => {
    let base
    try { base = fs.realpathSync(r) } catch { base = path.resolve(r) }
    const rel = path.relative(norm(base), norm(real))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** p 是不是在 root 里面（不管是谁在跑）。按真实路径算：符号链接 / 目录联接、大小写、8.3 短名（WHALE-~1）、\? 前缀都展开
 *  （.native 才会展开短名和前缀；JS 版的 realpathSync 不展开）；路径还不存在就从最近一个存在的上级算。用来「拒绝」，所以宁严勿松 */
export function pathInside(p, root) {
  const real = (x) => {
    let cur = path.resolve(String(x))
    const rest = []
    for (;;) {
      try { return path.join(fs.realpathSync.native(cur), ...rest) } catch {}
      const up = path.dirname(cur)
      if (up === cur) return path.resolve(String(x))
      rest.unshift(path.basename(cur))
      cur = up
    }
  }
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x)
  const rel = path.relative(norm(real(root)), norm(real(p)))
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))   // 「..voxcpm」这种名字是里面的子目录，不是上一级
}
