param(
  [Parameter(Position=0)][ValidateSet('start','stop','backup','restore')][string]$Action = 'start',
  [Parameter(Position=1)][string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
if ($ArchivePath) { $ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath) }
Set-Location -LiteralPath $PSScriptRoot
$composePrefix = @('compose')
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'settings.env')) { $composePrefix += @('--env-file', (Join-Path $PSScriptRoot 'settings.env')) }
$composePrefix += @('-f', (Join-Path $PSScriptRoot 'compose.yaml'))
function Invoke-Compose {
  & docker @script:composePrefix @args
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Read the error above.' }
}
function Invoke-Maintenance { Invoke-Compose run --rm -T --no-deps maintenance @args }
# Windows PowerShell 5.1 text pipelines corrupt binary archives. Copy raw streams.
function Invoke-Archive {
  param([string]$Command, [string]$InputPath, [string]$OutputPath)
  $arguments = @($script:composePrefix) + @('run','--rm','-T','--no-deps','maintenance',$Command)
  $quoted = $arguments | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = 'docker'
  $info.Arguments = $quoted -join ' '
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = [bool]$InputPath
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  $errors = $process.StandardError.ReadToEndAsync()
  if ($OutputPath) {
    $stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::CreateNew)
    try { $process.StandardOutput.BaseStream.CopyTo($stream) } finally { $stream.Dispose() }
  } else {
    $output = $process.StandardOutput.ReadToEndAsync()
  }
  if ($InputPath) {
    $stream = [System.IO.File]::OpenRead($InputPath)
    try { $stream.CopyTo($process.StandardInput.BaseStream) } finally { $stream.Dispose(); $process.StandardInput.Close() }
  }
  $process.WaitForExit()
  $errorText = $errors.GetAwaiter().GetResult()
  if ($errorText) { [Console]::Error.Write($errorText) }
  if ($process.ExitCode -ne 0) { throw "Docker maintenance failed: $Command. Existing data is preserved." }
}
function Start-App {
  try { Invoke-Compose up -d --wait --wait-timeout 180 postgres app }
  catch { throw 'Startup failed. If the local port is occupied, change MIRACLE_PORT in settings.env (for example 3002), then run start.cmd again. Inspect: docker compose logs --tail 80 app postgres' }
}
function Show-Link {
  $url = (Invoke-Compose exec -T app node dist/server/server/cli.js setup-link | Out-String).Trim()
  Write-Host "Open Miracle: $url"
  try { Start-Process -FilePath $url } catch { Write-Host 'Open the URL above in your browser.' }
}
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop: https://docs.docker.com/get-docker/' }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable. Start Docker Desktop and try again.' }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required. Update Docker Desktop.' }
  switch ($Action) {
    'start' {
      try { Invoke-Compose pull app postgres maintenance } catch { throw 'Could not download the release images. Check your connection and image availability, then try again.' }
      Invoke-Maintenance init
      Start-App
      Show-Link
    }
    'stop' {
      Invoke-Compose stop app postgres
      Write-Host 'Miracle stopped. Data and encryption keys are preserved.'
    }
    'backup' {
      if (-not $ArchivePath) { $ArchivePath = Join-Path $PSScriptRoot ('miracle-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tar.gz') }
      $ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
      if ((Test-Path -LiteralPath $ArchivePath) -or (Test-Path -LiteralPath ($ArchivePath + '.partial'))) { throw 'Backup destination already exists. Choose another filename.' }
      Invoke-Compose stop app
      Invoke-Compose up -d --wait --wait-timeout 120 postgres
      try {
        Invoke-Archive -Command backup -OutputPath ($ArchivePath + '.partial')
        if ((Get-Item -LiteralPath ($ArchivePath + '.partial')).Length -eq 0) { throw 'Backup was empty.' }
        Move-Item -LiteralPath ($ArchivePath + '.partial') -Destination $ArchivePath
      } catch {
        Remove-Item -LiteralPath ($ArchivePath + '.partial') -Force -ErrorAction SilentlyContinue
        throw
      }
      Invoke-Maintenance mark-backup
      Write-Host "Backup saved: $ArchivePath"
      Write-Host 'The app is stopped. Keep this archive private: it contains database credentials and encryption keys.'
    }
    'restore' {
      if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw 'Usage: restore.cmd "C:\path\miracle-backup.tar.gz"' }
      $ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
      Invoke-Maintenance restore-check
      Invoke-Compose stop app postgres
      Invoke-Archive -Command prepare-restore -InputPath $ArchivePath
      Invoke-Compose up -d --wait --wait-timeout 120 postgres
      Invoke-Maintenance restore-db
      Invoke-Maintenance init
      Start-App
      Show-Link
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
