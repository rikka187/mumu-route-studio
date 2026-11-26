$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Host 'No background service recorded.'; exit 0 }
$taskServerPid = [int](Get-Content -LiteralPath $taskPidFile)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerPid"
$taskExpectedScript = Join-Path $PSScriptRoot 'server.js'
if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine.Contains($taskExpectedScript)) {
    try {
        $taskState = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/state' -TimeoutSec 2
        if ($taskState.app -eq 'mumu-route-studio') {
            Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8765/api/run/stop' -Headers @{'X-Local-Token'=$taskState.token} -ContentType 'application/json' -Body '{}' | Out-Null
        }
    } catch { Write-Warning 'Could not gracefully stop the active route.' }
    Stop-Process -Id $taskServerPid
    Write-Host 'MuMu Route Studio stopped.'
}
Remove-Item -LiteralPath $taskPidFile -Force
