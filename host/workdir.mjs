/**
 * 她的家（AI_HOME，默认 <数据目录>/whale-work）—— 她的 Claude Code 会话只能写这一个目录
 *
 *   CLAUDE.md                 她的守则（每次她醒来前都用模板重写；她的会话也禁止改它）
 *   bili.mjs                  垫片：让 `node bili.mjs …` 能用；同样每次重写、禁止她改
 *   whale-diary.md / whale-diary-private.md   两本日记（不存在才放模板，绝不覆盖）
 *   channel.md                频道设定（她写，主人确认）
 *   studio/<作品>/             作品稿子和渲染结果
 *
 * 老版本把日记 / 频道设定 / 作品放在数据目录根下 —— 自动搬进来（主人的每条命令、每次醒来前都会试一次）。
 * 出图缓存、stats 存档搬到她写不到的地方；老作品的交审 / 发布记录补进 ~/.bili-ai/review（名额、集数、防重投都靠它）。
 */
import './env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AI_HOME } from '../tools/lib/paths.mjs'
import { STUDIO_DIR, CACHE_DIR, STATS_DIR, REVIEW_DIR, CHANNEL_TEMPLATE, readJson, writeJson, addUncertainAttempt } from '../tools/lib/studio.mjs'
import { ROOT, BILI_MJS, DSH_HOME, AGENT_CONFIG_DIR, readConfig } from './core.mjs'
import { MODULE_NAMES, moduleInstalled } from './modules.mjs'

const TEMPLATES = path.join(ROOT, 'templates')
const DIARIES = ['whale-diary.md', 'whale-diary-private.md']
const readText = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

/** 她的家是固定的（不再跟着配置里的 home 走：那会让权限边界和工具读写的位置对不上） */
export function workDir() {
  return AI_HOME
}

/**
 * 搬一个文件 / 目录（目标已存在就不搬）。返回 'moved' | 'skip' | 错误码。
 * 跨盘（EXDEV）就复制再删；别的错误不吞掉 —— 交给调用方报出来（以前悄悄失败，接着就在新位置放了空模板，老日记从此没人读）
 */
function moveIfAbsent(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return 'skip'
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return 'moved'
  } catch (e) {
    if (e?.code !== 'EXDEV') return e?.code ?? String(e)
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
      fs.rmSync(from, { recursive: true, force: true })
      return 'moved'
    } catch (e2) { return e2?.code ?? String(e2) }
  }
}

/**
 * 老作品的账：v0.8 之前交审 / 发布的记录只在作品目录的 meta.json 里（那时候它还是主人这边的数据）。
 * 搬家之前读一次，补成 ~/.bili-ai/review/<id>/ 里的 submitted.json / published.json —— 只补没有的，绝不覆盖；
 * 搬完之后 meta.json 就在她的家里了，再也不会从那里导入任何东西
 */
function importLegacyRecords(id, oldDir) {
  const metaFile = path.join(oldDir, 'meta.json')
  if (!fs.existsSync(metaFile)) return false
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))   // 读不了 / 坏了就抛出去：不知道它投没投过，先不搬
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta.json 格式不对')
  const hist = Array.isArray(meta.history) ? meta.history : []
  const status = String(meta.status ?? '')
  const live = ['submitted', 'published', 'uploading', 'rejected'].includes(status) || meta.bvid
  if (!live) return false
  const dir = path.join(REVIEW_DIR, id)
  const subFile = path.join(dir, 'submitted.json'), pubFile = path.join(dir, 'published.json')
  let wrote = false
  if (!fs.existsSync(subFile)) {
    const at = hist.find((h) => h?.status === 'submitted')?.at ?? hist[0]?.at ?? new Date().toISOString()
    const rec = { at, title: meta.title ?? null, series: String(meta.series ?? '').trim() || null, episode: meta.episode ?? null, migrated: true }
    if (status === 'rejected') rec.rejectedAt = hist.findLast?.((h) => h?.status === 'rejected')?.at ?? at
    writeJson(subFile, rec)
    wrote = true
  }
  if ((meta.bvid || status === 'published') && !fs.existsSync(pubFile)) {
    writeJson(pubFile, { bvid: meta.bvid ?? null, at: meta.publishedAt ?? new Date().toISOString(), migrated: true })
    wrote = true
  }
  // 老版本停在「投稿中」：不知道 B站 收到没有 → 记成一次结果不确定的尝试（以后批准前一定先去 B站 核对）
  if (status === 'uploading' && !meta.bvid && !fs.existsSync(path.join(dir, 'attempts.json'))) {
    addUncertainAttempt(id, { at: hist.findLast?.((h) => h?.status === 'uploading')?.at, title: meta.title ?? null, error: '老版本停在「投稿中」', kind: 'legacy' })
    wrote = true
  }
  return wrote
}

/**
 * 把老目录合并进一个「还没有 script.json」的新目录 —— 搬家之前主人那边的命令（比如 videos reject）已经在新位置写了 meta.json，
 * 以前这会让整个作品永远搬不过来。新目录里已有的文件保留（meta.json 两边合并：老历史在前、新状态为准）
 */
function mergeInto(from, to) {
  const failed = []
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name)
    if (name === 'meta.json' && fs.existsSync(b)) {
      const oldM = readJson(a, {}), newM = readJson(b, {})
      const hist = [...(Array.isArray(oldM.history) ? oldM.history : []), ...(Array.isArray(newM.history) ? newM.history : [])]
      try { writeJson(b, { ...oldM, ...newM, history: hist.slice(-50) }); fs.rmSync(a, { force: true }) } catch (e) { failed.push(`${name}: ${e?.code ?? e}`) }
      continue
    }
    const r = moveIfAbsent(a, b)
    if (r !== 'moved' && r !== 'skip') failed.push(`${name}: ${r}`)
  }
  try { if (!fs.readdirSync(from).length) fs.rmdirSync(from) } catch {}
  return failed
}

/** 老布局 → 新布局。返回 { moved: [...], failed: ['名字: 错误码', ...], imported: [...] }（只搬目标不存在的，绝不覆盖） */
export function migrateLayout() {
  const moved = [], failed = [], imported = []
  const old = (...p) => path.join(DSH_HOME, ...p)
  const tryMove = (from, to, label) => {
    const r = moveIfAbsent(from, to)
    if (r === 'moved') moved.push(label)
    else if (r !== 'skip') failed.push(`${label}: ${r}`)
  }
  for (const f of [...DIARIES, 'channel.md', 'channel-feedback.md']) {
    // 修复已经中招的安装：老文件还在、新位置只是一份没动过的空模板（上次搬家失败后放的）→ 用老文件替换模板
    const target = path.join(AI_HOME, f)
    const tpl = f === 'channel.md' ? CHANNEL_TEMPLATE : DIARIES.includes(f) ? readText(path.join(TEMPLATES, f)) : null
    if (tpl != null && fs.existsSync(old(f)) && readText(target) === tpl) { try { fs.rmSync(target) } catch {} }
    tryMove(old(f), target, f)
  }
  const oldStudio = old('studio')
  if (path.resolve(oldStudio) !== path.resolve(STUDIO_DIR)) {
    let ents = []
    try { ents = fs.readdirSync(oldStudio, { withFileTypes: true }) } catch {}
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const from = path.join(oldStudio, e.name)
      if (e.name === '.cache') tryMove(from, CACHE_DIR, 'studio/.cache')
      else if (e.name === 'stats') tryMove(from, STATS_DIR, 'studio/stats')
      else if (fs.existsSync(path.join(from, 'script.json')) && /^[0-9A-Za-z_-]{3,80}$/.test(e.name)) {
        // 先把账补进来，补成功了才搬：搬走之后 meta.json 就在她的家里了，再也不能从那里导入（Astra 审查：
        // 以前导入失败了照样搬，下次迁移就找不到这个作品了 —— BV、集数、周名额全丢）
        try { if (importLegacyRecords(e.name, from)) imported.push(e.name) } catch (err) {
          failed.push(`studio/${e.name} 的交审记录没补上（${err?.code ?? err?.message ?? err}），作品先不搬，下次再试`)
          continue
        }
        const to = path.join(STUDIO_DIR, e.name)
        if (fs.existsSync(to) && !fs.existsSync(path.join(to, 'script.json'))) {
          const f = mergeInto(from, to)
          if (f.length) failed.push(...f.map((x) => `studio/${e.name}/${x}`))
          else moved.push('studio/' + e.name)
        } else if (fs.existsSync(to)) failed.push(`studio/${e.name}: 新位置已经有同名作品（两边都有 script.json），没动 —— 请主人手动处理`)
        else tryMove(from, to, 'studio/' + e.name)
      }
    }
  }
  return { moved, failed, imported }
}

/** 搬家有没有搬不动的：主人的命令 / 宿主日志会把它说出来（以前全吞掉，日记就这么悄悄断了） */
export function reportMigration(r, log = console.warn) {
  if (r.failed.length) log(`[bili-whale-cc] 老数据有 ${r.failed.length} 项没搬进她的家（${AI_HOME}）：\n  · ${r.failed.join('\n  · ')}\n  关掉占用这些文件的程序（编辑器 / 同步盘）后，再跑任意一条 cli 命令会自动重试`)
  return r
}

/**
 * 守则模板里属于可拔模块（QQ、陌生人私信）的字，用标记圈起来（2026-10-28，开源第 4 步）：
 *   整行：单独一行 `<!-- module:qq -->` …… 单独一行 `<!-- /module:qq -->`（中间是一节、工具表里的一行都行）
 *   行内：`……<!-- module:sdm -->半句话<!-- /module:sdm -->……`（不跨行）
 * 装了这个模块 → 只去掉标记，留下的字和加标记之前一字不差；没装（公开版）→ 连同中间的字一起去掉。
 * 可以套着写：QQ 那一节里提到陌生人私信的半句，再用 sdm 圈一次（只装了 QQ 的也读不到陌生人私信）。
 * installed：名字 → 装没装，默认看 host/modules/ 里有没有报到单。
 * 标记写坏了（没配对、名字不认识、标记行上还有别的字）→ 抛错，不把半截守则交给她
 */
export function renderModules(text, installed = moduleInstalled) {
  const broken = (what) => new Error(`守则模板里的模块标记没配对：${what.slice(0, 60)}（整行的标记要单独占一行，行内的不能跨行）`)
  // 先看一遍：凡是注释里提到 module 的，都得是规规矩矩的 <!-- module:名字 --> / <!-- /module:名字 -->，名字认识 —— 写歪的不会被当成普通注释漏过去
  for (const m of text.matchAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))/g)) {
    if (!/module/i.test(m[0])) continue
    const ok = /^<!-- \/?module:([a-z]+) -->$/.exec(m[0])
    if (!ok) throw broken(m[0])
    if (!MODULE_NAMES.includes(ok[1])) throw new Error(`守则模板里有不认识的模块标记 module:${ok[1]}（认识的：${MODULE_NAMES.join(' / ')}）`)
  }
  const keep = (name) => !!installed(name)
  const TAG = /<!-- (\/?)module:([a-z]+) -->/g
  // 再一行一行走：整行的标记进出一个栈（关的必须和最近开的同名），行内的在本行里配好；全部配对之前什么都不交出去
  const out = [], blocks = []
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '')
    const tags = [...bare.matchAll(TAG)]
    const hidden = blocks.some((b) => !b.keep)
    if (tags.length === 1 && tags[0][0] === bare) {
      const [, close, name] = tags[0]
      if (!close) blocks.push({ name, keep: keep(name) })
      else if (blocks.at(-1)?.name !== name) throw broken(bare)
      else blocks.pop()
      continue
    }
    if (!tags.length) { if (!hidden) out.push(line); continue }
    let kept = '', at = 0
    const inline = []
    for (const m of tags) {
      if (!inline.some((x) => !x.keep)) kept += bare.slice(at, m.index)
      at = m.index + m[0].length
      if (!m[1]) inline.push({ name: m[2], keep: keep(m[2]) })
      else if (inline.at(-1)?.name !== m[2]) throw broken(bare)
      else inline.pop()
    }
    if (inline.length) throw broken(bare)
    if (!hidden) out.push(kept + bare.slice(at) + line.slice(bare.length))
  }
  if (blocks.length) throw broken(`<!-- module:${blocks.at(-1).name} -->`)
  return out.join('')
}

export function ensureWorkDir(cfg = readConfig()) {
  const dir = workDir()
  fs.mkdirSync(dir, { recursive: true })
  if (cfg.home) console.warn('[bili-whale-cc] 配置里的 home 已不再生效：她的家固定在 ' + dir + '（权限边界跟着它走）')
  reportMigration(migrateLayout())
  const fill = (s) => s.replaceAll('{{WORK_DIR}}', dir).replaceAll('{{DSH_HOME}}', DSH_HOME)
  // 没装的模块（QQ、陌生人私信）那几段先去掉，装了的只去掉标记（见 renderModules）
  const rules = fill(renderModules(fs.readFileSync(path.join(TEMPLATES, 'CLAUDE.md'), 'utf8')))
  // 守则真正生效的那一份：她专用的 Claude Code 配置目录里的 CLAUDE.md（user 层，会话只加载这一层；她读不到也写不到）。
  // 那个目录的 settings.json 也每次重写成空的 —— 权限全部由宿主在命令行上给（见 host/claude.mjs permissionArgs）
  fs.mkdirSync(AGENT_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(AGENT_CONFIG_DIR, 'CLAUDE.md'), rules)
  fs.writeFileSync(path.join(AGENT_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }, null, 2) + '\n')
  // 她家里也放一份同样的守则，给她自己 Read（这一份属于 project 层，不会被当成守则加载；她改了也没用，而且每次醒来前重写）
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), rules)
  try { fs.rmSync(path.join(dir, 'CLAUDE.local.md'), { force: true }) } catch {}   // 守则只有上面那一份（她的会话也不许写这个文件）
  // 垫片：钉死数据目录，并且标明「这是她在用」—— 工具据此把她的发言一律按自主计额度、拒绝主人专用命令。
  // 环境变量她改不了（Bash 只放行 `node bili.mjs …`），垫片本身她的会话也不许改，且每次醒来前重写。
  fs.writeFileSync(path.join(dir, 'bili.mjs'), [
    '// bili-whale-cc 生成的垫片：转到工具链入口（参数原样透传）。别改它 —— 每次醒来前都会重写。',
    `process.env.DSH_HOME = ${JSON.stringify(DSH_HOME)}`,
    `process.env.BILI_WHALE_AI_HOME = ${JSON.stringify(dir)}`,
    "process.env.BILI_WHALE_AGENT = '1'",
    `await import(${JSON.stringify(pathToFileURL(BILI_MJS).href)})`,
    '',
  ].join('\n'))
  for (const name of DIARIES) {
    const target = path.join(dir, name)
    // 老位置的日记还在（搬家失败了）就**不**放空模板：放了的话，下次搬家看到目标已存在就永远不搬了
    if (!fs.existsSync(target) && !fs.existsSync(path.join(DSH_HOME, name))) fs.copyFileSync(path.join(TEMPLATES, name), target)
  }
  return dir
}
