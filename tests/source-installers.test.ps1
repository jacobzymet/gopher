$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testDir = Join-Path $tempRoot ('gopher-installer-test-' + [guid]::NewGuid().ToString('N'))
$tools = Join-Path $testDir 'tools'
$installDir = Join-Path $testDir 'installed'
New-Item -ItemType Directory -Path $tools,$installDir | Out-Null
$commit = '0123456789abcdef0123456789abcdef01234567'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
$oldCommit = $env:GOPHER_BUILD_COMMIT
$oldPath = $env:Path
$oldCargoHome = $env:CARGO_HOME
$env:GOPHER_BUILD_COMMIT = 'preserve-this-environment-value'
$global:GopherInstallerTestApiCalls = 0
function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'cargo' -and $env:MOCK_NO_CARGO -ne '1') { return [pscustomobject]@{ Source = (Join-Path $tools 'cargo.exe') } }
    return $null
}
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    if ($Uri -ne 'https://api.github.com/repos/jacobzymet/gopher/commits/master') { throw 'Unexpected source endpoint.' }
    $global:GopherInstallerTestApiCalls++
    return @{ sha = $(if ($env:MOCK_BAD_SHA -eq '1') { 'v1.0.0' } else { '0123456789abcdef0123456789abcdef01234567' }) }
}
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
try {
    $fakeCargo = Join-Path $tools 'cargo.exe'
    $sourceFile = Join-Path $testDir 'FakeBuildTool.cs'
    [IO.File]::WriteAllText($sourceFile, @'
using System;
using System.IO;
using System.Diagnostics;
class FakeBuildTool {
    static int Main(string[] args) {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string name = Path.GetFileName(self);
        if (name == "rustc.exe") { Console.WriteLine("host: x86_64-pc-windows-msvc"); return 0; }
        if (name == "gopher.exe") {
            Console.WriteLine("gopher master@0123456789ab");
            Console.WriteLine("Commit: " + (Environment.GetEnvironmentVariable("MOCK_BAD_ID") == "1" ? new string('f', 40) : Environment.GetEnvironmentVariable("GOPHER_BUILD_COMMIT")));
            return 0;
        }
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("cargo test"); return 0; }
        File.WriteAllLines(Environment.GetEnvironmentVariable("MOCK_CALLS"), args);
        if (Environment.GetEnvironmentVariable("MOCK_FAIL_BUILD") == "1") { return 9; }
        string root = args[Array.IndexOf(args, "--root") + 1];
        Directory.CreateDirectory(Path.Combine(root, "bin"));
        File.Copy(self, Path.Combine(root, "bin", "gopher.exe"));
        return 0;
    }
}
'@)
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe "/out:$fakeCargo" $sourceFile
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile installer test tools.' }
    Copy-Item -LiteralPath $fakeCargo -Destination (Join-Path $tools 'rustc.exe')
    $env:MOCK_CALLS = Join-Path $testDir 'calls.txt'
    $dest = Join-Path $installDir 'gopher.exe'
    [IO.File]::WriteAllText($dest, 'existing app')
    & $installer --dir $installDir --no-path
    $built = [IO.File]::ReadAllBytes($dest)
    Assert-True ($built.Length -gt 1000) 'Installer did not replace the app with the local build.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $installDir 'gopher.exe.old')) -eq 'existing app') 'Installer did not retain the previous app.'
    $calls = [IO.File]::ReadAllLines($env:MOCK_CALLS)
    Assert-True ($calls -contains '--locked' -and $calls -contains '--git' -and $calls -contains $commit) 'Installer did not pin and lock the source build.'
    Assert-True ($env:GOPHER_BUILD_COMMIT -eq 'preserve-this-environment-value' -and $env:Path -eq $oldPath) 'Installer did not restore build environment.'
    foreach ($mode in @('buildFailure', 'wrongIdentity', 'invalidCommit', 'missingRust')) {
        $env:MOCK_FAIL_BUILD = $(if ($mode -eq 'buildFailure') { '1' } else { '0' })
        $env:MOCK_BAD_ID = $(if ($mode -eq 'wrongIdentity') { '1' } else { '0' })
        $env:MOCK_BAD_SHA = $(if ($mode -eq 'invalidCommit') { '1' } else { '0' })
        $env:MOCK_NO_CARGO = $(if ($mode -eq 'missingRust') { '1' } else { '0' })
        $env:CARGO_HOME = Join-Path $testDir 'missing-cargo'
        $beforeCalls = $global:GopherInstallerTestApiCalls
        $failure = $null
        try { & $installer --dir $installDir --no-path } catch { $failure = $_.Exception.Message }
        Assert-True ([bool]$failure) "Installer should fail on $mode."
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($dest)) -eq [Convert]::ToBase64String($built)) "Installer replaced the app on $mode."
        Assert-True ($env:GOPHER_BUILD_COMMIT -eq 'preserve-this-environment-value' -and $env:Path -eq $oldPath) "Installer did not restore environment on $mode."
        if ($mode -eq 'missingRust') { Assert-True ($beforeCalls -eq $global:GopherInstallerTestApiCalls) 'Missing Rust should fail before network access.' }
        Write-Host "Passed: $mode"
    }
    Write-Host 'Windows source installer regression tests passed.'
} finally {
    $env:GOPHER_BUILD_COMMIT = $oldCommit
    $env:Path = $oldPath
    $env:CARGO_HOME = $oldCargoHome
    Remove-Item Env:MOCK_CALLS,Env:MOCK_FAIL_BUILD,Env:MOCK_BAD_ID,Env:MOCK_BAD_SHA,Env:MOCK_NO_CARGO -ErrorAction SilentlyContinue
    Remove-Variable GopherInstallerTestApiCalls -Scope Global -ErrorAction SilentlyContinue
    $resolved = [IO.Path]::GetFullPath($testDir)
    if ($resolved.StartsWith($tempRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolved) -match '^gopher-installer-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
