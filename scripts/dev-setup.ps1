[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function Ensure-Line {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [string] $Line
  )

  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType File -Path $Path -Force | Out-Null
  }

  $existing = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($existing -notcontains $Line) {
    Add-Content -LiteralPath $Path -Value "`r`n$Line"
  }
}

function Refresh-PathFromEnvironment {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($machinePath, $userPath) | Where-Object { $_ }
  if ($parts.Count -gt 0) {
    $env:Path = ($parts -join ';')
  }
}

function Get-MiseCommand {
  $command = Get-Command mise -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  Refresh-PathFromEnvironment

  $command = Get-Command mise -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidatePaths = @(
    (Join-Path $HOME 'scoop\shims\mise.ps1'),
    (Join-Path $HOME 'scoop\shims\mise.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\mise\mise.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  if ($candidatePaths.Count -gt 0) {
    return $candidatePaths[0]
  }

  return $null
}

$shouldConfigureShell = $false
$miseCommand = Get-MiseCommand

if (-not $miseCommand) {
  $shouldConfigureShell = $true

  if (Get-Command scoop -ErrorAction SilentlyContinue) {
    Write-Host 'Installing mise with Scoop'
    scoop install mise
  }
  elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing mise with winget'
    winget install --id jdx.mise --exact --accept-package-agreements --accept-source-agreements
  }
  else {
    throw 'Neither Scoop nor winget is available. Install one of them first, then re-run this script.'
  }

  $miseCommand = Get-MiseCommand
}

if (-not $miseCommand) {
  throw 'Unable to locate mise after installation.'
}

if ($shouldConfigureShell) {
  $profileLine = "& '$miseCommand' activate pwsh | Out-String | Invoke-Expression"
  Ensure-Line -Path $PROFILE -Line $profileLine
}

Write-Host "Using mise command: $miseCommand"
Write-Host "Installing tools from $RepoRoot\mise.toml"
& $miseCommand install -C $RepoRoot -y

Write-Host 'Installing prek git hooks'
& $miseCommand exec -C $RepoRoot -y -- `
  prek install --prepare-hooks --hook-type pre-commit --hook-type commit-msg

Write-Host 'Setup complete.'
