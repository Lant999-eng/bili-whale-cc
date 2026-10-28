// 她的 Bash 白名单（主人这边的检查，在她改不到的设置里注册成 PreToolUse 钩子）：
//   每次她要跑 Bash 之前，Claude Code 先把命令交给这个脚本；只放行
//     node bili.mjs [<已知子命令> 参数…]
//   参数只能是普通的词、'单引号'、"双引号（里面不能有 $ ` \）"。命令拼接、管道、重定向、$( )、反引号、
//   变量 / 通配符展开、别的命令 —— 一律拒绝。不靠 Claude Code 自己的「只读命令自动放行」判断。
//   陌生人私信回合（BILI_WHALE_TURN = bili-whale-sdm-…）只放行 node bili.mjs sdm / memory；
//   读书回合（bili-whale-web-…）只放行 web / note write；别的回合不放行 web / note（见 tools/lib/turn-policy.mjs）。
//   video 带 --repo（拿 GitHub README）哪种回合都不放。
//   拒绝 = 退出码 2（Claude Code 据此拦下这次调用，把 stderr 的说明给她看）；脚本自己出错也按拒绝处理（不放行）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 她能用的子命令：直接从工具链入口 tools/bili.mjs 的命令表里读（和权限规则用的是同一份）。
 * 脚本文件不在的不算（2026-10-27：QQ、陌生人私信能整块拔掉，和 bili.mjs 入口同一条规矩）
 */
export function biliSubcommands() {
  try {
    const tools = path.join(HERE, '..', 'tools')
    const src = fs.readFileSync(path.join(tools, 'bili.mjs'), 'utf8')
    return [...src.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*\['([^']+)'/gm)].filter((m) => fs.existsSync(path.join(tools, m[2]))).map((m) => m[1])
  } catch { return [] }
}

// 不加引号时允许的字符：除了空白和 shell 会特殊处理的那些（; & | < > ( ) $ ` \ " ' * ? [ ] { } ~ # !）以外都行（含中文）
const BARE = /[^\s;&|<>()$`\\"'*?[\]{}~#!]/

/** 把命令切成词；遇到上面说的任何特殊写法返回 null（不认识 = 不放行） */
function words(cmd) {
  const out = []
  let i = 0
  while (i < cmd.length) {
    while (cmd[i] === ' ' || cmd[i] === '\t') i += 1
    if (i >= cmd.length) break
    let w = ''
    while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t') {
      const ch = cmd[i]
      if (ch === "'") {                                  // 单引号：里面原样，bash 不展开任何东西
        const j = cmd.indexOf("'", i + 1)
        if (j < 0) return null
        w += cmd.slice(i + 1, j)
        i = j + 1
      } else if (ch === '"') {                           // 双引号：里面不能有 $ ` \（它们在双引号里照样会被 bash 处理）
        let j = i + 1
        while (j < cmd.length && cmd[j] !== '"') {
          if ('$`\\'.includes(cmd[j])) return null
          j += 1
        }
        if (j >= cmd.length) return null
        w += cmd.slice(i + 1, j)
        i = j + 1
      } else if (BARE.test(ch)) {
        w += ch
        i += 1
      } else return null
    }
    out.push(w)
  }
  return out
}

// 哪种回合能用哪些子命令（宿主设的 BILI_WHALE_TURN，她改不了；和 tools/bili.mjs 入口、宿主的权限规则用同一份）
import { commandAllowed, isSdmTurn, SDM_ONLY } from '../tools/lib/turn-policy.mjs'

/**
 * 这条命令能不能放行：{ ok } 或 { ok:false, why }（why 会给她看）。
 * turn = 这一回合的编号：钩子跑在她的会话的环境里，宿主设的 BILI_WHALE_TURN 看得到
 */
export function checkBiliCommand(command, subs = biliSubcommands(), turn = process.env.BILI_WHALE_TURN) {
  const w = words(String(command ?? '').trim())
  if (!w) return { ok: false, why: '只能用简单的参数：不能拼接别的命令，不能用 $( )、反引号、管道、重定向、通配符。参数里有特殊字符就整个用单引号括起来' }
  if (w[0] !== 'node' || w[1] !== 'bili.mjs') return { ok: false, why: '这里只能运行 node bili.mjs <子命令> …' }
  if (w.length > 2 && w[2] !== 'help' && !subs.includes(w[2])) return { ok: false, why: `没有这个子命令：${w[2]}（node bili.mjs help 看全部）` }
  // 陌生人私信回合：只放行 sdm、memory（宿主的权限规则、bili.mjs 入口之外再挡一道）。
  //   光秃秃的 node bili.mjs、help 也不放：那一回合的权限规则本来就没放行它们
  if (isSdmTurn(turn) && !SDM_ONLY.includes(w[2])) {
    return { ok: false, why: `陌生人私信回合里只能用 sdm 和 memory（${w.length > 2 ? `${String(w[2]).slice(0, 30)} 不行` : '要带子命令'}）。要主人知道的事：sdm flag --kind … --note "…"` }
  }
  // video --repo 会把 GitHub 上陌生人写的 README 拿进这一轮：她的会话里一律不放（2026-10-28 主人定「甲」）；想了解一个项目写读书请求
  if (w[2] === 'video' && w.some((x) => /^--repo(?:=|$)/i.test(x))) {
    return { ok: false, why: 'video 不带 --repo：GitHub 的 README 是陌生人写的字，不进这一轮。想了解这个项目，醒来那一轮用 read-request --topic "…"' }
  }
  // 读书回合只放行 web（search / open / more / page）、note write（help 也不放）；别的回合不放行 web、note，read-request 只在醒来那一轮和主人跟她聊天的回合（小窗、当面聊）
  return commandAllowed(w[2], w[3], turn)
}

// 作为钩子运行：stdin 是 Claude Code 给的 JSON（tool_name / tool_input.command …）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const j = JSON.parse(fs.readFileSync(0, 'utf8'))
    if (j?.tool_name !== 'Bash') process.exit(0)       // 只管 Bash；别的工具由权限规则管
    const r = checkBiliCommand(j?.tool_input?.command)
    if (r.ok) process.exit(0)
    process.stderr.write(`[主人的白名单] 拒绝：${r.why}\n`)
    process.exit(2)
  } catch (e) {
    process.stderr.write(`[主人的白名单] 检查出错，按拒绝处理：${String(e?.message ?? e).slice(0, 120)}\n`)
    process.exit(2)
  }
}
