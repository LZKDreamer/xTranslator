$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectDirectory "package.json"
$manifestPath = Join-Path $projectDirectory "public/manifest.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

if ($packageJson.version -ne $manifest.version) {
  throw "package.json and public/manifest.json must use the same version."
}

$version = $manifest.version
$releaseDirectory = Join-Path $projectDirectory "releases"
$archiveName = "xTranslator-$version.zip"
$archivePath = Join-Path $releaseDirectory $archiveName
$updateDirectory = Join-Path $projectDirectory "public/updates"
$updatePath = Join-Path $updateDirectory "latest.json"
$downloadUrl = "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v$version/releases/$archiveName"

New-Item -ItemType Directory -Force -Path $releaseDirectory, $updateDirectory | Out-Null
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($updatePath, (@{ version = $version; downloadUrl = $downloadUrl } | ConvertTo-Json), $utf8NoBom)

Push-Location $projectDirectory
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "Extension build failed."
  }

  if (Test-Path $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }

  $extensionFiles = @("manifest.json", "_locales", "background", "content", "icons", "options", "popup", "styles", "updates") |
    ForEach-Object { Join-Path $projectDirectory $_ }
  Compress-Archive -Path $extensionFiles -DestinationPath $archivePath -CompressionLevel Optimal
} finally {
  Pop-Location
}

Write-Host "Created $archivePath"
