# Install the TypeScript app from a verified, pinned source checkout.
& {
    $ErrorActionPreference = 'Stop'
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $bootstrapDir = Join-Path ([IO.Path]::GetTempPath()) ('gopher-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $bootstrapDir | Out-Null
    $bootstrap = Join-Path $bootstrapDir 'install.ts'
    try {
        Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/jacobzymet/gopher/master/scripts/install.ts' -OutFile $bootstrap
        & $node $bootstrap @args
        if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Your previous app is still available.' }
    } finally { Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $bootstrapDir -ErrorAction SilentlyContinue }
} @args
