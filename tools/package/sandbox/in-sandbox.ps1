# SPDX-License-Identifier: GPL-3.0-or-later
<#
.SYNOPSIS
  Runs INSIDE Windows Sandbox (started by tools/package/sandbox/sandbox-check.mjs): a clean Windows with nothing else
  installed. Checks one Ujwalam-Setup-<version>.exe end to end, the way a new user meets it:
    1. install    Setup --install --quiet from a copy in Downloads; files, current.txt and shortcuts present
    2. first start  the desktop shortcut's own command; the launcher log must say the UI is up; the libobs host line
                  and the running programs are recorded; a screenshot is taken; the studio window is closed and
                  everything must end by itself (leftovers are recorded, then stopped)
    3. download   one item from the build's download catalogue with the installed download manager and Node.js
                  (download-check.mjs), with a pause and resume
    4. uninstall  <install root>\Ujwalam-Setup.exe --uninstall --quiet; the version folder and shortcuts are gone, the
                  data folder is kept
  Results go to <Out>\results.json (one entry per step: ok, seconds, detail), logs and the screenshot next to it, and
  <Out>\done.json last. The Sandbox then shuts down unless -KeepOpen.
#>
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Download = 'face-ai-models',
  [int]$StartTimeoutS = 240,
  [switch]$KeepOpen
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $env:LOCALAPPDATA 'Ujwalam'
$data = Join-Path $root 'data'
$steps = New-Object System.Collections.ArrayList
$transcript = Join-Path $Out 'in-sandbox.log'
function Note([string]$m) { Add-Content -LiteralPath $transcript -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
Note "started as $env:USERNAME, setup $Setup"

function Step([string]$name, [scriptblock]$body) {
  Note "== $name"
  $t = [Diagnostics.Stopwatch]::StartNew()
  $r = [ordered]@{ name = $name; ok = $false; seconds = 0; detail = @{} }
  try { $r.detail = & $body; $r.ok = [bool]$r.detail.ok } catch { $r.detail = @{ error = $_.Exception.Message } }
  $r.seconds = [math]::Round($t.Elapsed.TotalSeconds, 1)
  Note ("   ok={0} {1}s" -f $r.ok, $r.seconds)
  [void]$steps.Add($r)
  return $r.ok
}

function Our-Processes {
  # Found by path (never by name): everything running from the install root.
  @(Get-Process | Where-Object { try { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
}

function Save-Screenshot([string]$file) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Shortcut-Target([string]$lnk) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  @{ target = $s.TargetPath; args = $s.Arguments; dir = $s.WorkingDirectory }
}

$startMenu = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
$liveLnk = Join-Path $desktop 'Ujwalam (alpha).lnk'

# ---- 0. the machine ----
$env0 = [ordered]@{
  os = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version)" })
  gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
  memoryMB = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
  python = [bool](Get-Command python -ErrorAction SilentlyContinue)
  ffmpeg = [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue)
  # Defender's query can hang on a fresh Sandbox: read it in a job with a 20 s limit
  defender = $(try { $j = Start-Job { (Get-MpComputerStatus).RealTimeProtectionEnabled }; if (Wait-Job $j -Timeout 20) { "realtime=$(Receive-Job $j)" } else { 'no answer in 20 s' } } catch { 'unknown' })
}
Note ("machine: " + ($env0 | ConvertTo-Json -Compress))

# ---- 1. install ----
$installed = Step 'install' {
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  New-Item -ItemType Directory -Force -Path $dl | Out-Null
  $copy = Join-Path $dl (Split-Path -Leaf $Setup)
  Copy-Item -LiteralPath $Setup -Destination $copy
  $log = Join-Path $Out 'setup-install.log'
  $p = Start-Process -FilePath $copy -ArgumentList '--install', '--quiet' -Wait -PassThru -RedirectStandardOutput $log -WindowStyle Hidden
  $cur = if (Test-Path (Join-Path $root 'current.txt')) { (Get-Content (Join-Path $root 'current.txt') -Raw).Trim() } else { $null }
  $ver = if ($cur) { if ([IO.Path]::IsPathRooted($cur)) { $cur } else { Join-Path $root $cur } } else { $null }
  $want = @{
    exit0 = ($p.ExitCode -eq 0)
    current = [bool]($ver -and (Test-Path (Join-Path $ver 'release.json')))
    startExe = Test-Path (Join-Path $root 'ujwalam-start.exe')
    setupCopy = Test-Path (Join-Path $root 'Ujwalam-Setup.exe')
    desktopShortcut = Test-Path $liveLnk
    startMenuShortcut = [bool](Get-ChildItem $startMenu -Recurse -Filter 'Ujwalam (alpha).lnk' -ErrorAction SilentlyContinue)
    bundledNode = [bool]($ver -and (Test-Path (Join-Path $ver 'runtime\node\node.exe')))
  }
  $bad = @($want.Keys | Where-Object { -not $want[$_] })
  @{ ok = ($bad.Count -eq 0); exitCode = $p.ExitCode; version = $cur; versionDir = $ver; checks = $want; failed = $bad }
}
$verDir = $null
if ($installed) { $verDir = $steps[$steps.Count - 1].detail.versionDir }

# ---- 2. first start ----
if ($installed) {
  [void](Step 'first-start' {
    $sc = Shortcut-Target $liveLnk
    $p = Start-Process -FilePath $sc.target -ArgumentList $sc.args -WorkingDirectory $sc.dir -PassThru
    $logs = Join-Path $data 'core\logs'
    $deadline = (Get-Date).AddSeconds($StartTimeoutS)
    $ui = $false; $hostLine = $null; $launchLog = $null
    while ((Get-Date) -lt $deadline) {
      $launchLog = Get-ChildItem $logs -Filter 'launcher-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($launchLog) {
        $text = Get-Content -LiteralPath $launchLog.FullName -Raw -ErrorAction SilentlyContinue
        if ($text -match '\[studio\] libobs host [^\r\n]*') { $hostLine = $Matches[0] }
        if ($text -match '\[studio\] UI at http://127\.0\.0\.1:\d+/') { $ui = $true }
        if ($ui -and $hostLine) { break }
      }
      Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds 20 # let the window draw, then look
    Save-Screenshot (Join-Path $Out 'first-start.png')
    # what is there, before anything is stopped: the start program's exit, every log and the data folder
    $startExit = if ($p.HasExited) { $p.ExitCode } else { 'running' }
    $logOut = Join-Path $Out 'logs'
    New-Item -ItemType Directory -Force -Path $logOut | Out-Null
    Get-ChildItem $root -Recurse -Filter '*.log' -ErrorAction SilentlyContinue | Copy-Item -Destination $logOut -Force -ErrorAction SilentlyContinue
    Get-ChildItem $data -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($root.Length) } | Set-Content (Join-Path $Out 'data-files.txt')
    $running = @(Our-Processes | ForEach-Object { "$($_.ProcessName) $($_.Id)" })
    $studio = @(Our-Processes | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like 'ujwalam-studio*' })
    # The first start opens Settings (modal) over the main window, which disables it, and CloseMainWindow refuses a
    # disabled window (alpha.42 runs: 0 closes). So post WM_CLOSE to every visible top-level window of the studio, the
    # dialog first in z-order, every 3 s until it is gone, like a user closing each window's X.
    if (-not ('UjwWin' -as [type])) {
      Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class UjwWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int CloseAll(uint pid) {
    var hits = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) hits.Add(h); return true; }, IntPtr.Zero);
    foreach (var h in hits) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
    return hits.Count;
  }
}
'@
    }
    $stopDeadline = (Get-Date).AddSeconds(60)
    $closes = 0
    while ((Get-Date) -lt $stopDeadline -and @(Our-Processes).Count -gt 0) {
      foreach ($s in @(Our-Processes | Where-Object { $_.ProcessName -like 'ujwalam-studio*' })) { $closes += [UjwWin]::CloseAll([uint32]$s.Id) }
      Start-Sleep -Seconds 3
    }
    $left = @(Our-Processes | ForEach-Object { "$($_.ProcessName) $($_.Id)" })
    Our-Processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-ChildItem $root -Recurse -Filter '*.log' -ErrorAction SilentlyContinue | Copy-Item -Destination $logOut -Force -ErrorAction SilentlyContinue
    $hostOk = [bool]($hostLine -and $hostLine -match 'host started')
    @{ ok = ($ui -and $hostOk -and $studio.Count -gt 0 -and $left.Count -eq 0); ui = $ui; hostLine = $hostLine; startExit = $startExit;
       studioWindows = $studio.Count; closeRequests = $closes; running = $running; leftAfterClose = $left; shortcut = $sc
       launcherLog = if ($launchLog) { $launchLog.Name } else { $null } }
  })
}

# ---- 3. one download ----
if ($installed) {
  [void](Step 'download' {
    $node = Join-Path $verDir 'runtime\node\node.exe'
    $o = & $node (Join-Path $here 'download-check.mjs') --install $verDir --data $data --id $Download 2>&1
    $code = $LASTEXITCODE
    $line = @($o | Where-Object { "$_".StartsWith('{') }) | Select-Object -Last 1
    $r = if ($line) { "$line" | ConvertFrom-Json } else { $null }
    @{ ok = ($code -eq 0); exitCode = $code; result = $r; output = @($o | ForEach-Object { "$_" } | Select-Object -Last 20) }
  })
}

# ---- 4. uninstall ----
if ($installed) {
  [void](Step 'uninstall' {
    $setupCopy = Join-Path $root 'Ujwalam-Setup.exe'
    $log = Join-Path $Out 'setup-uninstall.log'
    $p = Start-Process -FilePath $setupCopy -ArgumentList '--uninstall', '--quiet' -Wait -PassThru -RedirectStandardOutput $log -WindowStyle Hidden
    Start-Sleep -Seconds 5 # the uninstaller runs from a temp copy
    $want = @{
      exit0 = ($p.ExitCode -eq 0)
      versionGone = -not (Test-Path $verDir)
      currentGone = -not (Test-Path (Join-Path $root 'current.txt'))
      startExeGone = -not (Test-Path (Join-Path $root 'ujwalam-start.exe'))
      desktopShortcutGone = -not (Test-Path $liveLnk)
      startMenuGone = -not [bool](Get-ChildItem $startMenu -Recurse -Filter 'Ujwalam*.lnk' -ErrorAction SilentlyContinue)
      dataKept = Test-Path $data
    }
    $bad = @($want.Keys | Where-Object { -not $want[$_] })
    $leftFiles = @(Get-ChildItem $root -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'data' } | ForEach-Object { $_.Name })
    @{ ok = ($bad.Count -eq 0); exitCode = $p.ExitCode; checks = $want; failed = $bad; leftInRoot = $leftFiles }
  })
}

$all = [ordered]@{
  setup = (Split-Path -Leaf $Setup); finished = (Get-Date).ToString('o'); machine = $env0; steps = $steps
  ok = (@($steps | Where-Object { -not $_.ok }).Count -eq 0 -and $steps.Count -eq 4)
}
$all | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Out 'results.json') -Encoding UTF8
@{ ok = $all.ok } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Out 'done.json') -Encoding UTF8
if (-not $KeepOpen) { shutdown.exe /s /t 5 }
