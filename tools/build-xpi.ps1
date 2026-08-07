$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$dist = Join-Path $root "dist"
$out = Join-Path $dist ("zotero-ai-assistant-" + $manifest.version + ".xpi")

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path -LiteralPath $out) {
  Remove-Item -LiteralPath $out -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$items = @(
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "content"
)

$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $items) {
    $path = Join-Path $root $item
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $entryName = $item -replace "\\", "/"
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $path, $entryName) | Out-Null
      continue
    }

    $files = Get-ChildItem -LiteralPath $path -File -Recurse
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($root.Length).TrimStart("\", "/")
      $entryName = $relative -replace "\\", "/"
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName) | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}

Write-Host "Built $out"
