# Registers the wow-export gateway to start when you log on, and keeps it running.
#
#   powershell -ExecutionPolicy Bypass -File service\install.ps1            install / update
#   powershell -ExecutionPolicy Bypass -File service\install.ps1 -Remove    uninstall
#
# It runs as you, at logon (NW.js/WebGL engines need your desktop session), with no
# admin rights. If Windows refuses to register a scheduled task, a shortcut in your
# Startup folder is used instead. service\run-gateway.ps1 restarts the gateway if it
# ever exits.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'wow-export-service'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $Here 'run-gateway.ps1'
$Startup = [Environment]::GetFolderPath('Startup')
$Shortcut = Join-Path $Startup 'wow-export-service.lnk'
$PowerShell = (Get-Command powershell.exe).Source
$Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`""

if ($Remove) {
	Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
	Remove-Item $Shortcut -ErrorAction SilentlyContinue
	Write-Output 'Removed the wow-export-service start-up entry. A running gateway keeps running until you stop it or log off.'
	return
}

try {
	$action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $Here
	$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
	$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
	$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
	Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
	Remove-Item $Shortcut -ErrorAction SilentlyContinue
	Write-Output "Registered scheduled task '$TaskName' (runs at logon)."
} catch {
	Write-Output "Scheduled task not available ($($_.Exception.Message)); using a Startup folder shortcut."
	$shell = New-Object -ComObject WScript.Shell
	$link = $shell.CreateShortcut($Shortcut)
	$link.TargetPath = $PowerShell
	$link.Arguments = $Arguments
	$link.WorkingDirectory = $Here
	$link.WindowStyle = 7
	$link.Save()
	Write-Output "Created $Shortcut"
}
