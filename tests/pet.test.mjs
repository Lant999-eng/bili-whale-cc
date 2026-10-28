// 桌宠 host/pet.ps1 的离线检查：只解析、只读源码，**绝不运行它**（一运行就会在主人屏幕上弹出一个置顶窗口）
//   ① 纯 ASCII、只用 LF、没有 BOM：PowerShell 5.1 读没有 BOM 的脚本按 ANSI 代码页，源码里一个汉字就变乱码 ——
//      中文只能走脚本里的 Unicode 转义（U '...'）或服务器给的 JSON
//   ② 令牌只从环境变量读：命令行参数别的进程看得见，「-」开头的令牌还会被 PowerShell 当成参数名；读完就从本进程环境里删掉，只放进请求头
//   ③ PowerShell 自己的解析器（ParseFile）零错误；再用语法树查「不运行就看不出来」的错：调了没定义的函数、顶层先调用后定义、
//      局部变量和脚本级变量同名（PowerShell 变量名不分大小写、作用域是动态的：一个局部 $img 就会盖住图片控件 $Img）、
//      类型名 / 静态成员 / 已知类型对象的成员拼错、P/Invoke 声明编不过
//   每一样都拿改坏的副本确认真的查得出来（副本放在 os.tmpdir() 的沙盒里）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PET = path.join(ROOT, 'host', 'pet.ps1')
const RAW = fs.readFileSync(PET)
const SRC = RAW.toString('latin1')
const BS = String.fromCharCode(92)   // 反斜杠：本文件里不直接写「反斜杠 + u」的序列，用它拼
const WIN = process.platform === 'win32'

// ---- 纯文本检查（哪个平台都跑）：返回问题列表，空 = 合格 ----
function formatProblems(buf) {
  const out = []
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) out.push('BOM')
  const bad = buf.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a))
  if (bad >= 0) out.push(`byte 0x${buf[bad].toString(16)} on line ${buf.subarray(0, bad).toString('latin1').split('\n').length}`)
  return out
}

const codeOf = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')   // 注释里提到 argv / 令牌不算
function tokenProblems(src) {
  const out = [], code = codeOf(src)
  if (!code.includes('$env:WHALE_PET_TOKEN')) out.push('token not read from env')
  if (!code.includes("[Environment]::SetEnvironmentVariable('WHALE_PET_TOKEN', $null, 'Process')")) out.push('token left in our environment')
  if (!code.includes("$psi.EnvironmentVariables.Remove('WHALE_PET_TOKEN')")) out.push('token handed to the node child')
  if (/\$args\b/i.test(code)) out.push('$args used')
  if (/GetCommandLineArgs|CommandLine/i.test(code)) out.push('reads the command line')
  // 脚本级 param()：第一条不是注释的语句（事件处理里的 param($src, $e) 不算）
  if (/^\s*param\s*\(/i.test(code.split('\n').find((l) => l.trim()) ?? '')) out.push('script-level param() block')
  // $Token 只许出现在四处：从环境读、校验格式、放进请求头、清掉
  const OK = [/^\$Token = \[string\]\$env:WHALE_PET_TOKEN$/, /^if \(\$Token -notmatch '/, /^\$Http\.DefaultRequestHeaders\.Add\('X-Whale-Pet', \$Token\)$/, /^\$Token = \$null$/]
  for (const l of code.split('\n').map((x) => x.trim()).filter((x) => /\$token\b/i.test(x))) {
    if (!OK.some((re) => re.test(l))) out.push('token used at: ' + l)
  }
  return out
}

// 状态全在 $S 这张表里：读到的每个键都得在 $S = @{ ... } 里先声明（拼错的键在 PowerShell 里只是悄悄的 $null）
function stateProblems(src) {
  const lit = src.match(/^\$S = @\{\n([\s\S]*?)\n\}/m)
  if (!lit) return ['no $S = @{ ... } literal']
  const declared = new Set([...lit[1].matchAll(/(\w+) =/g)].map((m) => m[1].toLowerCase()))
  return [...new Set([...src.matchAll(/\$S\.(\w+)/g)].map((m) => m[1]))].filter((k) => !declared.has(k.toLowerCase())).map((k) => 'undeclared $S.' + k)
}

// 从脚本里抠出地址 / 令牌的校验正则，按 .NET 的意思在这里跑：-match 不分大小写；结尾 \z（JS 里不带 m 的 $ 是同一个意思）
function guard(src, name) {
  const m = src.match(new RegExp(BS + '$' + name + " -notmatch '([^']+)'"))
  assert.ok(m, `pet.ps1 validates $${name}`)
  assert.ok(m[1].endsWith(BS + 'z'), `$${name} regex ends with \\z (in .NET, $ also matches before a trailing newline)`)
  return new RegExp(m[1].slice(0, -2) + '$', 'i')
}

const decode = (s) => s.replace(new RegExp(BS + BS + 'u([0-9a-fA-F]{4})', 'g'), (_, h) => String.fromCharCode(parseInt(h, 16)))

test('pet.ps1 is pure ASCII with LF line endings and no BOM (PowerShell 5.1 reads BOM-less scripts in the ANSI code page)', () => {
  assert.deepEqual(formatProblems(RAW), [])
  // 查得出来：中文注释、CRLF、BOM、制表符
  assert.notDeepEqual(formatProblems(Buffer.concat([RAW, Buffer.from('# 测试角色\n', 'utf8')])), [])
  assert.notDeepEqual(formatProblems(Buffer.from(SRC.replace(/\n/g, '\r\n'), 'latin1')), [])
  assert.notDeepEqual(formatProblems(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), RAW])), [])
  assert.notDeepEqual(formatProblems(Buffer.from(SRC + '\tx\n', 'latin1')), [])
})

test('pet.ps1 reads its token from the environment only, drops it from its own environment, and sends it only as the X-Whale-Pet header', () => {
  assert.deepEqual(tokenProblems(SRC), [])
  const mutants = {
    argv: 'param([string]$Token)\n' + SRC,
    args: SRC.replace('$Token = [string]$env:WHALE_PET_TOKEN', '$Token = [string]$args[0]'),
    'left in env': SRC.replace("[Environment]::SetEnvironmentVariable('WHALE_PET_TOKEN', $null, 'Process')\n", ''),
    'child inherits': SRC.replace("$psi.EnvironmentVariables.Remove('WHALE_PET_TOKEN')\n", ''),
    'logged': SRC.replace("$Token = $null\n", "Say ('token ' + $Token)\n$Token = $null\n"),
    'command line': SRC.replace("$Base = [string]$env:WHALE_PET_URL", '$Base = [Environment]::CommandLine'),
  }
  for (const [name, m] of Object.entries(mutants)) {
    assert.notEqual(m, SRC, `mutant ${name} applied`)
    assert.notDeepEqual(tokenProblems(m), [], `mutant ${name} caught`)
  }
})

test('pet.ps1 only accepts a loopback http viewer URL and a header-safe token (the token must never leave 127.0.0.1)', () => {
  const url = guard(SRC, 'Base'), tok = guard(SRC, 'Token')
  for (const u of ['http://127.0.0.1:8766', 'http://localhost:8766', 'HTTP://LOCALHOST:1']) assert.ok(url.test(u), u)
  for (const u of ['', 'https://127.0.0.1:8766', 'http://127.0.0.1:8766/', 'http://127.0.0.1:8766/api/live', 'http://127.0.0.1:8766@evil.example',
    'http://evil.example:8766', 'http://127.0.0.1.evil.example:8766', 'http://127.0.0.2:8766', 'http://[::1]:8766', 'http://127.0.0.1', 'http://127.0.0.1:8766\n',
    'http://127.0.0.1:123456']) assert.ok(!url.test(u), JSON.stringify(u))
  assert.match(SRC, /-gt 65535\) \{ Say 'WHALE_PET_URL/, 'ports above 65535 refused too')
  for (const t of [crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(16).toString('hex'), '-starts-with-a-dash-ok']) assert.ok(tok.test(t), t)
  for (const t of ['', 'short', 'a'.repeat(15), 'a'.repeat(257), 'abcdefghijklmnop\n', 'abcdefghijklmnop\r\nX-Evil: 1', 'has spaces in the token', 'abc/def+ghi=jklmnop']) assert.ok(!tok.test(t), JSON.stringify(t))
  // 查得出来：去掉 \z
  assert.throws(() => guard(SRC.replace("[0-9]{1,5}" + BS + "z'", "[0-9]{1,5}$'"), 'Base'))
})

test('pet.ps1 writes nothing, starts nothing but `node cli.mjs window [--pet off]`, and talks to nobody but the viewer', () => {
  const code = codeOf(SRC)
  const FORBIDDEN = /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Start-Process|Invoke-Expression|iex|Invoke-WebRequest|Invoke-RestMethod|Start-Job|WriteAll(Text|Bytes|Lines)|AppendAll\w*|DownloadFile|DownloadString|WebClient|Export-\w+|Tee-Object|Register-\w+)\b/i
  assert.equal(code.match(FORBIDDEN)?.[0], undefined)
  assert.equal(code.match(/\[Diagnostics\.Process\]::Start\(/g)?.length, 1, 'exactly one process launch site (Start-Cli)')
  assert.match(code, /\$psi\.FileName = \$Node\n/)
  assert.match(code, /\$psi\.UseShellExecute = \$false; \$psi\.CreateNoWindow = \$true/)
  assert.deepEqual([...code.matchAll(/Start-Cli (@\([^)]*\))/g)].map((m) => m[1]).sort(), ["@('window', '--pet', 'off')", "@('window')"].sort())
  const gets = [...code.matchAll(/GetAsync\(([^)]*)\)/g)].map((m) => m[1])
  assert.deepEqual(gets, ['$Base + $path'], 'every request goes to the validated viewer URL')
  assert.match(code, /\$Handler\.UseProxy = \$false; \$Handler\.UseCookies = \$false; \$Handler\.AllowAutoRedirect = \$false/)
})

test('pet.ps1 follows the contract: transparent topmost no-activate tool window, 260 px sprite, 1 s /api/live poll, flap, 30 s exit', () => {
  const code = codeOf(SRC)
  for (const s of ["$Win.WindowStyle = 'None'", '$Win.AllowsTransparency = $true', '$Win.Background = [Windows.Media.Brushes]::Transparent',
    '$Win.Topmost = $true', '$Win.ShowInTaskbar = $false', '$Win.ShowActivated = $false', '($ex -bor 0x80 -bor 0x08000000)',
    '$SpriteH = 260', '$b.DecodePixelHeight =', "Start-Fetch '/api/list'".replace('list', 'live'), '(Now) - $S.LastPoll -ge 1',
    "$Http.DefaultRequestHeaders.Add('X-Whale-Pet', $Token)", '-gt 30) { Quit 3', '$Win.DragMove()', '$FlapTimer.Interval = [TimeSpan]::FromMilliseconds(140)',
    "Get-Field $snap 'talking'", "Get-Field $snap 'host', 'state'", "Get-Field $snap 'caption'", "Get-Names $snap 'talkingExprs'",
    '[Windows.SystemParameters]::WorkArea']) assert.ok(code.includes(s), s)
  // 窗口标题不能以角色名开头：cli window --top 按这个找 Edge 小窗
  assert.match(code, /^\$Win\.Title = 'bili-whale pet'/m)
})

// 她站在哪：工作区右下角、小窗那一栏的左边。小窗贴右上角（440 宽、离右边 12），1080p 屏上一直伸到 ~772 像素 ——
// 站在最右下角的话，整个回合都亮着的气泡正好盖住小窗底下的「今天」。这里按 window.mjs 的真实数字算一遍不重叠
test('pet.ps1 stands at the bottom of the work area, left of the window column, so her bubble never covers the window', () => {
  const code = codeOf(SRC)
  const col = code.match(/^\$WinColumn = 12 \+ (\d+) \+ (\d+)$/m)
  assert.ok(col, '$WinColumn = 12 + <window width> + <gap>')
  const [winW, gap] = [Number(col[1]), Number(col[2])]
  assert.equal(gap, 16)
  const home = code.match(/function Place-Home \{\n([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(home, /\$Win\.Left = \[Math\]::Max\(\$wa\.Left, \$wa\.Right - \$WinColumn - \$Win\.Width\); \$Win\.Top = \$wa\.Bottom - \$Win\.Height/)
  // 和小窗服务放 Edge 的位置 / 大小是同一组数（谁改了一边，这里就红）
  const win = fs.readFileSync(path.join(ROOT, 'host', 'window.mjs'), 'utf8')
  assert.match(win, new RegExp(`x: Math\\.max\\(l, r - ${winW} - 12\\)`), 'workAreaPos docks the window 12 px from the right')
  assert.match(win, new RegExp(`--window-size=${winW},760`))
  // 主人那块屏：工作区 0,0–1707,1019；她 230 宽 → 小窗 1255–1695，她 1009–1239，中间空 16
  const petW = Number(code.match(/^\$Win\.Width = (\d+);/m)?.[1])
  assert.equal(petW, 230)
  const right = 1707, winLeft = right - 12 - winW, petLeft = Math.max(0, right - (12 + winW + gap) - petW)
  assert.equal(petLeft + petW + gap, winLeft, 'she ends 16 px left of the window')
  // 窄屏（工作区比两样加起来还窄）：贴着左边，不跑到屏幕外
  assert.equal(Math.max(0, 600 - (12 + winW + gap) - petW), 0)
})

// 呼吸只跟「在睡觉、还要醒」（state asleep）：白天（day）是平常的样子，今晚做完了（night_done）困的脸不动；别按「脸是困的」判断
test('pet.ps1 breathes only in the asleep state, not on every sleepy face', () => {
  const code = codeOf(SRC)
  assert.match(code, /^\$Asleep = 'asleep'$/m)
  assert.ok(code.includes("$S.State = [string](Get-Field $snap 'state')"))
  assert.ok(code.includes('Set-Breathing ($S.State -eq $Asleep -and -not $flap -and -not $S.Offline -and -not $S.Unreachable)'))
  assert.equal((code.match(/Set-Breathing \(/g) ?? []).length, 1, 'one place decides breathing')
  assert.ok(!/\$w\.Expr -eq/.test(code), 'not keyed on the face')
})

test('pet.ps1 Chinese labels come from Unicode escapes and decode to the menu / talk-folder names; the talk folder matches studio TALK_DIR', () => {
  const labels = [...SRC.matchAll(/\bU '([^']*)'/g)].map((m) => decode(m[1]))
  assert.deepEqual(labels.sort(), ['连不上了…', '说话', '打开小窗', '隐藏 10 分钟', '关闭桌宠'].sort())
  assert.ok(labels.every((l) => !l.includes(BS)), 'every escape is well-formed')
  const studio = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'studio.mjs'), 'utf8').match(/export const TALK_DIR = '([^']+)'/)
  assert.ok(labels.includes(studio[1]))
})

test('pet.ps1 declares every $S state key it reads (a typo would silently be $null)', () => {
  assert.deepEqual(stateProblems(SRC), [])
  assert.deepEqual(stateProblems(SRC.replace('$S.Unreachable = $true; $S.Talking = $false', '$S.Unreachble = $true; $S.Talking = $false')), ['undeclared $S.Unreachble'])
})

// ---- 语法树检查（只在 Windows 上：要 Windows PowerShell 5.1 和 WPF 的程序集）。只解析、加载程序集、编译那三行 P/Invoke 声明 ——
//      不执行脚本里的任何一句，不建窗口 ----
const ANALYZE = `using namespace System.Management.Automation.Language
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http, System.Web.Extensions
function Inner($n) { for ($p = $n.Parent; $p; $p = $p.Parent) { if ($p -is [FunctionDefinitionAst] -or $p -is [ScriptBlockExpressionAst]) { return $true } }; return $false }
function Bound($n) {
  if ($n -is [AssignmentStatementAst] -and $n.Left -is [VariableExpressionAst]) { return $n.Left.VariablePath }
  if ($n -is [ForEachStatementAst]) { return $n.Variable.VariablePath }
  if ($n -is [ParameterAst]) { return $n.Name.VariablePath }
  return $null
}
function NewType($n) {
  if ($n -isnot [AssignmentStatementAst]) { return '?' }
  $r = $n.Right
  if ($r -is [PipelineAst] -and $r.PipelineElements.Count -eq 1 -and $r.PipelineElements[0] -is [CommandAst] -and $r.PipelineElements[0].GetCommandName() -eq 'New-Object') { return $r.PipelineElements[0].CommandElements[1].Extent.Text }
  return '?'
}
$flags = [Reflection.BindingFlags]'Public,Instance,Static,IgnoreCase,FlattenHierarchy'
$compiled = @{}
$results = foreach ($file in ($env:PET_PS1S -split ';')) {
  $tk = $null; $pe = $null
  $ast = [Parser]::ParseFile($file, [ref]$tk, [ref]$pe)
  $all = @($ast.FindAll({ $true }, $true))
  $funcs = @($all | Where-Object { $_ -is [FunctionDefinitionAst] })
  $cmds = @($all | Where-Object { $_ -is [CommandAst] })
  $early = @(foreach ($c in $cmds) { if (Inner $c) { continue }; $nm = $c.GetCommandName(); $d = @($funcs | Where-Object { $_.Name -eq $nm }); if ($d.Count -and $d[0].Extent.StartOffset -gt $c.Extent.StartOffset) { $nm } })
  $top = @{}; $inner = @(); $types = @{}
  foreach ($n in $all) {
    $vp = Bound $n
    if (-not $vp -or -not $vp.IsUnqualified -or $vp.UserPath -eq 'null') { continue }
    $k = $vp.UserPath.ToLower()
    if (Inner $n) { $inner += $k } else { $top[$k] = 1 }
    if (-not $types.ContainsKey($k)) { $types[$k] = @() }
    $types[$k] += NewType $n
  }
  $shadow = @($inner | Where-Object { $top.ContainsKey($_) } | Sort-Object -Unique)
  $cs = @($all | Where-Object { $_ -is [StringConstantExpressionAst] -and $_.Value -match 'DllImport' })
  $csOk = $false
  if ($cs.Count -eq 1) {
    $src = $cs[0].Value
    if (-not $compiled.ContainsKey($src)) {
      try { Add-Type -Namespace ('PetCheck' + [guid]::NewGuid().ToString('N')) -Name Native -MemberDefinition $src; $compiled[$src] = $true } catch { $compiled[$src] = $false }
      if ($compiled[$src] -and -not ('WhalePet.Native' -as [type])) { Add-Type -Namespace WhalePet -Name Native -MemberDefinition $src }
    }
    $csOk = $compiled[$src]
  }
  $tn = @($all | Where-Object { $_ -is [TypeExpressionAst] -or $_ -is [TypeConstraintAst] } | ForEach-Object { $_.TypeName.FullName })
  $tn += @($cmds | Where-Object { $_.GetCommandName() -eq 'New-Object' } | ForEach-Object { $_.CommandElements[1].Extent.Text })
  $unresolved = @($tn | Sort-Object -Unique | Where-Object { -not ($_ -as [type]) })
  $typed = @{}
  foreach ($k in @($types.Keys)) { $ts = @($types[$k] | Sort-Object -Unique); if ($ts.Count -eq 1 -and $ts[0] -ne '?') { $ty = $ts[0] -as [type]; if ($ty) { $typed[$k] = $ty } } }
  $badStatic = @(foreach ($m in $all) { if ($m -is [MemberExpressionAst] -and $m.Static -and $m.Expression -is [TypeExpressionAst] -and $m.Member -is [StringConstantExpressionAst] -and $m.Member.Value -ne 'new') { $ty = $m.Expression.TypeName.FullName -as [type]; if ($ty -and -not $ty.GetMember($m.Member.Value, $flags)) { $m.Expression.TypeName.FullName + '::' + $m.Member.Value } } })
  $badInstance = @(foreach ($m in $all) { if ($m -is [MemberExpressionAst] -and -not $m.Static -and $m.Expression -is [VariableExpressionAst] -and $m.Member -is [StringConstantExpressionAst]) { $k = $m.Expression.VariablePath.UserPath.ToLower(); if ($typed.ContainsKey($k) -and -not $typed[$k].GetMember($m.Member.Value, $flags)) { $k + '.' + $m.Member.Value } } })
  [pscustomobject]@{
    errors = @($pe | ForEach-Object { [string]$_.Extent.StartLineNumber + ': ' + $_.Message })
    hasParam = $null -ne $ast.ParamBlock
    vars = @($all | Where-Object { $_ -is [VariableExpressionAst] } | ForEach-Object { $_.VariablePath.UserPath } | Sort-Object -Unique)
    calls = @($cmds | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique)
    funcs = @($funcs | ForEach-Object { $_.Name })
    early = $early; shadow = $shadow; csOk = $csOk; unresolved = $unresolved
    badStatic = $badStatic; badInstance = $badInstance; typed = @($typed.Keys | Sort-Object)
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4`

// 脚本里用到的 cmdlet 只许这几个（其余调用都得是脚本自己定义的函数）
const CMDLETS = ['Add-Type', 'New-Object', 'Get-Command', 'Select-Object', 'Test-Path', 'Resolve-Path', 'Split-Path', 'Join-Path']

function analyze(files) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ANALYZE], {
    env: { ...process.env, PET_PS1S: files.join(';') }, encoding: 'utf8', windowsHide: true, timeout: 180_000,
  })
  assert.equal(r.status, 0, `analyzer failed: ${r.error?.message ?? ''} ${r.stderr}`)
  return JSON.parse(r.stdout)
}

const clean = (a) => ({
  errors: a.errors, hasParam: a.hasParam, early: a.early, shadow: a.shadow, csOk: a.csOk, unresolved: a.unresolved,
  badStatic: a.badStatic, badInstance: a.badInstance, unknownCalls: a.calls.filter((c) => !a.funcs.includes(c) && !CMDLETS.includes(c)),
})
const PASS = { errors: [], hasParam: false, early: [], shadow: [], csOk: true, unresolved: [], badStatic: [], badInstance: [], unknownCalls: [] }

test('pet.ps1 parses cleanly in Windows PowerShell 5.1 and its syntax tree has no latent runtime mistakes (mutants prove each check bites)', { skip: !WIN && '只有 Windows 有 PowerShell 5.1 / WPF' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ps1-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // 每个改坏的副本只动一处，期望它在哪一项上被抓到
  const MUTANTS = [
    ['parse error', ['function Now { $Clock.Elapsed.TotalSeconds }', 'function Now { $Clock.Elapsed.TotalSeconds'], (a) => a.errors.length > 0],
    ['argv param block', ['$ErrorActionPreference = ', 'param([string]$Token)\n$ErrorActionPreference = '], (a) => a.hasParam],
    ['local shadows $Img', ['$frame = $rec.Bmp; $mask = $null', '$img = $rec.Bmp; $mask = $null'], (a) => a.shadow.includes('img')],
    ['undefined function', ['Check-Closing; Update-Bubble }', 'Check-Closin; Update-Bubble }'], (a) => clean(a).unknownCalls.includes('Check-Closin')],
    ['called before defined', ["$ErrorActionPreference = 'Stop'\n", "$ErrorActionPreference = 'Stop'\nPlace-Home\n"], (a) => a.early.includes('Place-Home')],
    ['static member typo', ['ScaleTransform]::ScaleYProperty, $a)', 'ScaleTransform]::ScaleYPropertie, $a)'], (a) => a.badStatic.some((x) => /ScaleYPropertie$/.test(x))],
    ['instance member typo', ['$Win.ShowActivated = $false', '$Win.ShowActivatd = $false'], (a) => a.badInstance.includes('win.ShowActivatd')],
    ['type typo', ['Windows.Media.Imaging.FormatConvertedBitmap', 'Windows.Media.Imaging.FormatConvertBitmap'], (a) => a.unresolved.includes('Windows.Media.Imaging.FormatConvertBitmap')],
    ['P/Invoke does not compile', ['SHQueryUserNotificationState(out int state);', 'SHQueryUserNotificationState(out int state)'], (a) => a.csOk === false],
  ]
  const files = [PET]
  for (const [name, [from, to]] of MUTANTS) {
    assert.ok(SRC.includes(from), `mutant ${name}: anchor still in pet.ps1`)
    const f = path.join(dir, name.replace(/\W+/g, '-') + '.ps1')
    fs.writeFileSync(f, SRC.replace(from, to), 'latin1')
    files.push(f)
  }
  const [real, ...muts] = analyze(files)
  assert.deepEqual(clean(real), PASS)
  // 令牌从环境变量读（语法树里的变量就是 $env:WHALE_PET_TOKEN），整份脚本不碰 $args
  assert.ok(real.vars.includes('env:WHALE_PET_TOKEN') && real.vars.includes('env:WHALE_PET_URL'))
  assert.ok(!real.vars.some((v) => /^args$/i.test(v)))
  // 成员检查不是空跑：主要的控件 / 客户端都认出了类型
  for (const v of ['win', 'img', 'http', 'json', 'menu', 'flaptimer', 'tick', 'bubble', 'text', 'psi']) assert.ok(real.typed.includes(v), `typed ${v}`)
  MUTANTS.forEach(([name, , caught], i) => assert.ok(caught(muts[i]), `mutant ${name} caught: ${JSON.stringify(clean(muts[i]))}`))
})
