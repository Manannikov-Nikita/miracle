$ErrorActionPreference = 'Stop'
$Version = '__VERSION__'
$Repository = '__REPOSITORY__'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'Miracle requires Windows x64. Windows ARM is unsupported.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Root = if ($env:MIRACLE_INSTALL_ROOT) { $env:MIRACLE_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'Miracle' }
$Bin = if ($env:MIRACLE_BIN_DIR) { $env:MIRACLE_BIN_DIR } else { Join-Path $Root 'bin' }
$Asset = "miracle-$Version-win-x64.zip"
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
 $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
 try {
  foreach ($Entry in $Zip.Entries) {
   $Name = $Entry.FullName
   if ($Name -match '[:\\]|(^|/)\.\.(/|$)' -or -not $Name.StartsWith("$Top/", [StringComparison]::Ordinal)) { throw 'Unsafe release archive paths.' }
   $Kind = ($Entry.ExternalAttributes -shr 16) -band 0xf000
   if ($Kind -notin @(0, 0x4000, 0x8000)) { throw 'Release archive contains unsupported links.' }
  }
 } finally { $Zip.Dispose() }
 [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Temporary)
 $Payload = Join-Path $Temporary $Top
 & (Join-Path $Payload 'runtime/node.exe') (Join-Path $Payload 'install.mjs') $Payload $Root $Bin
 if ($LASTEXITCODE -ne 0) { throw 'Miracle installation failed; existing data is preserved.' }
} finally { Remove-Item -LiteralPath $Temporary -Recurse -Force }
