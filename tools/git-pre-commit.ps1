# Universal pre-commit gate (installed 2026-07-28).
# Dot-sources the shared rule library so every repo shares ONE source of rules:
#   ~/.agents/hooks/common.ps1  (Test-* functions + Write-Findings + Invoke-AiChecklist)
# Repo-specific extras go in the marked section below.
#
# Escape hatches:
#   GATE_SKIP=1       skip everything (emergency)
#   GATE_SKIP_LANG=1  skip cargo fmt / ruff
#   GATE_SKIP_AI=1    skip the AI self-check print

$ErrorActionPreference = 'Stop'

# --- shared library (fail-open: missing lib must not brick commits) ---
$Common = Join-Path $HOME '.agents\hooks\common.ps1'
if (-not (Test-Path -LiteralPath $Common)) {
    Write-Warning "[hook] shared common.ps1 not found at $Common; skipping gate"
    exit 0
}
. $Common

if ($env:GATE_SKIP -eq '1') {
    Write-Host '[gate] SKIPPED via GATE_SKIP=1' -ForegroundColor Yellow
    exit 0
}

$Repo = Init-GateRepo
$Staged = Get-StagedFiles
if ($Staged.Count -eq 0) { Write-Host 'No staged files.'; exit 0 }

$Baseline = Load-Baseline (Join-Path $Repo '.githooks/anti-pattern-baseline.json')

# --- repo-specific blocked-file extras (add entries here when needed) ---
$ExtraBlocked = @()

# --- universal structural gates ---
$F = @()
$F += Test-BlockedFiles  -Staged $Staged -Extra $ExtraBlocked
$F += Test-BigFile       -Staged $Staged -Repo $Repo -Baseline $Baseline -Warn
$F += Test-SilentSwallow -Staged $Staged -Warn
$F += Test-AdrIndex      -Staged $Staged -Repo $Repo
$F += Test-TaskLedger    -Staged $Staged -Repo $Repo
# stub audit (common.ps1 v1.3.0): a newly ADDED todo!() / unimplemented!() /
# raise NotImplementedError is code that cannot run in production -> BLOCKING.
# Escape hatch: append `gate:allow-stub` on the same line with the reason.
$F += Test-StubAudit    -Staged $Staged
# wiring gate (common.ps1 v1.4.0): a new public symbol with no PRODUCTION
# caller is dead code. BLOCKING, and deliberately placed BEFORE the commit:
# arXiv 2605.01771 measured 0% compliance for process instructions the model
# can bypass, and 75% once the affordance is removed by a deterministic check
# in front of the finish-line command. The post-commit version of this check
# had 31 commits of opportunity and changed nothing.
# codegraph indexes the DISK, so `sync` sees the call site staged in this very
# change -- no false positive from 'the caller is not committed yet'.
# Escape hatch: `gate:allow-unwired <reason>` on the definition line.
$F += Test-SymbolWired   -Repo $Repo

Write-Findings -Findings $F   # exits 1 on any blocking finding

# --- language checks (auto-triggered by staged file types) ---
if ($env:GATE_SKIP_LANG -ne '1') {
    $rust = @($Staged | Where-Object { $_ -match '\.rs$' -or $_ -match '(^|/)Cargo\.(toml|lock)$' })
    if ($rust.Count -gt 0 -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
        # The Cargo workspace is NOT at the repo root here (it lives in
        # src-tauri/), and `cargo fmt` resolves the manifest from the CWD. Run
        # it from the manifest directory or cargo rejects the arguments and this
        # gate reports a bogus failure on every Rust commit instead of checking
        # formatting at all.
        $manifestDir = @('src-tauri', '.') |
            Where-Object { Test-Path (Join-Path $_ 'Cargo.toml') } |
            Select-Object -First 1
        if ($manifestDir) {
            # Check the STAGED files only. The intent one line up is already
            # "auto-triggered by staged file types"; `cargo fmt --all --check` broke
            # that by judging all ~98 workspace files, of which 629 hunks are
            # pre-existing unformatted code nobody in this commit touched. That made
            # the gate unpassable on every Rust commit — and an unpassable gate does
            # not enforce formatting, it just trains everyone to reach for
            # GATE_SKIP=1, which disables the REAL findings above too.
            #
            # `rustfmt` is invoked DIRECTLY rather than through `cargo fmt -- <paths>`:
            # cargo forwards the paths but rustfmt still expands from the crate root,
            # so the scoped form silently checks the whole workspace anyway (verified
            # — it printed all 98 files). Direct rustfmt honors the path list.
            # Edition must be passed explicitly since we bypass cargo's manifest read;
            # it matches the `2021` edition this crate declares.
            $rustFiles = @($rust | Where-Object { $_ -match '\.rs$' -and (Test-Path $_) })
            if ($rustFiles.Count -gt 0 -and (Get-Command rustfmt -ErrorAction SilentlyContinue)) {
                Write-Host "==> rustfmt --check (staged .rs: $($rustFiles.Count) file(s))"
                rustfmt --edition 2021 --check @rustFiles
                if ($LASTEXITCODE -ne 0) {
                    Write-Host 'rustfmt failed on a file you staged; run `rustfmt --edition 2021` on it and re-stage.' -ForegroundColor Red
                    exit 1
                }
            }
        }
    }
    $py = @($Staged | Where-Object { $_ -match '\.py$' })
    if ($py.Count -gt 0 -and (Get-Command ruff -ErrorAction SilentlyContinue)) {
        Write-Host '==> ruff check (staged .py)'
        ruff check @($py | Where-Object { Test-Path $_ })
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ruff failed; fix and re-stage.' -ForegroundColor Red
            exit 1
        }
    }
}

# --- AI self-check reminder (non-blocking) ---
if ($env:GATE_SKIP_AI -ne '1') { Invoke-AiChecklist -Repo $Repo }

Write-Host 'pre-commit gate passed.' -ForegroundColor Green
exit 0
