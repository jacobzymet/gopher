# Build the current master commit locally. Requires Rust MSVC and Visual Studio C++ Build Tools.
& {
    $ErrorActionPreference = 'Stop'
    $installDir = $env:GOPHER_INSTALL_DIR
    if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'gopher\bin' }
    $noPath = $false
    for ($i = 0; $i -lt $args.Count; $i++) {
        switch ($args[$i]) {
            '--dir' {
                $i++
                if ($i -ge $args.Count -or -not $args[$i]) { throw '--dir requires a directory.' }
                $installDir = $args[$i]
            }
            '--no-path' { $noPath = $true }
            '--help' { Write-Host 'Usage: .\install.ps1 [--dir DIRECTORY] [--no-path]'; Write-Host 'Builds master locally; requires Rust MSVC, Visual Studio C++ Build Tools and the Windows SDK.'; return }
            default { throw "Unknown option: $($args[$i])" }
        }
    }
    $cargoCommand = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue
    $cargo = if ($cargoCommand) { $cargoCommand.Source } else {
        $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
        Join-Path $cargoHome 'bin\cargo.exe'
    }
    if (-not (Test-Path -LiteralPath $cargo)) { throw 'Install Rust with Cargo from https://rustup.rs, then retry. Choose the MSVC toolchain.' }
    & $cargo --version
    if ($LASTEXITCODE -ne 0) { throw 'Install a working Rust toolchain with rustup, then retry.' }
    $rustc = Join-Path (Split-Path -Parent $cargo) 'rustc.exe'
    if (-not (Test-Path -LiteralPath $rustc)) {
        $rustCommand = Get-Command rustc -CommandType Application -ErrorAction SilentlyContinue
        if (-not $rustCommand) { throw 'Rust compiler missing. Install Rust from https://rustup.rs.' }
        $rustc = $rustCommand.Source
    }
    $rustInfo = & $rustc -vV
    if ($LASTEXITCODE -ne 0) { throw 'Install a working Rust toolchain with rustup, then retry.' }
    $target = ($rustInfo | Where-Object { $_ -match '^host: ' }) -replace '^host: ', ''
    if (-not $target -or $target -notlike '*-windows-msvc') { throw 'Gopher requires a Rust MSVC toolchain on Windows. Install it with rustup.' }
    Write-Host 'Building requires Visual Studio Build Tools with Desktop development with C++ and the Windows SDK.'
    $headers = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'gopher-source-installer' }
    $master = Invoke-RestMethod -Uri 'https://api.github.com/repos/jacobzymet/gopher/commits/master' -Headers $headers -TimeoutSec 60
    $commit = [string]$master.sha
    if ($commit -notmatch '^[0-9a-fA-F]{40}$') { throw 'GitHub did not return a valid master commit.' }
    $commit = $commit.ToLowerInvariant()
    $installDir = [IO.Path]::GetFullPath($installDir)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $workDir = Join-Path $tempRoot ('gopher-build-' + [guid]::NewGuid().ToString('N'))
    $stagingRoot = Join-Path $workDir 'install'
    $cache = Join-Path $env:LOCALAPPDATA "gopher\cache\update-build\$target"
    $oldCommit = $env:GOPHER_BUILD_COMMIT
    $oldPath = $env:Path
    New-Item -ItemType Directory -Path $workDir | Out-Null
    try {
        $env:GOPHER_BUILD_COMMIT = $commit
        $env:Path = "$(Split-Path -Parent $cargo);$oldPath"
        Write-Host "Building Gopher master@$($commit.Substring(0, 12)) locally. The first build may take several minutes."
        Push-Location -LiteralPath $workDir
        try {
            & $cargo install --git https://github.com/jacobzymet/gopher --rev $commit --locked --force --bin gopher --target $target --root $stagingRoot --target-dir $cache
            if ($LASTEXITCODE -ne 0) { throw 'Build failed. Check Rust, Visual Studio C++ Build Tools and the Windows SDK, then retry. Your installed app was not replaced.' }
        } finally { Pop-Location }
        $binary = Join-Path $stagingRoot 'bin\gopher.exe'
        $identity = & $binary --version
        if ($LASTEXITCODE -ne 0 -or -not ($identity -contains "Commit: $commit")) { throw 'The built app does not identify the requested master commit.' }
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        $dest = Join-Path $installDir 'gopher.exe'
        $staged = Join-Path $installDir ('gopher-' + [guid]::NewGuid().ToString('N') + '.new')
        $backup = Join-Path $installDir 'gopher.exe.old'
        try {
            Copy-Item -LiteralPath $binary -Destination $staged
            if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
            if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination $backup }
            try { Move-Item -LiteralPath $staged -Destination $dest } catch {
                if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $dest }
                throw
            }
        } finally {
            if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
        }
        Write-Host "Installed Gopher master@$($commit.Substring(0, 12)) to $dest"
    } finally {
        $env:GOPHER_BUILD_COMMIT = $oldCommit
        $env:Path = $oldPath
        # Verify the generated temporary directory before recursive cleanup.
        $resolvedWork = [IO.Path]::GetFullPath($workDir)
        $tempPrefix = $tempRoot.TrimEnd('\') + '\'
        if ($resolvedWork.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedWork) -match '^gopher-build-[0-9a-f]{32}$') {
            if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
        }
    }
    if (-not $noPath) {
        $normalized = $installDir.TrimEnd('\')
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($userPath -split ';' | ForEach-Object { $_.TrimEnd('\') })
        if ($parts -notcontains $normalized) {
            $newPath = (@($userPath, $normalized) | Where-Object { $_ }) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        }
        if (($env:Path -split ';') -notcontains $normalized) { $env:Path = "$normalized;$env:Path" }
    }
    Write-Host 'Launch with: gopher. Check master and build future updates in Settings → App.'
    Write-Host 'The desktop window requires Microsoft Edge WebView2: https://developer.microsoft.com/microsoft-edge/webview2/'
} @args
