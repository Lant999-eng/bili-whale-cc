# bili-whale desktop pet: a transparent, topmost, never-focused WPF sprite of her that mirrors the viewer's
# /api/live snapshot (expression, mouth flap, a one-line caption bubble). Started ONLY by host/window.mjs, as its
# child (not detached: a detached PowerShell exits before it can render, and the viewer's job object takes the pet
# down with it, so a dead viewer never leaves an orphan on the desktop):
#   powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File host\pet.ps1
#   env WHALE_PET_URL=http://127.0.0.1:<port>  WHALE_PET_TOKEN=<petToken>  WHALE_PET_NODE=<node.exe>  WHALE_PET_CLI=<host\cli.mjs>
# The token comes from the environment, never argv: other local processes can read command lines, and PowerShell
# would parse a token that starts with '-' as a parameter name.
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page, so a Chinese literal
# here would turn into mojibake. Chinese text comes from the snapshot JSON, or from \u escapes through U below.
# Writes nothing to disk. stderr gets short ASCII notes (never the token). Exit codes, for the viewer's respawn policy:
#   0 owner chose "close pet" (the cli already set pet:false)   2 cannot run here (bad env, not STA, WPF blocked)
#   3 viewer unreachable or refusing for 30 s                   4 another pet is already running   1 anything else

$ErrorActionPreference = 'Stop'
$Clock = [Diagnostics.Stopwatch]::StartNew()   # monotonic: a DST or NTP jump must not trip the 30 s exit
function Now { $Clock.Elapsed.TotalSeconds }
$Said = @{}
function Say([string]$m) {
  # the same note at most once a minute: a failing poll must not flood the viewer's stderr pipe 5 times a second
  $t = Now
  if ($Said.ContainsKey($m) -and $t - $Said[$m] -lt 60) { return }
  if ($Said.Count -gt 200) { $Said.Clear() }
  $Said[$m] = $t
  try { [Console]::Error.WriteLine('pet: ' + $m) } catch {}
}
function U([string]$escaped) { [regex]::Unescape($escaped) }

# ---- env, never argv ----
$Base = [string]$env:WHALE_PET_URL
$Token = [string]$env:WHALE_PET_TOKEN
# take it out of our own environment block at once: nothing we start (node cli -> Edge) should inherit it
[Environment]::SetEnvironmentVariable('WHALE_PET_TOKEN', $null, 'Process')
# loopback http only, no path: the token header must never be sent anywhere else. \z, not $: in .NET $ also
# matches before a trailing newline
if ($Base -notmatch '^http://(127\.0\.0\.1|localhost):[0-9]{1,5}\z' -or [int]($Base -replace '^.*:', '') -gt 65535) { Say 'WHALE_PET_URL must be http://127.0.0.1:<port>'; exit 2 }
if ($Token -notmatch '^[A-Za-z0-9_-]{16,256}\z') { Say 'WHALE_PET_TOKEN missing or malformed'; exit 2 }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { Say 'WPF needs -STA'; exit 2 }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Say 'constrained language mode: no WPF here'; exit 2 }

# one pet per desktop session: a second viewer (other port) must not stack a twin on top of her
$Mutex = New-Object Threading.Mutex($false, 'Local\bili-whale-pet')
$own = $false
try { $own = $Mutex.WaitOne(0) } catch { $own = ($_.Exception -is [Threading.AbandonedMutexException]) -or ($_.Exception.InnerException -is [Threading.AbandonedMutexException]) }
if (-not $own) { Say 'another pet is already running'; exit 4 }

try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http, System.Web.Extensions
  Add-Type -Namespace WhalePet -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
'@
} catch { Say ('cannot load WPF here: ' + $_.Exception.Message); exit 2 }

function Find-Node {
  $p = [string]$env:WHALE_PET_NODE
  if ($p -and $p -notmatch '"' -and $p -match '\.exe$' -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
  $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $null
}
function Find-Cli {
  foreach ($p in @([string]$env:WHALE_PET_CLI, (Join-Path $PSScriptRoot 'cli.mjs'))) {
    if ($p -and $p -notmatch '"' -and (Split-Path -Leaf $p) -eq 'cli.mjs' -and (Test-Path -LiteralPath $p -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $p).ProviderPath
    }
  }
  $null
}
$Node = Find-Node
$Cli = Find-Cli

# ---- HTTP: async so a hung viewer never freezes her; results are picked up by the 200 ms tick ----
$Handler = New-Object Net.Http.HttpClientHandler
# no proxy (a system proxy would see the token), no cookies, no redirects (a 302 must not carry the header elsewhere)
$Handler.UseProxy = $false; $Handler.UseCookies = $false; $Handler.AllowAutoRedirect = $false
$Http = New-Object Net.Http.HttpClient($Handler)
$Http.Timeout = [TimeSpan]::FromSeconds(5)
$Http.MaxResponseContentBufferSize = 16MB
$Http.DefaultRequestHeaders.Add('X-Whale-Pet', $Token)
$Token = $null
$Json = New-Object Web.Script.Serialization.JavaScriptSerializer
$Json.MaxJsonLength = 16MB

function Start-Fetch([string]$path) {
  @{ Get = $Http.GetAsync($Base + $path); Read = $null; Resp = $null }
}
# $null while still pending, else @{ Ok; Status; Bytes }
function Step-Fetch($f) {
  if ($null -eq $f.Read) {
    if (-not $f.Get.IsCompleted) { return $null }
    if ($f.Get.Status -ne [Threading.Tasks.TaskStatus]::RanToCompletion) { $null = $f.Get.Exception; return @{ Ok = $false; Status = 0; Bytes = $null } }
    $f.Resp = $f.Get.Result
    $code = [int]$f.Resp.StatusCode
    if ($code -ne 200) { $f.Resp.Dispose(); return @{ Ok = $false; Status = $code; Bytes = $null } }
    $f.Read = $f.Resp.Content.ReadAsByteArrayAsync()
  }
  if (-not $f.Read.IsCompleted) { return $null }
  $ok = $f.Read.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion
  $bytes = $null
  if ($ok) { $bytes = $f.Read.Result } else { $null = $f.Read.Exception }
  $f.Resp.Dispose()
  @{ Ok = $ok; Status = 200; Bytes = $bytes }
}

# snapshot fields can be missing or null (older or newer viewer): walk keys without throwing
function Get-Field($obj, [string[]]$path) {
  foreach ($k in $path) {
    if ($obj -isnot [Collections.Generic.Dictionary[string,object]] -or -not $obj.ContainsKey($k)) { return $null }
    $obj = $obj[$k]
  }
  , $obj
}
function Get-Names($obj, [string]$key) {
  $out = New-Object Collections.Generic.List[string]
  $v = Get-Field $obj @($key)
  if ($v -is [Array]) { foreach ($x in $v) { if ($x -is [string]) { $out.Add($x) } } }
  , $out
}

# ---- state: every key lives here (tests check that nothing reads an undeclared one) ----
$SpriteH = 260
# the Edge window's column at the right of the work area: 12 px margin + 440 px window (workAreaPos and
# --window-size in host/window.mjs) + a 16 px gap before her. Place-Home keeps her left of it.
$WinColumn = 12 + 440 + 16
$TalkDir = U '\u8bf4\u8bdd'            # sprites/<outfit>/<this>/<expr>.png is the mouth-open twin
$NoLink = U '\u8fde\u4e0d\u4e0a\u4e86\u2026'
# snapshot.state values (ASCII, from liveview.stateOf). She breathes slowly only while 'asleep' = inside a wake window
# with a wake still to come. Not on any sleepy face: 'night_done' (tonight's work is done) shows the sleepy face
# standing still, and 'day' (outside every window) is her plain neutral self.
$Asleep = 'asleep'
$S = @{
  Live = $null; LastPoll = -10.0; LastOk = 0.0; Unreachable = $false
  Sprites = @{}; Pending = @{}; Failed = @{}
  Want = $null; Closed = $null; Open = $null; Mouth = $false
  Talking = $false; Offline = $false; Active = $false; Breathing = $false; State = ''
  Caption = ''; CaptionAt = 0.0; Hover = $false
  HideUntil = $null; Busy = $false; LastBusyCheck = -10.0; LastOpen = -10.0
  Closing = $null; ClosingAt = 0.0; ClosingStarted = $false
  Scale = 1.0; Exit = 1; Quitting = $false
}

function Sprite-Url([string]$outfit, [string]$expr, [bool]$open) {
  $path = '/sprite/' + [Uri]::EscapeDataString($outfit) + '/'
  if ($open) { $path += [Uri]::EscapeDataString($TalkDir) + '/' }
  $path + [Uri]::EscapeDataString($expr) + '.png'
}
function Is-Name([string]$n) { $n -match '^[^\x00-\x1f\\/%?#.]{1,32}\z' }

function New-Frame([byte[]]$bytes) {
  $ms = New-Object IO.MemoryStream(, $bytes)
  try {
    $b = New-Object Windows.Media.Imaging.BitmapImage
    $b.BeginInit(); $b.CacheOption = 'OnLoad'; $b.CreateOptions = 'IgnoreColorProfile'
    # decode straight to her on-screen height in device pixels: the PNGs are 1024x1536 (~1.7 MB), a full decode is ~6 MB each
    $b.DecodePixelHeight = [int][Math]::Ceiling($SpriteH * $S.Scale)
    $b.StreamSource = $ms; $b.EndInit(); $b.Freeze()
    @{ Bmp = $b; Grey = $null; Mask = $null }
  } finally { $ms.Dispose() }
}

function Get-Sprite([string]$path) {
  if ($S.Sprites.ContainsKey($path)) { return $S.Sprites[$path] }
  if ($S.Pending.ContainsKey($path)) { return $null }
  if ($S.Failed.ContainsKey($path) -and (Now) - $S.Failed[$path] -lt 30) { return $null }
  $S.Pending[$path] = Start-Fetch $path
  $null
}

function Pump-Sprites {
  $changed = $false
  foreach ($path in @($S.Pending.Keys)) {
    $r = Step-Fetch $S.Pending[$path]
    if (-not $r) { continue }
    $S.Pending.Remove($path)
    $rec = $null
    if ($r.Ok) { try { $rec = New-Frame $r.Bytes } catch { Say ('sprite decode failed: ' + $_.Exception.Message) } }
    if ($rec) {
      if ($S.Sprites.Count -ge 48) { $S.Sprites.Clear() }
      $S.Sprites[$path] = $rec; $S.Failed.Remove($path)
    } else { $S.Failed[$path] = Now }
    $changed = $true
  }
  if ($changed) { Show-Frame }
}

function Paint($rec) {
  # never name a local like a script-level control: PowerShell names ignore case and scopes are dynamic, so a local
  # $img here (or in any caller) would shadow $Img, the Image element
  $frame = $rec.Bmp; $mask = $null
  if ($S.Offline -or $S.Unreachable) {
    if (-not $rec.Grey) {
      # Gray8 drops alpha, so the colour frame rides along as an opacity mask: her outline and soft hair edge stay intact
      $g = New-Object Windows.Media.Imaging.FormatConvertedBitmap
      $g.BeginInit(); $g.Source = $rec.Bmp; $g.DestinationFormat = [Windows.Media.PixelFormats]::Gray8; $g.EndInit(); $g.Freeze()
      $m = New-Object Windows.Media.ImageBrush($rec.Bmp); $m.Freeze()
      $rec.Grey = $g; $rec.Mask = $m
    }
    $frame = $rec.Grey; $mask = $rec.Mask
  }
  if (-not [object]::ReferenceEquals($Img.Source, $frame)) { $Img.Source = $frame; $Img.OpacityMask = $mask }
  $Img.Opacity = $(if ($mask) { 0.8 } else { 1.0 })
}

function Set-Breathing([bool]$on) {
  if ($on -eq $S.Breathing) { return }
  $S.Breathing = $on
  if (-not $on) { $Breath.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $null); return }
  $a = New-Object Windows.Media.Animation.DoubleAnimation(1.0, 1.012, [Windows.Duration]::new([TimeSpan]::FromSeconds(2.6)))
  $a.AutoReverse = $true; $a.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
  $ease = New-Object Windows.Media.Animation.SineEase; $ease.EasingMode = 'EaseInOut'; $a.EasingFunction = $ease
  # a layered window repaints whole on every frame: 10 fps is plenty for a slow breath and keeps her idle CPU near zero
  [Windows.Media.Animation.Timeline]::SetDesiredFrameRate($a, 10)
  $Breath.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $a)
}

function Show-Frame {
  $w = $S.Want
  if (-not $w) { return }
  $closed = Get-Sprite $w.Closed
  if (-not $closed) { return }   # keep the previous face until the new one has arrived: no blank flash
  $open = $null
  if ($w.Open) { $open = Get-Sprite $w.Open }
  $S.Closed = $closed; $S.Open = $open
  $flap = $S.Talking -and $open -and -not $S.Unreachable
  if ($flap -and -not $FlapTimer.IsEnabled) { $S.Mouth = $false; $FlapTimer.Start() }
  if (-not $flap) { if ($FlapTimer.IsEnabled) { $FlapTimer.Stop() }; Paint $closed }
  Set-Breathing ($S.State -eq $Asleep -and -not $flap -and -not $S.Offline -and -not $S.Unreachable)
}

function Set-Caption([string]$cap) {
  $cap = ($cap -replace '[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]', ' ').Trim()
  if ($cap.Length -gt 80) { $cap = $cap.Substring(0, 79) + [char]0x2026 }
  if ($cap -ne $S.Caption) { $S.Caption = $cap; $S.CaptionAt = Now; $Text.Text = $cap }
  Update-Bubble
}
function Update-Bubble {
  # during a turn, while she talks, or while something is wrong the bubble stays; between turns it goes away after
  # 8 s so a sleeping pet is just a sprite. Hovering her brings it back.
  $show = $S.Caption -and ($S.Active -or $S.Talking -or $S.Hover -or $S.Unreachable -or ((Now) - $S.CaptionAt) -lt 8)
  $Bubble.Visibility = $(if ($show) { 'Visible' } else { 'Collapsed' })
  $Text.Foreground = $(if ($S.Offline -or $S.Unreachable) { $Grey } else { $Ink })
}

function Apply-Snapshot($snap) {
  $S.Unreachable = $false
  $S.Offline = [string](Get-Field $snap 'host', 'state') -eq 'offline'
  $outfit = [string](Get-Field $snap 'outfit')
  $exprs = Get-Names $snap 'exprs'
  $talk = Get-Names $snap 'talkingExprs'
  $expr = [string](Get-Field $snap 'expr')
  # the viewer already picks a drawable face; re-check so a stale or newer viewer can never make us ask for a missing file
  if (-not $exprs.Contains($expr)) { $expr = $(if ($exprs.Contains('neutral')) { 'neutral' } elseif ($exprs.Count) { $exprs[0] } else { '' }) }
  if ((Is-Name $outfit) -and (Is-Name $expr)) {
    $open = $null
    if ($talk.Contains($expr)) { $open = Sprite-Url $outfit $expr $true }
    $S.Want = @{ Expr = $expr; Closed = (Sprite-Url $outfit $expr $false); Open = $open }
  }
  $S.Talking = ((Get-Field $snap 'talking') -eq $true) -and -not $S.Offline
  $S.Active = $null -ne (Get-Field $snap 'turn')
  $S.State = [string](Get-Field $snap 'state')
  # caption is the viewer's activity line (<= 80 chars); offline with no caption shows the host label instead
  $cap = [string](Get-Field $snap 'caption')
  if (-not $cap -and $S.Offline) { $cap = [string](Get-Field $snap 'host', 'label') }
  Set-Caption $cap
  Show-Frame
}

function Set-Unreachable {
  if ($S.Unreachable) { return }
  $S.Unreachable = $true; $S.Talking = $false
  Set-Caption $NoLink
  if ($S.Closed) { Show-Frame }
}

function Quit([int]$code, [string]$why) {
  if ($S.Quitting) { return }
  $S.Quitting = $true; $S.Exit = $code
  if ($why) { Say $why }
  $App.Shutdown($code)
}

function Pump-Live {
  if ($S.Live) {
    $r = Step-Fetch $S.Live
    if ($r) {
      $S.Live = $null
      $snap = $null
      if ($r.Ok) { try { $snap = $Json.DeserializeObject([Text.Encoding]::UTF8.GetString($r.Bytes)) } catch { $snap = $null } }
      if ($snap -is [Collections.Generic.Dictionary[string,object]]) { $S.LastOk = Now; Apply-Snapshot $snap }
      else {
        if ($r.Status) { Say ('viewer answered HTTP ' + $r.Status) } else { Say 'viewer not answering' }
        if ((Now) - $S.LastOk -gt 3) { Set-Unreachable }
      }
    }
  }
  if (-not $S.Live -and (Now) - $S.LastPoll -ge 1) { $S.LastPoll = Now; $S.Live = Start-Fetch '/api/live' }
  if ((Now) - $S.LastOk -gt 30) { Quit 3 'viewer unreachable for 30 s, exiting' }
}

# ---- opening the window / closing the pet goes through the cli, exactly like the owner typing it ----
function Start-Cli([string[]]$cliArgs) {
  if (-not $Node -or -not $Cli) { Say 'node.exe or host\cli.mjs not found (WHALE_PET_NODE / WHALE_PET_CLI)'; return $null }
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Node
    $psi.Arguments = '"' + $Cli + '" ' + ($cliArgs -join ' ')
    $psi.WorkingDirectory = Split-Path -Parent (Split-Path -Parent $Cli)
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables.Remove('WHALE_PET_TOKEN')
    [Diagnostics.Process]::Start($psi)
  } catch { Say ('could not start node: ' + $_.Exception.Message); $null }
}
function Open-Window {
  if ((Now) - $S.LastOpen -lt 3) { return }   # a double click must not open two Edge windows
  $S.LastOpen = Now
  $p = Start-Cli @('window')
  if ($p) { $p.Dispose() }
}
function Close-Pet {
  # exiting alone is not enough: the viewer respawns her while window-ctl.json says pet:true. Ask the cli to flip
  # it off, wait for that (at most 8 s), then go.
  if ($S.ClosingStarted) { return }
  $S.ClosingStarted = $true; $S.ClosingAt = Now
  $S.Closing = Start-Cli @('window', '--pet', 'off')
  Check-Visible
  if (-not $S.Closing) { Quit 0 '' }
}
function Check-Closing {
  if (-not $S.ClosingStarted) { return }
  if (-not $S.Closing -or $S.Closing.HasExited -or (Now) - $S.ClosingAt -gt 8) { Quit 0 '' }
}

function Place-Home {
  # The Edge window (cli window) is docked top-right: 440 px wide, 12 px from the work area's right edge, and on a
  # 1080p screen it reaches down to ~772 px, into the column she would stand in. So she stands at the bottom of the
  # work area just LEFT of that column (16 px gap): her caption bubble, which stays up for the whole turn, never
  # covers the window's footer. Both sizes are in DIPs (WPF WorkArea, Edge --window-size), so this holds at 125-150%.
  $wa = [Windows.SystemParameters]::WorkArea
  $Win.Left = [Math]::Max($wa.Left, $wa.Right - $WinColumn - $Win.Width); $Win.Top = $wa.Bottom - $Win.Height
}
function Keep-OnScreen {
  # a monitor unplugged while she was dragged onto it: bring her home instead of showing her nowhere
  $l = [Windows.SystemParameters]::VirtualScreenLeft; $t = [Windows.SystemParameters]::VirtualScreenTop
  $r = $l + [Windows.SystemParameters]::VirtualScreenWidth; $b = $t + [Windows.SystemParameters]::VirtualScreenHeight
  if ($Win.Left + $Win.Width -lt $l + 40 -or $Win.Left -gt $r - 40 -or $Win.Top + $Win.Height -lt $t + 40 -or $Win.Top -gt $b - 40) { Place-Home }
}
function Check-Visible {
  $t = Now
  if ($t - $S.LastBusyCheck -ge 3) {
    $S.LastBusyCheck = $t
    $st = 0
    try { [void][WhalePet.Native]::SHQueryUserNotificationState([ref]$st) } catch { $st = 0 }
    # 2 full-screen app or busy, 3 full-screen Direct3D game, 4 presentation mode: a topmost pet must not sit on those
    $S.Busy = $st -in 2, 3, 4
  }
  if ($null -ne $S.HideUntil -and $t -ge $S.HideUntil) { $S.HideUntil = $null }
  $visible = $null -eq $S.HideUntil -and -not $S.Busy -and -not $S.ClosingStarted
  if ($visible -and -not $Win.IsVisible) { Keep-OnScreen; $Win.Show() }
  elseif (-not $visible -and $Win.IsVisible) { $Win.Hide() }
}

function Brush([byte]$a, [byte]$r, [byte]$g, [byte]$b) {
  $x = New-Object Windows.Media.SolidColorBrush([Windows.Media.Color]::FromArgb($a, $r, $g, $b)); $x.Freeze(); $x
}

# ---- window ----
$App = New-Object Windows.Application
$App.ShutdownMode = 'OnExplicitShutdown'   # hiding her (busy screen, "hide 10 min") must not end the app
$App.Add_DispatcherUnhandledException({ param($src, $e) $e.Handled = $true; Say ('unhandled: ' + $e.Exception.Message) })

$Font = New-Object Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')
$Ink = Brush 255 43 43 51
$Grey = Brush 255 120 120 128
$Win = New-Object Windows.Window
$Win.Title = 'bili-whale pet'   # must not start like the Edge window's title: `cli window --top` matches on that
$Win.WindowStyle = 'None'; $Win.AllowsTransparency = $true; $Win.Background = [Windows.Media.Brushes]::Transparent
$Win.Topmost = $true; $Win.ShowInTaskbar = $false; $Win.ShowActivated = $false; $Win.ResizeMode = 'NoResize'
$Win.Width = 230; $Win.Height = 84 + $SpriteH
$Win.FontFamily = $Font
[Windows.Media.TextOptions]::SetTextFormattingMode($Win, 'Display')   # layered windows get no ClearType: keep small text crisp

$Root = New-Object Windows.Controls.Grid
foreach ($rowH in 84, $SpriteH) { $row = New-Object Windows.Controls.RowDefinition; $row.Height = [Windows.GridLength]::new($rowH); $Root.RowDefinitions.Add($row) }

$Text = New-Object Windows.Controls.TextBlock
$Text.FontSize = 13; $Text.TextWrapping = 'Wrap'; $Text.TextTrimming = 'CharacterEllipsis'; $Text.MaxHeight = 58; $Text.Foreground = $Ink
$Card = New-Object Windows.Controls.Border
$Card.CornerRadius = 10; $Card.Padding = '10,5,10,6'; $Card.MaxWidth = 214; $Card.BorderThickness = 1
$Card.Background = Brush 240 255 255 255; $Card.BorderBrush = Brush 40 0 0 0; $Card.Child = $Text
$Tail = New-Object Windows.Shapes.Polygon
$Tail.Points = [Windows.Media.PointCollection]::Parse('0,0 12,0 6,7'); $Tail.Fill = $Card.Background
$Tail.HorizontalAlignment = 'Center'; $Tail.Margin = '0,-1,0,0'
$Bubble = New-Object Windows.Controls.StackPanel
$Bubble.VerticalAlignment = 'Bottom'; $Bubble.HorizontalAlignment = 'Center'; $Bubble.Visibility = 'Collapsed'
[void]$Bubble.Children.Add($Card); [void]$Bubble.Children.Add($Tail)
[Windows.Controls.Grid]::SetRow($Bubble, 0)

$Img = New-Object Windows.Controls.Image
$Img.Height = $SpriteH; $Img.Stretch = 'Uniform'; $Img.VerticalAlignment = 'Bottom'; $Img.HorizontalAlignment = 'Center'
$Img.RenderTransformOrigin = '0.5,1'
$Breath = New-Object Windows.Media.ScaleTransform(1.0, 1.0)
$Img.RenderTransform = $Breath
[Windows.Media.RenderOptions]::SetBitmapScalingMode($Img, 'HighQuality')
[Windows.Controls.Grid]::SetRow($Img, 1)
[void]$Root.Children.Add($Img); [void]$Root.Children.Add($Bubble)
$Win.Content = $Root

$Win.Add_SourceInitialized({
  try {
    $hwnd = (New-Object Windows.Interop.WindowInteropHelper($Win)).Handle
    $ex = [WhalePet.Native]::GetWindowLong($hwnd, -20)
    # WS_EX_TOOLWINDOW keeps her out of Alt-Tab; WS_EX_NOACTIVATE: clicking her never steals focus from his game or editor
    [void][WhalePet.Native]::SetWindowLong($hwnd, -20, ($ex -bor 0x80 -bor 0x08000000))
    $src = [Windows.PresentationSource]::FromVisual($Win)
    if ($src) {
      $scale = [Math]::Max(1.0, $src.CompositionTarget.TransformToDevice.M22)
      # frames decoded before we knew the DPI would look soft at 125-150%: drop them, the next tick fetches sharp ones
      if ($scale -ne $S.Scale) { $S.Scale = $scale; $S.Sprites.Clear() }
    }
  } catch { Say ('window setup: ' + $_.Exception.Message) }
})
$Win.Add_Closed({ Quit $S.Exit '' })
$Win.Add_MouseEnter({ $S.Hover = $true; Update-Bubble })
$Win.Add_MouseLeave({ $S.Hover = $false; Update-Bubble })
$Win.Add_MouseLeftButtonDown({
  param($src, $e)
  try {
    $x = $Win.Left; $y = $Win.Top
    try { $Win.DragMove() } catch {}
    # DragMove returns on button-up: a press that moved her less than a few pixels was a click, not a drag.
    # The new position lives in memory only; a respawned pet starts at home again.
    if ([Math]::Abs($Win.Left - $x) -lt 4 -and [Math]::Abs($Win.Top - $y) -lt 4) { Open-Window }
  } catch { Say ('click: ' + $_.Exception.Message) }
})

$Menu = New-Object Windows.Controls.ContextMenu
$Menu.FontFamily = $Font
function Add-Item([string]$label, [scriptblock]$action) {
  $mi = New-Object Windows.Controls.MenuItem; $mi.Header = $label; $mi.Add_Click($action); [void]$Menu.Items.Add($mi)
}
Add-Item (U '\u6253\u5f00\u5c0f\u7a97') { try { Open-Window } catch { Say ('menu: ' + $_.Exception.Message) } }
Add-Item (U '\u9690\u85cf 10 \u5206\u949f') { try { $S.HideUntil = (Now) + 600; Check-Visible } catch { Say ('menu: ' + $_.Exception.Message) } }
Add-Item (U '\u5173\u95ed\u684c\u5ba0') { try { Close-Pet } catch { Say ('menu: ' + $_.Exception.Message) } }
$Win.ContextMenu = $Menu

# ~7 mouth changes a second while she talks, like the window page; runs only while talking
$FlapTimer = New-Object Windows.Threading.DispatcherTimer
$FlapTimer.Interval = [TimeSpan]::FromMilliseconds(140)
$FlapTimer.Add_Tick({
  try {
    $S.Mouth = -not $S.Mouth
    if ($S.Mouth -and $S.Open) { Paint $S.Open } elseif ($S.Closed) { Paint $S.Closed }
  } catch { Say ('flap: ' + $_.Exception.Message) }
})

# one 200 ms heartbeat: show/hide, poll /api/live once a second, collect sprite downloads, keep the bubble honest
$Tick = New-Object Windows.Threading.DispatcherTimer
$Tick.Interval = [TimeSpan]::FromMilliseconds(200)
$Tick.Add_Tick({
  try { Check-Visible; Pump-Live; Pump-Sprites; Check-Closing; Update-Bubble } catch { Say ('tick: ' + $_.Exception.Message) }
})

try {
  Place-Home
  $Tick.Start()
  [void]$App.Run()
} catch { Say ('crashed: ' + $_.Exception.Message); $S.Exit = 1 }
finally {
  try { $Tick.Stop(); $FlapTimer.Stop() } catch {}
  try { $Http.Dispose() } catch {}
  try { $Mutex.ReleaseMutex() } catch {}
}
exit $S.Exit
