#Requires -Version 5.1
# Kakashi installer for Windows PowerShell 5.1+ and PowerShell 7.
#
#   irm https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.ps1 | iex
#
# With options (a piped script cannot take any):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muhammadatef/kakashi/main/install.ps1))) --dry-run
#   & ([scriptblock]::Create((irm .../install.ps1))) --only cursor
#   & ([scriptblock]::Create((irm .../install.ps1))) --uninstall
#
# It installs the npm package globally, then runs its agent installer
# (bin/install.js, also `kakashi install`). An unknown option stops here,
# before anything is installed.
#
# Under `iex` this runs in the caller's own session, so it never calls `exit`
# (that would close the window) and keeps its settings inside a function.
# Native commands' output goes to Out-Host: anything left in the function's
# output would become part of its return value.
# $MyInvocation.MyCommand.Path is empty there too; the installer is found in
# the global npm folder instead (#45).
#
# KAKASHI_PACKAGE chooses what npm installs (a version or a tarball path);
# CI uses it to test the package being built.

function Install-Kakashi {
    param([string[]]$Arguments, [string]$ScriptRoot)

    $ErrorActionPreference = 'Stop'
    $package = if ($env:KAKASHI_PACKAGE) { $env:KAKASHI_PACKAGE } else { '@muhammadatef/kakashi' }
    $packageName = '@muhammadatef/kakashi'
    $minNode = 18

    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js and npm are required (Node >= $minNode). Install from https://nodejs.org/" -ForegroundColor Red
        return 1
    }
    $major = [int](node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if ($major -lt $minNode) {
        Write-Host "Node.js >= $minNode required (found $(node -v))" -ForegroundColor Red
        return 1
    }

    # Check the options before touching anything.
    $valueFlags = @('--only', '--config-dir')
    $plainFlags = @('--all', '--with-init', '--minimal', '--list', '--force', '--non-interactive', '--help', '-h', '--dry-run', '--uninstall')
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $a = $Arguments[$i]
        if ($valueFlags -contains $a) {
            $i++
            if ($i -ge $Arguments.Count) { Write-Host "$a needs a value" -ForegroundColor Red; return 2 }
        } elseif ($plainFlags -notcontains $a) {
            Write-Host "Unknown option: $a (see: --help)" -ForegroundColor Red
            return 2
        }
    }
    $dryRun = $Arguments -contains '--dry-run'
    $uninstall = $Arguments -contains '--uninstall'

    Write-Host 'Kakashi Installer' -ForegroundColor Cyan
    Write-Host ''

    # 1. A clone: run its installer.
    if ($ScriptRoot -and (Test-Path (Join-Path $ScriptRoot 'bin\install.js'))) {
        node (Join-Path $ScriptRoot 'bin\install.js') @Arguments | Out-Host
        return $LASTEXITCODE
    }

    $globalInstaller = Join-Path (npm root -g) "$packageName\bin\install.js"

    # 2. --dry-run and --uninstall: nothing is installed.
    if ($dryRun -or $uninstall) {
        if (Test-Path $globalInstaller) {
            node $globalInstaller @Arguments | Out-Host
            $rc = $LASTEXITCODE
        } else {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kakashi-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $tmp | Out-Null
            try {
                npm pack $package --pack-destination $tmp --silent | Out-Null
                if ($LASTEXITCODE -ne 0) { Write-Host "Could not download $package to run the installer." -ForegroundColor Red; return 1 }
                $tgz = Get-ChildItem $tmp -Filter *.tgz | Select-Object -First 1
                tar -xzf $tgz.FullName -C $tmp | Out-Null
                node (Join-Path $tmp 'package\bin\install.js') @Arguments | Out-Host
                $rc = $LASTEXITCODE
            } finally {
                Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
            }
        }
        if ($uninstall -and -not $dryRun) { Write-Host "To remove the package too: npm uninstall -g $packageName" }
        return $rc
    }

    # 3. Install the package, then the agent rules. try/catch does not see a
    # native command's failure, so its exit code is checked instead.
    npm install -g $package --no-audit --no-fund | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install -g $package failed." -ForegroundColor Red
        return 1
    }
    Write-Host "Installed $packageName" -ForegroundColor Green
    if (-not (Test-Path $globalInstaller)) {
        Write-Host "The package installed, but its installer was not found at $globalInstaller." -ForegroundColor Red
        return 1
    }
    node $globalInstaller @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    Write-Host 'Installation complete. Try: kakashi scan <file>' -ForegroundColor Green
    return 0
}

$kakashiExit = Install-Kakashi -Arguments @($args) -ScriptRoot $PSScriptRoot
$global:LASTEXITCODE = $kakashiExit
# Run as a script file (powershell -File install.ps1), report the exit code.
if ($MyInvocation.InvocationName -and $MyInvocation.MyCommand.Path) { exit $kakashiExit }
