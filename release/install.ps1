$ErrorActionPreference = 'Stop'
$Version = '__VERSION__'
$Repository = '__REPOSITORY__'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'Miracle requires Windows x64. Windows ARM is unsupported.' }
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $Tar -PathType Leaf)) { throw 'Miracle requires the Windows system tar.exe (Windows 10 1809 or later).' }
$Root = if ($env:MIRACLE_INSTALL_ROOT) { $env:MIRACLE_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'Miracle' }
$Bin = if ($env:MIRACLE_BIN_DIR) { $env:MIRACLE_BIN_DIR } else { Join-Path $Root 'bin' }
$Asset = "miracle-$Version-win-x64.tar.gz"
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ('miracle-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
 $Archive = Join-Path $Temporary $Asset
 $Checksum = Join-Path $Temporary 'checksum'
 if ($env:MIRACLE_ARCHIVE) {
  Copy-Item -LiteralPath $env:MIRACLE_ARCHIVE -Destination $Archive
  $ChecksumSource = if ($env:MIRACLE_CHECKSUM_FILE) { $env:MIRACLE_CHECKSUM_FILE } else { "$($env:MIRACLE_ARCHIVE).sha256" }
  Copy-Item -LiteralPath $ChecksumSource -Destination $Checksum
 } else {
  $Base = "https://github.com/$Repository/releases/download/v$Version"
  Invoke-WebRequest -UseBasicParsing "$Base/$Asset" -OutFile $Archive
  Invoke-WebRequest -UseBasicParsing "$Base/$Asset.sha256" -OutFile $Checksum
 }
 $Expected = ((Get-Content -LiteralPath $Checksum -Raw).Trim() -split '\s+')[0]
 if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Expected) { throw 'Release checksum mismatch; existing installation is unchanged.' }
 $Top = "miracle-$Version-win-x64"
 $Entries = & $Tar -tzf $Archive
 if ($LASTEXITCODE -ne 0) { throw 'Release archive is invalid.' }
 foreach ($Entry in $Entries) { if ($Entry -match '(^[/\\]|(^|[/\\])\.\.($|[/\\]))' -or ($Entry -ne $Top -and -not $Entry.StartsWith("$Top/"))) { throw 'Unsafe release archive paths.' } }
 $Details = & $Tar -tvzf $Archive
 if ($LASTEXITCODE -ne 0 -or ($Details | Where-Object { $_ -notmatch '^[-d]' })) { throw 'Release archive contains unsupported links.' }
 & $Tar -xzf $Archive -C $Temporary
 if ($LASTEXITCODE -ne 0) { throw 'Release extraction failed; existing installation is unchanged.' }
 $Payload = Join-Path $Temporary $Top
 & (Join-Path $Payload 'runtime/node.exe') (Join-Path $Payload 'install.mjs') $Payload $Root $Bin
 if ($LASTEXITCODE -ne 0) { throw 'Miracle installation failed; existing data is preserved.' }
} finally { Remove-Item -LiteralPath $Temporary -Recurse -Force }
