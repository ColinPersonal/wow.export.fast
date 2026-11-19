# Keeps the wow-export gateway running: starts it and restarts it if it exits.
# Started at logon by install.ps1. Console output goes to ~/wow.export-service/logs/gateway-stdout.log
# (the gateway writes its own logs/gateway.log).
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
	# cmd.exe does the redirect so the log stays plain UTF-8; PowerShell 5.1's *>> writes
	# UTF-16 and wraps every stderr line in an error record.
	& cmd.exe /d /c "`"$Node`" `"$(Join-Path $Here 'cli.js')`" start >> `"$(Join-Path $Logs 'gateway-stdout.log')`" 2>&1"
	$code = $LASTEXITCODE
	Add-Content -Path (Join-Path $Logs 'runner.log') -Value "$(Get-Date -Format o) gateway exited with code $code"

	# Back off if it keeps failing quickly; reset after a good run.
	if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 2 } else { $delay = [Math]::Min($delay * 2, 300) }
	Start-Sleep -Seconds $delay
}
