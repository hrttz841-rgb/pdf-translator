$ErrorActionPreference = 'SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot
$PidFile = Join-Path $PSScriptRoot '.pdf_translator.pid'
$PortFile = Join-Path $PSScriptRoot '.pdf_translator.port'
if (Test-Path $PidFile) {
    $pidValue = Get-Content $PidFile | Select-Object -First 1
    if ($pidValue) {
        $p = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
        if ($p) {
            Stop-Process -Id ([int]$pidValue) -Force
            Write-Host 'PDF 翻译工具已停止。'
        } else {
            Write-Host '记录的后台进程已经结束。'
        }
    }
    Remove-Item $PidFile,$PortFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host '没有发现由这个目录启动的后台服务。'
}
Start-Sleep -Seconds 1