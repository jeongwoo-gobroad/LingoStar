$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "server.js" -WorkingDirectory "D:\SynologyDrive\_Main Archive\_Productivity Workflow\LingoStar"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
Register-ScheduledTask -TaskName "LingoStarDaemon" -Action $action -Trigger $trigger -User "SYSTEM" -Force
Start-ScheduledTask -TaskName "LingoStarDaemon"
