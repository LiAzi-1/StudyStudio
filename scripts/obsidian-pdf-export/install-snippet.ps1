# install-snippet.ps1
# Installs the Obsidian print CSS snippet into the real vault and enables it.
# Run:  powershell -ExecutionPolicy Bypass -File install-snippet.ps1
# Safe: backs up appearance.json before changing it, never touches notes.

param(
  [string]$Vault,
  [string]$Source = (Join-Path $PSScriptRoot 'mobile-print.css'),
  [string]$BackupDir = (Join-Path $PSScriptRoot 'backups')
)

$ErrorActionPreference = 'Stop'

function Resolve-Vault {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  $reg = Join-Path $env:APPDATA 'obsidian\obsidian.json'
  if (Test-Path $reg) {
    $json = Get-Content $reg -Raw | ConvertFrom-Json
    foreach ($p in $json.vaults.PSObject.Properties) {
      if ($p.Value.open -eq $true -and (Test-Path $p.Value.path)) { return $p.Value.path }
    }
    $first = $json.vaults.PSObject.Properties | Select-Object -First 1
    if ($first -and (Test-Path $first.Value.path)) { return $first.Value.path }
  }
  return (Join-Path $env:APPDATA 'studystudio\obsidian-vault')
}

if (-not (Test-Path $Source)) { throw "snippet source not found: $Source" }
$vaultPath = Resolve-Vault -Explicit $Vault
$cfgDir = Join-Path $vaultPath '.obsidian'
if (-not (Test-Path $cfgDir)) { throw "not an Obsidian vault (no .obsidian): $vaultPath" }

Write-Host "vault   : $vaultPath"
Write-Host "snippet : $Source"

# 1) backup appearance.json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $BackupDir $stamp
New-Item -ItemType Directory -Force -Path $bak | Out-Null
$appearance = Join-Path $cfgDir 'appearance.json'
if (Test-Path $appearance) {
  Copy-Item $appearance (Join-Path $bak 'appearance.json.bak') -Force
  Write-Host "backup  : $bak\appearance.json.bak"
} else {
  Write-Host "backup  : appearance.json did not exist (nothing to back up)"
}

# 2) copy snippet
$snipDir = Join-Path $cfgDir 'snippets'
New-Item -ItemType Directory -Force -Path $snipDir | Out-Null
Copy-Item $Source (Join-Path $snipDir 'mobile-print.css') -Force
Write-Host "copied  : $snipDir\mobile-print.css"

# 3) enable snippet in appearance.json (merge, keep other keys)
$settings = @{}
if (Test-Path $appearance) {
  $raw = Get-Content $appearance -Raw
  if ($raw.Trim()) {
    $obj = $raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $settings[$p.Name] = $p.Value }
  }
}
$enabled = @()
if ($settings.ContainsKey('enabledCssSnippets') -and $settings['enabledCssSnippets']) {
  $enabled = @($settings['enabledCssSnippets'])
}
if ($enabled -notcontains 'mobile-print') { $enabled += 'mobile-print' }
$settings['enabledCssSnippets'] = $enabled

$outJson = $settings | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($appearance, $outJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "updated : $appearance"
Get-Content $appearance -Raw

Write-Host ''
Write-Host 'Done. Restart Obsidian (or reload the app) so the snippet takes effect.'
Write-Host 'Rollback: copy the .bak file back over appearance.json and delete snippets\mobile-print.css.'
