# Keeps the wow-export gateway running: starts it and restarts it if it exits.
# Started at logon by install.ps1. Output goes to ~/wow.export-service/logs.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = if ($env:WOW_EXPORT_SERVICE_ROOT) { $env:WOW_EXPORT_SERVICE_ROOT } else { Join-Path $env:USERPROFILE 'wow.export-service' }
$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

$delay = 2
while ($true) {
	$started = Get-Date
	Add-Content -Path (Join-Path $Logs 'runner.log') -Value "$(Get-Date -Format o) starting gateway"
	& $Node (Join-Path $Here 'cli.js') start *>> (Join-Path $Logs 'gateway-console.log')
	$code = $LASTEXITCODE
	Add-Content -Path (Join-Path $Logs 'runner.log') -Value "$(Get-Date -Format o) gateway exited with code $code"

	# Back off if it keeps failing quickly; reset after a good run.
	if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 2 } else { $delay = [Math]::Min($delay * 2, 300) }
	Start-Sleep -Seconds $delay
}
