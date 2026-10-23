# Run on Windows CI. Exercises launcher errors without starting Docker or opening a browser.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('Miracle Проверка ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$oldPath = $env:PATH
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../release/local.ps1') -Destination $root
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../release/compose.yaml') -Destination $root
  Set-Content -LiteralPath (Join-Path $root 'settings.env') -Value 'MIRACLE_PORT=3456' -Encoding ascii
  $env:PATH = "$root;$oldPath"
  $env:MIRACLE_MOCK_LOG = Join-Path $root 'calls.txt'
  @'
@echo off
echo %* >> "%MIRACLE_MOCK_LOG%"
if "%MIRACLE_MOCK_FAIL%"=="daemon" if "%1"=="info" exit /b 1
if "%MIRACLE_MOCK_FAIL%"=="pull" echo %* | findstr /c:"pull" >nul && exit /b 1
if "%MIRACLE_MOCK_FAIL%"=="port" echo %* | findstr /c:"up -d" >nul && exit /b 1
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $root 'docker.cmd') -Encoding ascii
  foreach ($case in @(@('daemon','start','Start Docker Desktop'), @('pull','start','Could not download'), @('port','start','settings.env'))) {
    $env:MIRACLE_MOCK_FAIL = $case[0]
    $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'local.ps1') $case[1] 2>&1 | Out-String
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0 -or -not $output.Contains($case[2])) { throw "Expected actionable $($case[0]) failure: $output" }
  }
  $env:MIRACLE_MOCK_FAIL = ''
  $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'local.ps1') stop 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or -not $output.Contains('Data and encryption keys are preserved')) { throw "Stop failed: $output" }
  $calls = Get-Content -LiteralPath $env:MIRACLE_MOCK_LOG -Raw
  if (-not $calls.Contains('settings.env') -or $calls.Contains('down --volumes')) { throw 'Unsafe or incorrect compose invocation.' }
  Write-Host 'Windows launcher error/stop smoke passed from path with spaces and Cyrillic.'
} finally {
  $env:PATH = $oldPath
  Remove-Item Env:MIRACLE_MOCK_LOG -ErrorAction SilentlyContinue
  Remove-Item Env:MIRACLE_MOCK_FAIL -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force
}
