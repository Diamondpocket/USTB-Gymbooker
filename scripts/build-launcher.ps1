Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "launcher\GymBookerLauncher.cs"
$outputDir = Join-Path $root "dist"
$output = Join-Path $outputDir "GymBooker.exe"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}

if (-not (Test-Path $compiler)) {
  throw "Could not find csc.exe."
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

& $compiler `
  /target:winexe `
  /nologo `
  /out:$output `
  /r:System.dll `
  /r:System.Core.dll `
  /r:System.Windows.Forms.dll `
  $source

if (-not (Test-Path $output)) {
  throw "Build failed. Missing output: $output"
}

Write-Output "Launcher built: $output"
