param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

function Test-ChromeExtensionVersion([string]$Candidate) {
  $parts = $Candidate.Split(".")
  if ($parts.Count -lt 1 -or $parts.Count -gt 4) {
    return $false
  }

  foreach ($part in $parts) {
    if ($part -notmatch "^(0|[1-9]\d{0,4})$") {
      return $false
    }

    if ([int]$part -gt 65535) {
      return $false
    }
  }

  return $true
}

function Set-JsonVersion([string]$Path, [string]$NewVersion) {
  $content = Get-Content -Path $Path -Raw
  $matches = [regex]::Matches($content, '"version"\s*:\s*"[^"]+"')
  if ($matches.Count -ne 1) {
    throw "Expected exactly one version field in $Path."
  }

  $updated = [regex]::Replace($content, '"version"\s*:\s*"[^"]+"', "`"version`": `"$NewVersion`"", 1)
  Set-Content -Path $Path -Value $updated -Encoding utf8
}

if (-not (Test-ChromeExtensionVersion $Version)) {
  throw "Version must contain one to four dot-separated integers between 0 and 65535."
}

$projectDirectory = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectDirectory "package.json"
$manifestPath = Join-Path $projectDirectory "public/manifest.json"
$updatePath = Join-Path $projectDirectory "public/updates/latest.json"
$tag = "v$Version"
$archivePath = Join-Path $projectDirectory "releases/xTranslator-$Version.zip"
$cdnUrl = "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@$tag/releases/xTranslator-$Version.zip"

Push-Location $projectDirectory
try {
  if ((& git status --porcelain)) {
    throw "The working tree must be clean before releasing. Commit or stash unrelated changes first."
  }

  if ((& git branch --show-current) -ne "main") {
    throw "Releases must be created from the main branch."
  }

  if ((& git tag --list $tag) -or (& git ls-remote --tags origin "refs/tags/$tag")) {
    throw "Tag $tag already exists. Release a new version instead of changing an existing tag."
  }

  Set-JsonVersion $packageJsonPath $Version
  Set-JsonVersion $manifestPath $Version

  & pnpm package
  if ($LASTEXITCODE -ne 0) {
    throw "Extension package creation failed."
  }

  $updateManifest = Get-Content -Path $updatePath -Raw | ConvertFrom-Json
  if ($updateManifest.version -ne $Version -or $updateManifest.downloadUrl -ne $cdnUrl) {
    throw "The generated update manifest does not match the release version."
  }

  & git add package.json public/manifest.json public/updates/latest.json $archivePath
  & git commit -m "release: $tag"
  if ($LASTEXITCODE -ne 0) {
    throw "Release commit failed."
  }

  & git tag -a $tag -m "Release $tag"
  & git push origin main --follow-tags
  if ($LASTEXITCODE -ne 0) {
    throw "Release push failed."
  }

  $available = $false
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    $status = & curl.exe -sS -L -o NUL -w "%{http_code}" $cdnUrl
    if ($status -eq "200") {
      $available = $true
      break
    }

    Start-Sleep -Seconds 10
  }

  if (-not $available) {
    throw "GitHub received $tag, but jsDelivr has not made the archive available yet: $cdnUrl"
  }

  Write-Host "Published $tag"
  Write-Host "Download: $cdnUrl"
} finally {
  Pop-Location
}
