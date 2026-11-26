param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:8765'
try {
    $taskState = Invoke-RestMethod -Uri "$taskUrl/api/state" -TimeoutSec 2
    if ($taskState.app -eq 'mumu-route-studio') {
        if (-not $NoBrowser) { Start-Process $taskUrl }
        exit 0
    }
} catch { }
$taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $taskNode) { throw 'Please install Node.js 20+ from https://nodejs.org first.' }
$taskData = Join-Path $taskRoot 'data'
New-Item -ItemType Directory -Force -Path $taskData | Out-Null
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + (Join-Path $taskRoot 'server.js') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log')
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskData 'server.pid')
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $taskState = Invoke-RestMethod -Uri "$taskUrl/api/state" -TimeoutSec 1
        if ($taskState.app -eq 'mumu-route-studio') { if (-not $NoBrowser) { Start-Process $taskUrl }; exit 0 }
    } catch { }
    if ($taskProcess.HasExited) { break }
}
throw ('Startup failed. Check ' + (Join-Path $taskData 'server-error.log'))
