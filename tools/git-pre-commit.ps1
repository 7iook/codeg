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
    # --- Rust formatting gate: judges the STAGED BLOB, never the working tree ---
    # A pre-commit gate's authoritative input is the index, because that is the
    # content about to enter history. Deriving the file LIST from the index but
    # then letting rustfmt READ THE DISK compares the wrong bytes: stage a
    # misformatted file, tidy it on disk without re-staging, and the gate greens
    # while the bad blob commits (reproduced 2026-07-31, HOOK_EXIT=0).
    #
    # The blob is fed to rustfmt over STDIN rather than materialized into a temp
    # directory: rustfmt resolves `mod foo;` against the file's own directory and
    # exits 1 when the sibling file is absent -- indistinguishable from a real
    # formatting failure (verified: materializing `pub mod proxy;` alone under a
    # temp prefix failed with "failed to resolve mod `proxy`"). Over stdin there
    # is no directory to resolve against.
    #
    # `--check` is deliberately NOT used: on stdin it prints the diff and STILL
    # EXITS 0 (verified), so its exit code cannot carry the verdict. `--emit
    # stdout` plus an exact byte comparison makes rustfmt's own output the
    # oracle, which is self-evident and cannot silently invert.
    $rustFiles = @($Staged | Where-Object { $_ -match '\.rs$' })
    if ($rustFiles.Count -gt 0) {
        # A gate that quietly turns itself off on machines missing the tool is
        # not a gate -- it makes formatting optional as a function of who commits.
        if (-not (Get-Command rustfmt -ErrorAction SilentlyContinue)) {
            Write-Host "rustfmt not found, but $($rustFiles.Count) staged .rs file(s) require checking." -ForegroundColor Red
            Write-Host 'Install it, then retry:  rustup component add rustfmt' -ForegroundColor Red
            exit 1
        }

        # Edition comes from each file's NEAREST Cargo.toml. A hardcoded 2021
        # mis-parses the edition-2024 crate vendored at src-tauri/vendor/sacp-tokio
        # (verified: `fn gen() {}` exits 0 under --edition 2021 and 1 under 2024,
        # `gen` being a 2024 reserved word), which would surface as a bogus syntax
        # error instead of a formatting verdict.
        $editionCache = @{}
        function Resolve-RustEdition {
            param([string]$RelPath, [hashtable]$Cache)
            $dir = Split-Path -Parent $RelPath
            while ($true) {
                $key = if ($dir) { $dir } else { '.' }
                if ($Cache.ContainsKey($key)) { return $Cache[$key] }
                $manifest = if ($dir) { Join-Path $dir 'Cargo.toml' } else { 'Cargo.toml' }
                if (Test-Path -LiteralPath $manifest) {
                    $hit = Select-String -Path $manifest -Pattern '^\s*edition\s*=\s*"([0-9]{4})"' |
                        Select-Object -First 1
                    if ($hit) {
                        $ed = $hit.Matches[0].Groups[1].Value
                        $Cache[$key] = $ed
                        return $ed
                    }
                }
                if (-not $dir) { break }
                $dir = Split-Path -Parent $dir
            }
            return '2021'
        }

        # Byte-exact child-process runner. `Start-Process -ArgumentList` is NOT
        # usable here: it joins the array with spaces and does no quoting, so a
        # staged path containing a space (`:probe space file.rs`) arrives as three
        # separate arguments and the index read fails (observed as a bogus
        # [index-read-failed]). ProcessStartInfo.ArgumentList escapes each element
        # individually. Streams are handled as raw bytes because the bytes are
        # exactly what is being compared -- a PowerShell pipeline would re-encode
        # them and silently normalize the newlines that matter.
        function Invoke-Bytes {
            param([string]$Exe, [string[]]$Arguments, [byte[]]$StdinBytes)
            $psi = [System.Diagnostics.ProcessStartInfo]::new()
            $psi.FileName = $Exe
            foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.UseShellExecute = $false
            $proc = [System.Diagnostics.Process]::Start($psi)
            $buf = [System.IO.MemoryStream]::new()
            # Drain stdout concurrently with the stdin write, or a payload larger
            # than the pipe buffer deadlocks both sides.
            $pump = $proc.StandardOutput.BaseStream.CopyToAsync($buf)
            $errTask = $proc.StandardError.ReadToEndAsync()
            if ($StdinBytes -and $StdinBytes.Length -gt 0) {
                $proc.StandardInput.BaseStream.Write($StdinBytes, 0, $StdinBytes.Length)
            }
            $proc.StandardInput.BaseStream.Flush()
            $proc.StandardInput.Close()
            $pump.Wait()
            $proc.WaitForExit()
            return @{
                Code = $proc.ExitCode
                Out  = $buf.ToArray()
                Err  = $errTask.Result
            }
        }

        Write-Host "==> rustfmt on staged blobs ($($rustFiles.Count) .rs file(s))"
        $badFmt = @()
        foreach ($rel in $rustFiles) {
            $edition = Resolve-RustEdition -RelPath $rel -Cache $editionCache
            # `:<path>` reads the INDEX copy. A staged file deleted from disk still
            # has a blob here, which is correct: the blob is what commits.
            $blob = Invoke-Bytes -Exe 'git' -Arguments @('cat-file', 'blob', ":$rel")
            if ($blob.Code -ne 0) {
                Write-Host "  [index-read-failed] $rel" -ForegroundColor Red
                if ($blob.Err.Trim()) { Write-Host "      $($blob.Err.Trim())" -ForegroundColor Red }
                $badFmt += $rel
                continue
            }
            $fmt = Invoke-Bytes -Exe 'rustfmt' `
                -Arguments @('--edition', $edition, '--emit', 'stdout') `
                -StdinBytes $blob.Out
            if ($fmt.Code -ne 0) {
                Write-Host "  [parse-error] $rel (edition $edition)" -ForegroundColor Red
                ($fmt.Err -split "`r?`n") | Select-Object -First 3 |
                    ForEach-Object { if ($_.Trim()) { Write-Host "      $_" -ForegroundColor Red } }
                $badFmt += $rel
                continue
            }
            $inBytes = $blob.Out
            $outBytes = $fmt.Out
            $same = ($inBytes.Length -eq $outBytes.Length)
            if ($same) {
                for ($i = 0; $i -lt $inBytes.Length; $i++) {
                    if ($inBytes[$i] -ne $outBytes[$i]) { $same = $false; break }
                }
            }
            if (-not $same) {
                Write-Host "  [unformatted-in-index] $rel (edition $edition)" -ForegroundColor Red
                $badFmt += $rel
            }
        }

        # Non-blocking on purpose: a disk copy that differs from the index is not
        # the content being committed, so it cannot fail this gate (that would
        # reject commits over changes deliberately left unstaged, e.g. `git add -p`).
        # It does mislead the NEXT commit, so it is reported.
        $drift = @(git diff --name-only -- $rustFiles)
        if ($drift.Count -gt 0) {
            Write-Host "  note: staged content differs from the working tree in $($drift.Count) file(s);" -ForegroundColor Yellow
            Write-Host '        this gate judged the STAGED bytes. Unstaged edits are not committed.' -ForegroundColor Yellow
        }

        if ($badFmt.Count -gt 0) {
            Write-Host ''
            Write-Host 'rustfmt: the STAGED content of the file(s) above is not formatted.' -ForegroundColor Red
            Write-Host 'Formatting the file on disk is not enough -- you must re-stage it:' -ForegroundColor Red
            foreach ($b in $badFmt) {
                $ed = Resolve-RustEdition -RelPath $b -Cache $editionCache
                Write-Host ('    rustfmt --edition ' + $ed + ' "' + $b + '" ; git add "' + $b + '"') -ForegroundColor Red
            }
            exit 1
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
