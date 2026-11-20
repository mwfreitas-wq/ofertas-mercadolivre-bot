# agendar_windows.ps1
# Cria uma tarefa automatica no Agendador de Tarefas do Windows
# para rodar o Radar de Ofertas 3x ao dia: 08:00, 13:00 e 18:00.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptDir "rodar_ofertas.bat"
$taskName = "RadarOfertas_ML_Shopee"

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`"" -WorkingDirectory $scriptDir

$triggers = @(
    New-ScheduledTaskTrigger -Daily -At 08:00
    New-ScheduledTaskTrigger -Daily -At 13:00
    New-ScheduledTaskTrigger -Daily -At 18:00
)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Description "Coleta ofertas mais vendidas do Mercado Livre e Shopee + cupons verificados 3x ao dia." -Force

Write-Host ""
Write-Host "Tarefa '$taskName' agendada com sucesso para 08:00, 13:00 e 18:00!" -ForegroundColor Green
Write-Host "Voce pode conferir ou rodar manualmente no Agendador de Tarefas do Windows."
