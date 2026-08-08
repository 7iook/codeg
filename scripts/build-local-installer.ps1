<#
.SYNOPSIS
    Build the codeg installer locally — one command, no env vars to remember.

.DESCRIPTION
    This script exists because "build it locally" has four preconditions that
    cost a debugging round every time they are rediscovered, and they live in
    three different files (package.json, tauri.conf.json, release.yml):

      1. NODE_ENV must be `production`. Tool shells (mcphub and friends) export
         NODE_ENV=development, and Next 16 then fails static prerendering with
         `useContext null`.
      2. Windows must skip MSI. tauri#14681: with `externalBin` configured
         (this repo's codeg-mcp sidecar) WiX light.exe always fails ICE30 —
         codeg-mcp.exe ends up installed by two components at one path. The
         project's own CI already skips it (`--bundles nsis` in release.yml).
      3. The sidecar must be staged AND checked. CI does it in two steps:
         prepare-sidecars, then a separate "Verify codeg-mcp sidecar landed".
      4. The updater signature cannot be produced locally. The private key is a
         CI secret (TAURI_SIGNING_PRIVATE_KEY) and is not meant to exist on a
         dev machine, so a local build yields an installer but no `.sig`. That
         is expected, not a failure — and because signing runs AFTER bundling,
         the command exits non-zero with a perfectly good installer on disk.

    Local installers only. Real releases go through CI (push a tag →
    release.yml), which holds the signing key and the cross-platform matrix.

.PARAMETER SkipVerify
    Skip the pre-build checks. They run by default: an installer is a binary
    someone will execute, and shipping unverified code inside one makes a later
    failure impossible to attribute between "bad build" and "bad code".

.PARAMETER KeepArtifactWhereItIs
    Leave the installer in the cargo target dir instead of copying it to
    dist-installer/ (the copy is byte-count verified).

.EXAMPLE
    pwsh -File scripts/build-local-installer.ps1

.EXAMPLE
    pwsh -File scripts/build-local-installer.ps1 -SkipVerify
#>
[CmdletBinding()]
param(
    [switch]$SkipVerify,
    [switch]$KeepArtifactWhereItIs
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Step { param([string]$M) Write-Host "`n=== $M ===" -ForegroundColor Cyan }
function Ok   { param([string]$M) Write-Host "  [ok] $M" -ForegroundColor Green }
function Die  { param([string]$M) Write-Host "  [FATAL] $M" -ForegroundColor Red; exit 1 }

# ── Preflight ───────────────────────────────────────────────────────────────
# Fail here rather than 6 minutes into a release build.

Step 'Preflight'
foreach ($tool in @('cargo', 'rustc', 'node', 'pnpm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Die "$tool not on PATH"
    }
}
Ok "cargo / rustc / node / pnpm present"

# The three version fields must agree, or the installer filename and the
# updater manifest disagree about what this build IS.
$pkgVersion = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$confVersion = (Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$cargoVersion = (Select-String -Path (Join-Path $repo 'src-tauri\Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
if ($pkgVersion -ne $confVersion -or $pkgVersion -ne $cargoVersion) {
    Die "version mismatch: package.json=$pkgVersion tauri.conf.json=$confVersion Cargo.toml=$cargoVersion"
}
Ok "version $pkgVersion (all three manifests agree)"

# NODE_ENV: see the header. Set for THIS process only, so the caller's shell is
# left alone.
$priorNodeEnv = $env:NODE_ENV
$env:NODE_ENV = 'production'
Ok "NODE_ENV=production (was: $(if ($priorNodeEnv) { $priorNodeEnv } else { '<unset>' }))"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Host "  [note] no TAURI_SIGNING_PRIVATE_KEY -- updater .sig will NOT be produced." -ForegroundColor Yellow
    Write-Host "         Expected locally; signing keys live only in CI secrets." -ForegroundColor Yellow
}

# ── Verify ──────────────────────────────────────────────────────────────────

if ($SkipVerify) {
    Write-Host "`n  [skipped] verification (-SkipVerify)" -ForegroundColor Yellow
} else {
    Step 'Verify (fmt / clippy x3 targets / tests)'
    Push-Location (Join-Path $repo 'src-tauri')
    try {
        & cargo fmt --check
        if ($LASTEXITCODE -ne 0) { Die 'cargo fmt --check failed -- run `cargo fmt`' }
        Ok 'cargo fmt --check'

        & cargo clippy --all-targets --features test-utils -- -D warnings
        if ($LASTEXITCODE -ne 0) { Die 'clippy (desktop) failed' }
        Ok 'clippy desktop'

        & cargo clippy --no-default-features --bin codeg-server --lib -- -D warnings
        if ($LASTEXITCODE -ne 0) { Die 'clippy (server) failed' }
        Ok 'clippy server'

        & cargo clippy --no-default-features --bin codeg-mcp -- -D warnings
        if ($LASTEXITCODE -ne 0) { Die 'clippy (mcp) failed' }
        Ok 'clippy mcp'

        # Server target, NOT the desktop one: `cargo test --lib` with the Tauri
        # runtime crashes on Windows with 0xc0000139
        # STATUS_ENTRYPOINT_NOT_FOUND (tauri#13419, still open). The server
        # target compiles the same library code minus the Tauri deps, so it
        # covers the backend logic without hitting that bug.
        & cargo test --no-default-features --bin codeg-server --lib
        if ($LASTEXITCODE -ne 0) { Die 'backend tests failed' }
        Ok 'backend tests'
    } finally { Pop-Location }

    Push-Location $repo
    try {
        & pnpm test
        if ($LASTEXITCODE -ne 0) { Die 'frontend tests failed' }
        Ok 'frontend tests'
    } finally { Pop-Location }
}

# ── Sidecar ─────────────────────────────────────────────────────────────────
# Staged + verified as its own step, mirroring CI. `prepare-sidecars.mjs`
# resolves the artifact via `cargo metadata`, so CARGO_TARGET_DIR /
# build.target-dir / a workspace root all work.

Step 'Stage codeg-mcp sidecar'
Push-Location $repo
try {
    & pnpm tauri:prepare-sidecars
    if ($LASTEXITCODE -ne 0) { Die 'prepare-sidecars failed' }
} finally { Pop-Location }

$triple = (& rustc -vV | Select-String -Pattern '^host:\s*(.+)$').Matches[0].Groups[1].Value.Trim()
$sidecar = Join-Path $repo "src-tauri\binaries\codeg-mcp-$triple.exe"
if (-not (Test-Path -LiteralPath $sidecar)) {
    Die "sidecar missing after prepare-sidecars: $sidecar"
}
Ok "sidecar staged: $([math]::Round((Get-Item $sidecar).Length / 1MB, 1)) MB"

# ── Bundle ──────────────────────────────────────────────────────────────────

Step 'Bundle NSIS installer'
# CODEG_SKIP_SIDECAR: the sidecar is already staged and verified above.
# Without this, beforeBuildCommand runs prepare-sidecars a second time.
$env:CODEG_SKIP_SIDECAR = '1'
# `--bundles nsis` — MSI is deliberately excluded, see the header (tauri#14681).
Push-Location $repo
try {
    & pnpm tauri build --bundles nsis
    $bundleExit = $LASTEXITCODE
} finally { Pop-Location }

# The installer is produced BEFORE the updater-signing step, so a missing
# private key fails the command while leaving a perfectly good installer on
# disk. Judge success by the artifact, not by the exit code.
$targetDir = (& cargo metadata --format-version 1 --no-deps --manifest-path (Join-Path $repo 'src-tauri\Cargo.toml') |
    ConvertFrom-Json).target_directory
$installer = Join-Path $targetDir "release\bundle\nsis\codeg_${pkgVersion}_x64-setup.exe"

if (-not (Test-Path -LiteralPath $installer)) {
    Die "no installer at $installer (bundle exit=$bundleExit)"
}
$size = [math]::Round((Get-Item $installer).Length / 1MB, 1)
Ok "installer built: $size MB"

if ($bundleExit -ne 0) {
    Write-Host "  [note] bundle exited $bundleExit AFTER producing the installer." -ForegroundColor Yellow
    Write-Host "         Expected locally when no signing key is set (updater .sig step)." -ForegroundColor Yellow
}

# ── Stage artifact ──────────────────────────────────────────────────────────

if (-not $KeepArtifactWhereItIs) {
    Step 'Copy to dist-installer'
    $distDir = Join-Path $repo 'dist-installer'
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    $dest = Join-Path $distDir (Split-Path -Leaf $installer)
    Copy-Item -LiteralPath $installer -Destination $dest -Force
    # Byte-count check, not just Test-Path: a truncated copy still "exists".
    $srcLen = (Get-Item -LiteralPath $installer).Length
    $dstLen = (Get-Item -LiteralPath $dest).Length
    if ($srcLen -ne $dstLen) { Die "copy size mismatch: src=$srcLen dst=$dstLen" }
    Ok "$dest ($srcLen bytes, verified)"
}

Write-Host "`nDONE -- codeg $pkgVersion installer ready." -ForegroundColor Green
Write-Host "Local builds carry no updater signature; publish via CI (tag -> release.yml)." -ForegroundColor Gray
