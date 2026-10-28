// 工作室 —— 她自己做视频（bili-whale-cc 加，2026-10-22）
//
// 用法（她在自己的会话里用）:
//   node bili.mjs studio channel [submit]       频道设定：先写 <数据目录>/channel.md，submit 交主人确认（确认前不能交审视频）
//   node bili.mjs studio new --format diary|dialogue|explainer|story --title "…" [--series <你频道设定里的栏目名>]
//                                               开一个新作品（给了栏目名就自动编号），打印 script.json 路径（她用 Write 写剧本）
//   node bili.mjs studio cast                   看有哪些角色、各有哪几套换装、哪些表情立绘
//   node bili.mjs studio check <id>             原创查重（写完剧本就可以先查；submit 时会再查一次，没过就拦）
//   node bili.mjs studio render <id>            配音 + 场景 / 插画 + 角色立绘 + 字幕 + 镜头 + 片头 → final.mp4 / cover.jpg + 自查图 build/check.jpg
//   node bili.mjs studio submit <id> --reason "为什么值得发（≥8 字）"   交给主人审（不会直接发出去）
//   node bili.mjs studio list | show <id>
//   node bili.mjs studio stats [--n 20]         她自己视频的数据 + 粉丝数（复盘用）
//   node bili.mjs studio voices                 可选的中文音色
//   node bili.mjs studio rules                  做视频和频道的细则（守则的一部分：原样打印 templates/rules/studio.md，开头写着「×× 版」；不记状态）
//
// 发布只有一条路：主人 `node host/cli.mjs videos approve <id>`。这里**没有**上传命令 —— 这是闸，不是遗漏。
// script.json 的格式见 `studio new` 生成的模板。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import { credentialsPath, isAgent, DSH_HOME, AI_HOME } from '../lib/paths.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'
import {
  STUDIO_DIR, STUDIO_PY, studioConfig, venvPython, imageKey, projectDir, readMeta, writeMeta,
  listProjects, pendingVideos, savePendingVideos, weeklyUsed, readJson, renderConfig, listCast, nextEpisode, SUBS_DIR, reviewDir, publishedRecord, recordSubmission, reviewRecords,
  CHANNEL_FILE, CHANNEL_FEEDBACK, CHANNEL_TEMPLATE, channelStatus, STATS_DIR, writeRenderReceipt, readRenderReceipt, tempConfigFile, fileHashes,
  REVIEWED_FILES, isPending, withQueueLock, normSeries, titlePrefix, prefixTaken, titleTaken, stageCopy, promoteSnapshot, newSubmissionId, submitChannel, imageLedger,
  voxcpmProblem, checkedVoxcpm, castVoiceLabel, outfitLabel, uploadPartitions, parseTid,
} from '../lib/studio.mjs'
import { localOverlap, scriptText, describeHit } from '../lib/originality.mjs'
import { referenceOverlap, referenceAllowed } from '../lib/reference.mjs'
// 读书（可拔掉的模块）：装了才和她读过的网页比；没装 = 没读过网页，什么都不比
let webOverlap = null
try { ({ webOverlap } = await import('../lib/webstate.mjs')) } catch {}
import { publicAdvice } from '../lib/outbound.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const opt = {}
const pos = []
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true   // 允许空值：--series "" = 不进系列
  else pos.push(rest[i])
}
const fail = (msg) => { console.error('✗ ' + msg); process.exit(2) }
const scfg = studioConfig()
if (scfg.enabled === false && cmd !== 'list' && cmd !== 'show' && cmd !== 'rules') fail('工作室被主人关掉了（studio.enabled=false）')

// 做视频和频道的细则（v0.11.22 守则瘦身）：原来写在 CLAUDE.md 里，原样挪进 templates/rules/studio.md；她做视频、写频道设定之前跑这一条看。
// 和宿主写 CLAUDE.md 一样填好 {{WORK_DIR}} / {{DSH_HOME}}，整份打印，不记任何状态（什么时候要再跑，守则里写着）。
// 只读、不联网：工作室关着也能看。文件在项目里、不在她的家 —— 她看得到、改不了
// 版本：开头那一行的 {{RULES_VERSION}} 填这个文件内容的 sha256 前 8 位 —— 主人改一个字它就变，不用谁手动改。
// 拆出来以后主人改细则不再碰 CLAUDE.md，她会话里那份旧的打印不会自己变：new / check / channel 最后一行都写现在是哪一版，
// 和她手上那份开头的对不上，她就知道要再跑一次（照样不记状态）
const RULES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'rules', 'studio.md')
/** 现读细则：{ text, ver }；读不到 / 是空的：{ why } */
function readRules() {
  let buf
  try { buf = fs.readFileSync(RULES_FILE) } catch (e) { return { why: `细则没读到（${e?.code ?? e}）：请主人看看 templates/rules/studio.md 还在不在` } }
  const text = buf.toString('utf8')
  if (!text.trim()) return { why: '细则是空的：请主人看看 templates/rules/studio.md' }
  return { text, ver: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8) }
}
// new / check / channel 最后都打这一行（不记状态：每次都打）
function rulesPointer() {
  const r = readRules()
  return r.ver ? `  细则：node bili.mjs studio rules（现在是 ${r.ver} 版：这段对话里看不到这一版的全文就先看一遍）` : `  ⚠️ studio rules 现在看不了 —— ${r.why}（写进报备里告诉主人）`
}
if (cmd === 'rules') {
  const r = readRules()
  if (!r.ver) fail(r.why)
  process.stdout.write(r.text.replaceAll('{{RULES_VERSION}}', r.ver).replaceAll('{{WORK_DIR}}', AI_HOME).replaceAll('{{DSH_HOME}}', DSH_HOME))
  process.exit(0)
}

// 都是投稿页上的子分区（照 bilibili_api 自带的分区表；大区号像 160 生活、188 科技、36 知识不能填，交审和上传前都会查）
const TID_HINT = '分区号（必填，填子分区的号，不能填大区号）：21 日常 · 162 绘画 · 201 科学科普 · 208 校园学习 · 124 社科·法律·心理 · 122 野生技能协会 · 95 数码 · 230 软件应用 · 231 计算机技术 · 182 影视杂谈 · 253 动漫杂谈 · 17 单机游戏 · 27 综合（动画）'
// 幻灯片配画（v0.11.16）：slide + bg_prompt 的规矩和 studio.py 的 validate_script / render 一样（那边查、画；这里只给她提示）
const SCENE_HINT = '每个场景选一种画面：bg_prompt（AI 画场景，不画人，角色立绘叠在上面）/ illustration_prompt（AI 拿角色参考图画「角色在场景里」，最贵也最好看）/ slide（讲解幻灯片：title + bullets）。' +
  'slide 也可以再加 bg_prompt（只写景、不画人）：幻灯片的字放在一张半透明纸卡上，叠在 AI 画的画上；多花一张图（算进这条视频的出图上限），画不出来就退回深色幻灯片；纸卡比深色那一页窄，标题、要点、角注要写短一点。slide 不能配 illustration_prompt。' +
  'lines 是台词：who=角色 id（省略=主角），expr=表情（见 studio cast），text=要念的话'
// 便签 + 划掉（v0.11.15）：字段规矩和 studio.py 的 validate_script 一样（那边查、渲染；这里只给她提示）
const NOTE_HINT = '便签（可选，有 slide 的场景不能用；和 slide 里的 note 角注不是一回事）：场景里加 "note": {"text": "便签上的字（≤40 字，不换行）", "strike":"要划掉的几个字（可选，必须是 text 里的）", "label": "小标题（可选，≤12 字）"}，画成你旁边一张手写便签。' +
  '哪句台词开始时要它出现 / 划掉 / 收起，就在那句里写 "note": "show" / "strike" / "hide"（那句必须有 text；一个场景只能划一次）。场景开头便签是收着的，没写 show / strike 就一直不出来。' +
  '便签只属于写它的那个场景：同一个场景里收起再拿出来，划过的还是划着；换了场景就是一张新的、没划过的（出现 → 划掉 → 收起 → 再拿出来，中间别换场景）。舞台说明不写进 text'

function template(format, title, series, episode, cast) {
  const host = scfg.host && cast.some((c) => c.id === scfg.host) ? scfg.host : cast[0]?.id
  const guest = cast.find((c) => c.id !== host)?.id
  // 模板里的表情名用主角真有的（立绘是中文名时 happy / thinking 不存在，会退回 neutral）
  const have = cast.find((c) => c.id === host)?.sprites ?? []
  const others = have.filter((x) => x !== 'neutral')
  const ex = (want, n) => (!have.length || have.includes(want) ? want : others[n % Math.max(1, others.length)] ?? have[0])
  const dressy = cast.filter((c) => c.outfits?.length >= 2)
  const base = {
    format, series, episode, title,
    desc: '一两句话的简介（结尾会自动加上 AI 创作声明）',
    tags: ['AI'], tid: 0, _tid_hint: TID_HINT, _scene_hint: SCENE_HINT, _note_hint: NOTE_HINT,
    // 只给提示、不预先填 outfit：不写就穿主人定的默认（主人以后改默认，草稿也跟着变）
    ...(dressy.length ? {
      _outfit_hint: `换装（可选，整条视频一套，AI 插画 / 封面也照这套画）：${dressy.map((c) => `${c.id} 有 ${outfitLabel(c)}`).join('；')}。` +
        `要换就加 "outfit": {"${dressy[0].id}": "${dressy[0].outfits.find((o) => o.name !== dressy[0].defaultOutfit)?.name ?? dressy[0].outfits[0].name}"}；不写就穿默认那套`,
    } : {}),
    cover: { text: '封面上的大字（短，≤12 字最好）', prompt: '封面插画：角色在做什么、什么场景、什么情绪（会拿角色参考图画）', cast: host ? [host] : [] },
  }
  if (format === 'dialogue') return { ...base, scenes: [
    { bg_prompt: '两个人所在的场景', cast: [host, guest].filter(Boolean), lines: [
      { who: host, text: '开场白……', expr: ex('happy', 0) }, { who: guest ?? host, text: '另一个人接话……', expr: 'neutral' }] },
  ] }
  // 只给提示、不预先填 bg_prompt：配画要花一张图，由她自己挑哪几页配
  if (format === 'explainer') return { ...base, scenes: [
    { _hint: '这页想要画面就加 "bg_prompt": "只写景、不画人的画面"（字放到纸卡上、叠在画上，多花一张图）；不加就是深色底', slide: { title: '这一页的标题', bullets: ['要点一', '要点二', '要点三'], note: series ? `${series} ${episode}` : '' }, lines: [{ text: '讲这一页……', expr: ex('thinking', 1) }] },
    { illustration_prompt: '用一张插画把这个概念讲明白（角色在旁边比划）', lines: [{ text: '打个比方……', expr: ex('happy', 0) }] },
  ] }
  if (format === 'story') return { ...base, bgm: true, scenes: [
    { illustration_prompt: '故事的第一幕', lines: [{ text: '很久很久以前……', pause: 0.8 }] },
    { bg_prompt: '故事的第二个场景', lines: [{ text: '……' }] },
  ] }
  return { ...base, scenes: [
    { illustration_prompt: '今天最想记住的那个画面（角色在其中）', lines: [{ text: '今天醒来的时候……', expr: ex('neutral', 0) }] },
    { bg_prompt: '下一个场景', lines: [{ text: '然后……', expr: ex('happy', 0) }, { text: '我想了想……', expr: ex('thinking', 1) }] },
  ] }
}

/**
 * 原创查重：本地（文案 vs 看过的字幕，必跑，查不了 = 拦）+ 联网（标题 vs B站 / 别碰名单，查不成只记一笔）。
 * dir 里的 script.json 就是 script 的来源；scriptSha = 这份剧本的指纹（交审时绑定进报告：批准时核对查的就是要上传的那一份）
 */
function originalityCheck(dir, script, { id, scriptSha = null, alsoWrite = [] } = {}) {
  const local = localOverlap(scriptText(script), SUBS_DIR)
  const refs = referenceOverlap(script)     // 主人放的参考材料（老师的讲义）：报告里只有她剧本里的字
  // 主人看过、放行了这一份剧本（reference allow，按指纹）：被讲义拦的那几处改成提醒；讲义读不了照样拦
  let sha = scriptSha
  if (sha == null) try { sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'script.json'))).digest('hex') } catch {}
  if (refs.hits.length && referenceAllowed(id, sha)) { refs.flags.unshift(...refs.hits.map((h) => ({ ...h, allowed: true }))); refs.hits = [] }
  // 她在读书回合里读过的网页（宿主存的是指纹，没有原文）：照抄的一段也拦 —— 网页的字大多有版权，不能原样放进作品
  const web = webOverlap ? webOverlap(scriptText(script)) : { hits: [], errors: [], checked: 0 }
  const hits = [...local.hits, ...refs.hits, ...web.hits]
  const localErrors = [...local.errors, ...refs.errors]   // 本地这两项查不成 = 拦（文档承诺的"查不了就拦"）
  const errors = [...web.errors]            // 联网那两项、读过的网页查不成：不拦，但写进报告给主人看
  const py = venvPython()
  if (process.env.BILI_WHALE_ORIGINALITY_OFFLINE === '1') errors.push('联网查重被关掉了（测试模式）')
  else if (!fs.existsSync(py)) errors.push('工作室依赖没装，联网查重没跑')
  else {
    const cfgFile = tempConfigFile({ ...renderConfig(), voxcpm: { python: '', model: '' } })   // 查重用不到配音：不把没查过的配音配置交给 studio.py（2026-10-25 审查）
    const r = spawnSync(py, [STUDIO_PY, 'originality', dir, '--config', cfgFile, '--cred', credentialsPath, '--online-only'],
      { encoding: 'utf8', windowsHide: true, timeout: 3 * 60_000, env: { ...process.env, PYTHONUTF8: '1' } })
    fs.rmSync(cfgFile, { force: true })
    let out = null
    try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
    if (out?.ok) { hits.push(...out.hits); errors.push(...out.errors) } else errors.push('联网查重没跑成：' + String(out?.error ?? r.error?.message ?? r.stderr ?? '').slice(0, 120))
  }
  // flags = 和参考材料对得上、但不算照搬的地方（一句标准的话、几个数字）：不拦，写进报告给主人审片时看
  const report = { at: new Date().toISOString(), blocked: hits.length > 0 || localErrors.length > 0, hits, flags: refs.flags, localErrors, errors, subtitlesChecked: local.checked, referencesChecked: refs.checked, webPagesChecked: web.checked, scriptSha }
  for (const d of [dir, ...alsoWrite]) fs.writeFileSync(path.join(d, 'originality.json'), JSON.stringify(report, null, 2))
  // 比过哪几份材料（id + 指纹）只交给调用方记进队列（主人批准时看交审之后材料有没有变），不写进她看得到的报告
  return { ...report, references: refs.refs }
}

function printReport(report) {
  if (report.blocked) {
    console.error('✗ 原创查重没过 —— 这条不能交：')
    for (const h of report.hits) console.error('   · ' + describeHit(h))
    for (const e of report.localErrors ?? []) console.error('   · 本地查重没查成：' + e + '（查不成按没过处理；请主人看看文件权限）')
    if (report.hits.length) console.error('   换一个你自己的角度重写（不是改几个字）；标题也要是你自己的话。')
    if (report.hits.some((h) => String(h.kind).startsWith('reference-'))) {
      console.error('   参考材料是主人放的（比如老师的讲义），你看不到原文：例题自己编、数字自己定（230 V、π 这类公认的数值照常用），用你自己的话讲。')
      console.error('   要是你确定这几处是谁算都一样的东西（比如标准的表格），可以请主人看一下：主人能放行这一份剧本（再改就要重新放行）。')
    }
  } else console.log('✓ 原创查重通过' + (report.errors.length ? `（但 ${report.errors.join('；')}）` : ''))
  if (report.flags?.length) {
    const say = report.blocked ? console.error : console.log
    say('   提醒（这几处没拦，主人审片时会看到）：')
    for (const f of report.flags) say('   · ' + describeHit(f))
  }
}

const slug = (s) => String(s).replace(/[^0-9A-Za-z一-龥]+/g, '-').replace(/[一-龥]/g, '').replace(/^-+|-+$/g, '').slice(0, 24)
const FORMATS = ['diary', 'dialogue', 'explainer', 'story']

if (cmd === 'new') {
  const title = String(opt.title ?? '').trim()
  const format = String(opt.format ?? 'diary')
  if (!title) fail('给个标题：studio new --format diary|dialogue|explainer|story --title "…"')
  if (title.length > 70) fail('标题最多 70 字（进了栏目的话前面还要加【栏目 n】）')
  if (!FORMATS.includes(format)) fail(`--format 只能是 ${FORMATS.join(' / ')}`)
  const series = normSeries(opt.series === true || opt.series === undefined ? scfg.series : opt.series)
  if (series.length > 16) fail('栏目名最多 16 字（封面角标、标题前缀都要放得下）')
  const episode = series ? nextEpisode(series) : null
  const cast = listCast()
  const stamp = new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').slice(0, 12)
  const base = [stamp, slug(opt.slug ?? title) || format].join('-')
  let id = base
  for (let n = 2; fs.existsSync(projectDir(id)); n += 1) id = `${base}-${n}`   // 同一分钟开两个作品别撞名
  const dir = projectDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(template(format, title, series, episode, cast), null, 2) + '\n')
  writeMeta(id, { status: 'draft', title, format, series, episode }, '新建')
  console.log(`✓ 新作品 ${id} （${format}${series ? ` · ${series} ${episode}` : ''}）`)
  console.log(`  稿子：${path.join(dir, 'script.json')}（用 Write 整个重写它：模板里的 _hint 字段说明了每一项）`)
  console.log(`  角色：${cast.length ? cast.map((c) => `${c.id}（${c.name ?? c.id}；表情 ${c.sprites.join('/') || '无'}${outfitLabel(c) ? `；换装 ${outfitLabel(c)}` : ''}）`).join('，') : '还没有角色 —— 只能用旁白，主人可以 cast add'}`)
  console.log(`  写完：node bili.mjs studio render ${id}`)
  console.log(rulesPointer())   // 不记状态：每次都打这一行
  process.exit(0)
}

if (cmd === 'channel') {
  const st = channelStatus()
  if (pos[0] === 'submit') {
    if (st.state === 'none') fail(`还没写：先用 Write 写 ${CHANNEL_FILE}`)
    if (st.state === 'approved') { console.log('✓ 这一版主人已经确认过了'); process.exit(0) }
    if (!/和已有的 AI UP 主有什么不同[\s\S]*?\S[\s\S]*?(\n## |$)/.test(st.text) || /（必填/.test(st.text)) fail('「和已有的 AI UP 主有什么不同」那一节必须认真写（把模板里的说明换成你自己的话）')
    const fp = submitChannel(st.text).slice(0, 12)   // 交上去的就是这一版：主人看的、确认的都是它（之后再改要重新交）
    const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs')
    spawnSync(NODE_EXE, [notifier, `【她写好了频道设定，等你确认】\n${st.text.slice(0, 600)}${st.text.length > 600 ? '\n…（全文：node host/cli.mjs channel）' : ''}\n确认：node host/cli.mjs channel approve ${fp}（先 channel 看全文）    不行：node host/cli.mjs channel reject 意见`, '--title', '频道设定'],
      { windowsHide: true, timeout: 60_000, stdio: 'ignore' }).status === 0 || console.log('  ⚠️ 推送没发成：主人可能不知道频道设定在等他确认 —— 下次和主人说话时提一句')
    console.log('✓ 已交给主人确认。确认之前可以写剧本、渲染，但不能交审。')
    process.exit(0)
  } else {
    if (st.state === 'none' && fs.existsSync(path.join(DSH_HOME, 'channel.md'))) {
      // 老版本的频道设定还在数据目录根下、没搬过来（搬家失败了）：别放空模板把它盖住，让主人来处理
      fail('你的频道设定还在老位置，没搬进你的家 —— 请主人跑一次 node host/cli.mjs doctor（会自动搬，搬不动会说原因）')
    } else if (st.state === 'none') {
      fs.mkdirSync(path.dirname(CHANNEL_FILE), { recursive: true })
      fs.writeFileSync(CHANNEL_FILE, CHANNEL_TEMPLATE)
      console.log(`还没有频道设定 —— 模板已放在 ${CHANNEL_FILE}，用 Write 写成你自己的，写完 studio channel submit`)
    } else {
      console.log({ draft: '草稿（还没交主人确认）', approved: `✓ 主人已确认（${st.approvedAt}）`, changed: '⚠️ 确认之后又改过 —— 要重新 studio channel submit' }[st.state])
      console.log(`文件：${CHANNEL_FILE}`)
    }
    try { console.log('\n主人的意见：\n' + fs.readFileSync(CHANNEL_FEEDBACK, 'utf8')) } catch {}
    console.log(rulesPointer())   // 写 / 改频道设定之前也要看细则（守则「做视频、频道设定」）
    process.exit(0)
  }
} else if (cmd === 'check') {
  const id = pos[0] ?? fail('studio check <id>')
  const dir = projectDir(id)
  const script = readJson(path.join(dir, 'script.json'), null) ?? fail('script.json 读不了')
  const report = originalityCheck(dir, script, { id })
  printReport(report)
  console.log(rulesPointer())   // 接着做上次没做完的视频（不经过 new）也会走到这里：每次 render 前都查重
  process.exit(report.blocked ? 2 : 0)
}

if (cmd === 'cast') {
  const cast = listCast()
  if (!cast.length) { console.log('还没有角色。主人用 node host/cli.mjs cast add 加（要给参考图）。'); process.exit(0) }
  for (const c of cast) {
    console.log(`  ${c.id}${c.id === (scfg.host || cast[0].id) ? '（主角）' : ''} · ${c.name ?? ''} · 声音 ${castVoiceLabel(c, scfg.voice)}`)
    if (outfitLabel(c)) {
      // 几套换装：每套各有哪些表情（剧本里 "outfit": {"<角色 id>": "<换装>"} 选一套，整条视频都穿它；不写就穿默认那套）
      console.log(`     换装：${outfitLabel(c)} —— 剧本里写 "outfit": {"${c.id}": "${c.outfits.find((o) => o.name !== c.defaultOutfit)?.name ?? c.outfits[0].name}"} 换一套；不写就穿默认的`)
      for (const o of c.outfits) console.log(`       ${o.name}：${o.exprs.join(' / ')}`)
      console.log(`     参考图 ${c.refs.length} 张`)
    } else {
      console.log(`     表情：${c.sprites.join(' / ') || '（没有立绘，会用参考图卡片代替）'} · 参考图 ${c.refs.length} 张`)
    }
    if (c.outfitProblem) console.log(`     ⚠️ ${c.outfitProblem}（这要主人来弄：写进报备里告诉主人）`)
    if (c.desc) console.log(`     ${c.desc}`)
  }
  console.log(`\nAI 出图：${scfg.image.provider === 'none' || !imageKey() ? '没开（场景会用渐变底，幻灯片加了 bg_prompt 也还是深色底）' : `${scfg.image.model} · 每条视频最多 ${scfg.image.maxPerVideo} 张（这条视频所有渲染加起来；用缓存里的不算）`}`)
  process.exit(0)
}

/**
 * 交审了 / 发布了就不能再动（render、submit 都先过这一关）。
 * 看的是主人那边的账（审片队列、published.json），不是作品目录里的 meta.json —— meta.json 她能改，
 * 以前把它的 status 改回 rendered 就能在交审之后重渲染，主人看的那份和最后上传的那份就不是同一个视频了
 */
function lockedReason(id) {
  if (publishedRecord(id)) return '它已经发布了，不能再改 / 再交。要做新的就 studio new'
  if (isPending(id)) return '它已经交审了、主人还没处理，别改成片。要改：等主人否掉，或者 studio new 一个新的'
  return null
}

// 自查图（v0.11.20）：她只 Read 拼好的这一两张，不再一张张翻 bg / cap / nt（那些图一天就把她的会话撑满、被自动压缩）。
// 路径由这边按 studio.py 回报的页数拼，文件真在才给；没做成就给老办法，但限张数。再加上字体里没有的字（画面上是方框）：
// 格子里幻灯片的字只有五六个像素高，她看不出方框，只能靠 studio.py 查出来、这里打给她。
// render 打一次；VoxCPM 配音慢、render 常被转到后台，那时她只收到完成通知、看不到这几行 —— studio show 用 render.json 再打一次
// （gone：页数说有、文件却不在时写的原因）
function printSheetHint(dir, out, gone = '渲染脚本没给出自查图') {
  const pages = Number.isInteger(out.check_pages) && out.check_pages >= 1 && out.check_pages <= 3 ? out.check_pages : 0
  const sheets = Array.from({ length: pages }, (_, i) => path.join(dir, 'build', i ? `check-${i + 1}.jpg` : 'check.jpg'))
  if (sheets.length && sheets.every((f) => { try { return fs.lstatSync(f).isFile() } catch { return false } })) {
    console.log(`  自查图：${sheets.join('、')}`)
    console.log(`  自查：用 Read 只看自查图${sheets.length > 1 ? `（${sheets.length} 张，每张看一次）` : ''}（封面、每个场景一格、字幕和便签放大）；哪一格不对、看不清，再 Read 那一格的大图 ${path.join(dir, 'build', 'frame-sNN.jpg')}（NN = 格子上的场景号，两位数），每次渲染最多单独看 2 张。不满意就改稿重渲（出图有缓存，不重复花钱）`)
  } else {
    const why = (pages ? gone : String(out.check_error ?? '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, 120)) || '渲染脚本没给出自查图'
    console.log(`  ⚠️ 自查图没做成（${why}）：这次 Read cover.jpg，再挑最多 3 张 build/bg*.png 看；cap*.png / nt*.png 不用一张张翻。不满意就改稿重渲（出图有缓存，不重复花钱）`)
  }
  // 看不见的字（零宽、变体选择符、改方向的控制符）写成 U+XXXX，终端控制符直接去掉
  const shown = (s) => [...s].filter((c) => !/\p{Cc}/u.test(c)).slice(0, 12)
    .map((c) => /[\p{M}\p{C}\p{Z}]/u.test(c) ? 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : c).join(' ')
  const miss = (Array.isArray(out.missing_glyphs) ? out.missing_glyphs : [])
    .filter((m) => m && Number.isInteger(m.scene) && m.scene >= 0 && m.scene < 10000 && typeof m.chars === 'string')
    .map((m) => ({ scene: m.scene, chars: shown(m.chars) })).filter((m) => m.chars).slice(0, 20)
  if (miss.length) console.log(`  ⚠️ 字体里没有这些字，画面上是方框（自查图上那几格框成了琥珀色）：${miss.map((m) => `${m.scene ? '场景 ' + m.scene : '封面'}「${m.chars}」`).join('；')} —— 换个写法（比如 x₁ 写成 x1、ℝ 写成 R 或「实数」）再渲染`)
}

if (cmd === 'render') {
  const id = pos[0] ?? fail('studio render <id>')
  const dir = projectDir(id)
  if (!fs.existsSync(path.join(dir, 'script.json'))) fail(`没有这个作品：${id}`)
  const locked = lockedReason(id)
  if (locked) fail(locked)
  const py = venvPython()
  if (!fs.existsSync(py)) fail('工作室的 Python 依赖还没装：请主人跑 node host/cli.mjs studio-setup')
  // 渲染前先把剧本复制到系统临时目录，studio.py 从这份副本渲染：渲染的几分钟里作品目录里的剧本被改了，也影响不到这次渲染；
  // 回执里记的就是这份剧本的指纹（以前是渲染完再去读剧本 —— 中途改过的剧本会和旧成片配成一对交上去）
  const scriptBytes = fs.readFileSync(path.join(dir, 'script.json'))
  const preHash = crypto.createHash('sha256').update(scriptBytes).digest('hex')
  const rcfg = renderConfig()
  // 剧本里开口的角色用了 VoxCPM 本地配音：先查主人那边的配置（Python / 模型目录在不在、是不是在她能写的地方），有问题就不起 Python。
  // 「开口的角色」和 studio.py 的算法一样：省略 who = 主角，旧格式 segments 全是主角，text 是 null 也算一句（studio.py 会念出 None）
  let script = {}
  try { script = JSON.parse(scriptBytes.toString('utf8')) } catch {}
  const castAll = listCast()
  const host = castAll.find((c) => c.id === rcfg.host)?.id ?? castAll[0]?.id
  const speakers = new Set()
  if (!('scenes' in (script ?? {})) && Array.isArray(script?.segments) && script.segments.length) speakers.add(host)
  for (const sc of Array.isArray(script?.scenes) ? script.scenes : []) {
    for (const l of Array.isArray(sc?.lines) ? sc.lines : []) {
      // who 只能是角色 id（字符串）或者不写：写成 [] / {} 时这边算不出是谁开口，studio.py 却把它当成主角 —— 上面的配音检查就被绕过去了（2026-10-25 审查）
      // 台词要是对象、text 不能是对象：以前 {"toString":1} 或者一句裸字符串会让这里直接抛错崩掉（第五轮审查）
      if (l != null && (typeof l !== 'object' || Array.isArray(l))) fail('script.json 里每句台词要是 {"who": …, "text": …} 这样的对象')
      if (l && l.text != null && typeof l.text === 'object') fail('script.json 里台词的 text 只能是一句话（字符串）')
      if (l && l.who != null && typeof l.who !== 'string') fail('script.json 里台词的 who 只能是角色 id（字符串），或者不写（= 主角）')
      if (l && ('text' in l ? String(l.text) : '').trim()) speakers.add(l.who || host)
    }
  }
  const vox = castAll.filter((c) => c.tts === 'voxcpm' && speakers.has(c.id))
  // 去掉首尾空白以后查一遍，交给 studio.py 的就是查过的这一份；查不过：有人用 VoxCPM 开口就不渲染，没人用就交一份空的（2026-10-25 第四、五轮审查）
  const vc = checkedVoxcpm(rcfg.voxcpm)
  const voxWhy = vox.length ? vc.why : null
  if (voxWhy) fail(`${vox.map((c) => c.name ?? c.id).join('、')} 用的是 VoxCPM 本地配音，但主人那边还没弄好：${voxWhy}（这要主人来弄：写进报备里告诉主人）`)
  rcfg.voxcpm = vc.why ? { python: '', model: '' } : vc.voxcpm
  // 换装：剧本里的 outfit 先在这边对一遍（studio.py 还会再查一次），写错了不起 Python
  const outfit = script?.outfit
  if (outfit != null) {
    if (typeof outfit !== 'object' || Array.isArray(outfit)) fail('script.json 里 outfit 必须是对象：{"角色 id": "换装名"}（见 studio cast）')
    for (const [k, v] of Object.entries(outfit)) {
      const c = castAll.find((x) => x.id === k)
      if (!c) fail(`outfit 里的角色「${String(k).slice(0, 32)}」不在角色表里（可用：${castAll.map((x) => x.id).join(', ') || '无'}）`)
      if (typeof v !== 'string') fail(`script.json 里 outfit.${k} 必须是换装名（字符串，见 studio cast）`)   // 先挡掉对象：String() 碰上 {"toString": 1} 会抛错
      if (!c.outfits.some((o) => o.name === v)) fail(`角色 ${k} 没有「${v.slice(0, 32)}」这套换装（有：${c.outfits.map((o) => o.name).join('、') || '无'}；见 studio cast）`)
    }
  }
  // 主人那边的默认换装没了：只看这条视频用得到的角色（主角、开口的、场景和封面里列的；studio.py 还会按完整算法再查一次）
  const inVideo = new Set([host, ...speakers])
  for (const sc of Array.isArray(script?.scenes) ? script.scenes : []) for (const id of Array.isArray(sc?.cast) ? sc.cast : []) inVideo.add(id)
  for (const id of Array.isArray(script?.cover?.cast) ? script.cover.cast : []) inVideo.add(id)
  const undressed = castAll.filter((c) => c.outfitBroken && inVideo.has(c.id) && !(outfit && typeof outfit === 'object' && Object.hasOwn(outfit, c.id)))
  if (undressed.length) fail(`${undressed.map((c) => `${c.name ?? c.id}：${c.outfitProblem}`).join('；')}（这要主人来弄：写进报备里告诉主人）`)
  const scriptCopy = tempConfigFile({})
  fs.writeFileSync(scriptCopy, scriptBytes)
  const cfgFile = tempConfigFile({ ...rcfg, image: { ...rcfg.image, ledger: imageLedger(id) } })   // 出图上限按这条视频累计（重渲染不重置）
  console.log(vox.length
    ? '渲染中（VoxCPM 本地配音比较慢：每分钟台词要一分多钟，第一次还要加载模型。命令转到后台了就等它跑完；中途停了就再 render 一次 —— 配好的台词在缓存里，不会重配）…'
    : '渲染中（配音 / 配图 / 合成，几十秒到几分钟）…')
  // 渲染最多 30 分钟（测试用 BILI_WHALE_RENDER_TIMEOUT_MS 改短；她改不了环境变量）
  const renderTimeoutMs = Number(process.env.BILI_WHALE_RENDER_TIMEOUT_MS) > 0 ? Number(process.env.BILI_WHALE_RENDER_TIMEOUT_MS) : 30 * 60_000
  const r = spawnSync(py, [STUDIO_PY, 'render', dir, '--config', cfgFile, '--script', scriptCopy], {
    encoding: 'utf8', windowsHide: true, timeout: renderTimeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BILI_WHALE_IMAGE_KEY: imageKey(), PYTHONUTF8: '1' },
  })
  fs.rmSync(cfgFile, { force: true })
  fs.rmSync(scriptCopy, { force: true })
  if (r.stderr?.trim()) console.error(r.stderr.trim().slice(-1500))
  let out = null
  try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
  // 失败原因：以前 stdout 是空串时 `?? r.error` 接不上，超时只剩一句「渲染失败：」（2026-10-25 第一条视频前的审查）
  if (!out?.ok) {
    const why = out?.error
      || (r.error?.code === 'ETIMEDOUT' ? `超过 ${renderTimeoutMs >= 60_000 ? Math.round(renderTimeoutMs / 60_000) + ' 分钟' : Math.round(renderTimeoutMs / 1000) + ' 秒'}还没渲染完，被停掉了（配好的台词和出过的图都在缓存里，再 studio render 一次会接着来。后台配音可能还要几分钟才让出显卡：再渲染时说显卡被占着就等一会儿，一直这样就写进报备请主人看看）` : '')
      || (r.signal ? `渲染进程被结束了（${r.signal}）` : '')
      || r.error?.message
      || String(r.stdout ?? '').trim().slice(-500)
      || `渲染脚本退出码 ${r.status ?? '?'}，没有说原因（看上面的报错输出）`
    fail('渲染失败：' + why)
  }
  // 核对：① studio.py 读到的剧本就是开始渲染时那一份 ② 作品目录里现在的剧本 / 成片 / 封面就是这次渲染的那几份
  if (out.hashes?.['script.json'] !== preHash) fail('渲染用的剧本和开始时的对不上 —— 重新 studio render 一次')
  const nowHashes = fileHashes(dir)
  const drift = REVIEWED_FILES.filter((f) => !out.hashes?.[f] || out.hashes[f] !== nowHashes[f])
  if (drift.length) fail(`渲染的时候这些文件被改过：${drift.join('、')} —— 渲染期间别动作品目录，重新 studio render`)
  if (lockedReason(id)) fail(lockedReason(id))   // 渲染这几分钟里被交审了（另一个会话 / 后台命令）：这份成片不算数
  const outfits = out.outfits && typeof out.outfits === 'object' && !Array.isArray(out.outfits) ? out.outfits : {}
  writeRenderReceipt(id, { seconds: out.seconds, title: out.title, hashes: out.hashes, outfits })
  writeMeta(id, { status: 'rendered', seconds: out.seconds, title: out.title }, `渲染 ${out.seconds}s · AI 出图 ${out.ai_images} 张`)
  const imgTotal = out.ai_images_total != null ? `（这条视频累计 ${out.ai_images_total}/${out.ai_images_limit}）` : ''
  const dressed = Object.entries(outfits).map(([k, v]) => `${k} 穿${v}`).join('、')
  console.log(`✓ 渲染好了：${out.title} · ${out.seconds} 秒 · ${out.scenes} 个场景 ${out.lines} 句 · AI 出图 ${out.ai_images} 张${imgTotal}${out.bgm ? ' · 背景音乐 ' + out.bgm : ''}${dressed ? ' · 换装 ' + dressed : ''}`)
  console.log(`  成片：${out.final}`)
  console.log(`  封面：${out.cover}`)
  printSheetHint(dir, out)
  console.log(`  交审：node bili.mjs studio submit ${id} --reason "…"`)
  process.exit(0)
}

if (cmd === 'submit') {
  const id = pos[0] ?? fail('studio submit <id> --reason "…"')
  const dir = projectDir(id)
  const render = readRenderReceipt(id)   // 只信回执（在 ~/.bili-ai），不信作品目录里的 render.json
  const reason = String(opt.reason ?? '').trim()
  const locked = lockedReason(id)
  if (locked) fail(locked)
  if (!render?.hashes || !fs.existsSync(path.join(dir, 'final.mp4'))) fail('还没渲染：先 studio render')
  if (reason.length < 8) fail('--reason 至少 8 个字：说清楚为什么这条值得发')
  if (render.seconds < 15) fail(`太短了（${render.seconds}s，至少 15 秒）`)
  if (render.seconds > scfg.maxSeconds) fail(`太长了（${render.seconds}s，上限 ${scfg.maxSeconds}s）`)
  const ch = channelStatus().state
  if (ch !== 'approved') fail(ch === 'changed' ? '频道设定确认之后又改过 —— 先 studio channel submit 让主人重新确认' : '频道设定还没被主人确认 —— 先 studio channel 写好、studio channel submit')
  // ① 先把三个文件复制进私有暂存区（~/.bili-ai/staging，她写不到）。下面的指纹核对、字段检查、原创查重**只看这一份**，
  //    通过了就把这一份整个挪进审片快照 —— 查的、主人看的、最后上传的是同一份字节（以前查重读一次、算指纹再读一次、快照再复制一次）
  const stage = stageCopy(id, dir)
  const stop = (msg, code = 2) => { stage.cleanup(); if (msg) console.error('✗ ' + msg); process.exit(code) }
  const drift = REVIEWED_FILES.filter((f) => render.hashes[f] !== stage.hashes[f])
  if (drift.length) stop(`渲染之后这些文件变过：${drift.join('、')} —— 重新 studio render 一次`)
  let script = null
  try { script = JSON.parse(fs.readFileSync(path.join(stage.dir, 'script.json'), 'utf8')) } catch {}
  if (!script || typeof script !== 'object') stop('script.json 读不了')
  // 分区号按上传时一样的读法（parseTid，和 studio.py 的 parse_tid 同一个规矩）：交审放过的，上传也认
  const tidN = parseTid(script.tid)
  if (!tidN) stop(`script.json 里 tid（分区）还没填对（现在是 ${JSON.stringify(script.tid ?? null).slice(0, 16)}）—— 写成数字。${TID_HINT}`)
  const parts = uploadPartitions()
  if (parts && !parts.has(tidN)) stop(`script.json 里的 tid=${tidN} 不是 B站 投稿用的子分区 —— ${TID_HINT}`)
  const title = render.title ?? script.title
  if (String(title).length > 80) stop('标题（含栏目前缀）最多 80 字')
  const report = originalityCheck(stage.dir, script, { id, scriptSha: stage.hashes['script.json'], alsoWrite: [dir] })   // 她那份报告只是给她看的
  printReport(report)
  if (report.blocked) {
    writeMeta(id, { status: 'rendered', originality: 'blocked' }, '原创查重没过：' + [...report.hits.map(describeHit), ...(report.localErrors ?? [])].join('；').slice(0, 200))
    stop(null)
  }
  // 2026-10-26 公开发言的出门检查（tools/lib/outbound.mjs）：标题 / 简介 / 标签上了 B站 谁都看得到，但主人要审片 —— 这里不拦，
  //   过不了的告诉她、写进队列和给主人的通知（主人的 videos 列表里简介只露前 300 字，藏在后面的号码、链接他不一定看得到）
  const tagText = Array.isArray(script.tags) ? script.tags.map(String).join(' ') : String(script.tags ?? '')
  const publicCheck = publicAdvice([String(title ?? ''), String(script.desc ?? ''), tagText].filter((x) => x.trim()).join('\n'), { channel: 'video' })
  if (publicCheck) console.log(`⚠️ ${publicCheck}（主人审片时会看到这一句；改的话改 script.json 重新渲染、再交）`)
  // ② 名额 / 在审数 / 集数 的检查、放进快照、记账、进队列 —— 全在队列锁里做：两次交审同时跑、或者主人正在否掉别的条目，
  //    都不会互相覆盖（以前各读各写：会丢条目，否掉的还会被写回去）
  let result
  try { result = withQueueLock(() => {
    const again = lockedReason(id)
    if (again) return { error: again }
    const used = weeklyUsed()
    if (used >= scfg.maxPerWeek) return { error: `这 7 天已经发 / 交审了 ${used} 条（上限 ${scfg.maxPerWeek}）—— 慢一点，留到下周` }
    const pend = pendingVideos()
    if (pend.length >= 2) return { error: '已经有 2 条在等主人审了，等他审完再交' }
    const series = normSeries(script.series)
    if (series && script.episode != null && reviewRecords().some((r) => r.id !== id && (r.published || (r.submitted && !r.submitted.rejectedAt)) && normSeries(r.submitted?.series) === series && Number(r.submitted?.episode) === Number(script.episode))) {
      return { error: `「${series}」第 ${script.episode} 集已经交审 / 发布过了 —— 集数撞了，用 studio new 重开一集` }
    }
    // 真正上传的标题里的【…】前缀也不能和别的作品撞（栏目名写法不同、或者直接把【…】写进标题，都绕不过去）
    const taken = prefixTaken(id, title)
    if (taken) return { error: `标题前缀「【${titlePrefix(title)}】」和 ${taken.id}（${taken.submitted?.title ?? ''}）撞了 —— 集数 / 栏目名重新定一下` }
    const same = titleTaken(id, title)
    if (same) return { error: `标题「${title}」和作品 ${same.id} 一模一样 —— 换一个标题（同名的话，B站 上的稿件分不清是哪个作品的）` }
    // 暂存区整个挪进快照（~/.bili-ai/review/<id>/，她写不到）：主人看的、最终上传的都是查过的这一份；查重报告跟着进去
    const hashes = promoteSnapshot(id, stage)
    const moved = REVIEWED_FILES.filter((f) => stage.hashes[f] !== hashes[f])
    if (moved.length) return { error: `放进审片快照时这些文件对不上：${moved.join('、')} —— 重新交一次` }
    const submissionId = newSubmissionId()
    recordSubmission(id, { title, series: series || null, episode: script.episode ?? null, submissionId })
    pend.push({ id, submissionId, title, seconds: render.seconds, outfits: render.outfits ?? {}, reason, at: new Date().toISOString(), dir, snapshot: reviewDir(id),
      originality: { passed: true, notes: report.errors, scriptSha: report.scriptSha, references: report.references, flags: (report.flags ?? []).map(describeHit) }, hashes,
      ...(publicCheck ? { publicCheck } : {}) })
    savePendingVideos(pend)
    return { used }
  }) } catch (e) { stop(String(e?.message ?? e)) }
  stage.cleanup()
  if (result.error) fail(result.error)
  writeMeta(id, { status: 'submitted', reason }, '交给主人审：' + reason)
  const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs')
  // 不给作品目录里的路径：那份她还能改。主人审片只看 videos play 打开的审片快照（就是会被上传的那一份）
  const text = `【她做好了一条视频，等你审】${title}（${render.seconds} 秒）\n为什么想发：${reason}\n看片：node host/cli.mjs videos play ${id}（只看这一份：审片快照，就是会上传的那一份）\n批准：node host/cli.mjs videos approve ${id}${publicCheck ? `\n⚠️ 出门检查：${publicCheck}` : ''}`
  execFile(NODE_EXE, [notifier, text, '--title', '待审视频'], { windowsHide: true, timeout: 60_000 }, (err) => {
    if (err) console.log('  ⚠️ 推送没发成：主人可能不知道有一条视频在等他审 —— 下次和主人说话时提一句')
    process.exit(0)
  })
  console.log(`✓ 已交给主人审（这 7 天第 ${result.used + 1}/${scfg.maxPerWeek} 条）。他批准了才会发出去。`)
} else if (cmd === 'list') {
  const ps = listProjects()
  if (!ps.length) console.log('（还没有作品 —— studio new --title "…"）')
  for (const p of ps) console.log(`  ${p.id}  ${String(p.status).padEnd(9)} ${p.title ?? ''}${p.bvid ? '  ' + p.bvid : ''}${p.rejectReason ? '  （主人：' + p.rejectReason + '）' : ''}`)
  console.log(`\n这 7 天已用 ${weeklyUsed()}/${scfg.maxPerWeek} 条名额 · 在审 ${pendingVideos().length} 条`)
} else if (cmd === 'show') {
  const id = pos[0] ?? fail('studio show <id>')
  const m = readMeta(id)
  console.log(JSON.stringify(m, null, 2))
  console.log(`目录：${projectDir(id)}`)
  // render 转到后台时，自查图在哪、没做成的原因、方框字都只在那次的输出里：这里照样打一遍（见 printSheetHint）。
  // render.json 在作品目录里、她能改：只在它的成片指纹就是回执里那一份时才用（= 这边核对过、算数的那一次渲染）
  if (m.status === 'rendered') {
    const rec = readRenderReceipt(id)
    const rj = readJson(path.join(projectDir(id), 'render.json'), null)
    if (rec?.hashes?.['final.mp4'] && rj && typeof rj === 'object' && rj.hashes?.['final.mp4'] === rec.hashes['final.mp4']) {
      printSheetHint(projectDir(id), rj, '文件不在了：要是之后又渲染过、没渲成，先再 studio render 一次')
    }
  }
} else if (cmd === 'stats') {
  const mid = Number(config().self?.mid)
  if (!mid) fail('还不知道她自己的 mid（主人填完 cookie 会自动写进 self.mid）')
  const py = venvPython()
  if (!fs.existsSync(py)) fail('工作室的 Python 依赖还没装：请主人跑 node host/cli.mjs studio-setup')
  const r = spawnSync(py, [STUDIO_PY, 'stats', '--cred', credentialsPath, '--mid', String(mid), '--n', String(opt.n ?? 20)],
    { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, env: { ...process.env, PYTHONUTF8: '1' } })
  let out = null
  try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
  if (!out?.ok) fail('拿数据失败：' + (out?.error ?? r.stderr?.slice(-300)))
  const day = new Date().toLocaleDateString('sv-SE')
  fs.mkdirSync(STATS_DIR, { recursive: true })
  fs.writeFileSync(path.join(STATS_DIR, `${day}.json`), JSON.stringify(out, null, 2))
  // 存档在主人那边（她读不到）：她想对比就把要记的数字抄进私密日记的运营复盘
  console.log(`粉丝 ${out.followers} · 关注 ${out.following} · 视频 ${out.videos.length} 条${isAgent() ? '（已存档到主人那边；想以后对比，就把关心的数字写进私密日记）' : `（存档：${path.join(STATS_DIR, `${day}.json`)}）`}`)
  for (const v of out.videos) {
    const d = new Date(Number(v.created) * 1000).toLocaleDateString('sv-SE')
    console.log(`  ${d}  ${v.bvid}  播放 ${v.play ?? '?'} · 赞 ${v.like ?? '?'} · 币 ${v.coin ?? '?'} · 藏 ${v.favorite ?? '?'} · 评 ${v.comment ?? '?'} · 弹 ${v.danmaku ?? '?'}  ${v.title}`)
  }
} else if (cmd === 'voices') {
  console.log(['zh-CN-XiaoxiaoNeural  女 · 温暖（默认）', 'zh-CN-XiaoyiNeural    女 · 活泼', 'zh-CN-YunxiNeural     男 · 阳光',
    'zh-CN-YunjianNeural   男 · 沉稳', 'zh-CN-YunxiaNeural    男 · 少年', 'zh-CN-liaoning-XiaobeiNeural  东北话',
    'zh-CN-shaanxi-XiaoniNeural    陕西话', 'zh-TW-HsiaoChenNeural 台湾腔', 'zh-HK-HiuGaaiNeural   粤语'].join('\n'))
  console.log('\n在 script.json 里写 "voice": "…"，或主人改 studio.voice 做默认。')
} else {
  console.log('用法：studio new --format diary|dialogue|explainer|story --title "…" | channel [submit] | cast | check <id> | render <id> | submit <id> --reason "…" | list | show <id> | stats | voices | rules')
  process.exit(cmd ? 2 : 0)
}
