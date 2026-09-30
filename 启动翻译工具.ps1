$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$BasePort = 8765
$ExpectedVersion = '2.6.0'
$PidFile = Join-Path $PSScriptRoot '.pdf_translator.pid'
$PortFile = Join-Path $PSScriptRoot '.pdf_translator.port'
$LogFile = Join-Path $PSScriptRoot 'pdf-translator.log'

function Get-PythonCommand {
    try {
        $v = & py -3 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { return @{Exe='py'; Args=@('-3')} }
    } catch {}
    try {
        $v = & python -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { return @{Exe='python'; Args=@()} }
    } catch {}
    return $null
}

function Get-Health([int]$Port) {
    try {
        return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 1
    } catch { return $null }
}

function Test-PortFree([int]$Port) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start(); $listener.Stop(); return $true
    } catch { return $false }
}

function Open-App([int]$Port) {
    Start-Process ("http://127.0.0.1:{0}" -f $Port)
}

$health = Get-Health $BasePort
if ($health -and $health.app -eq 'scholar-pdf-translator' -and $health.version -eq $ExpectedVersion) {
    Write-Host "PDF 翻译工具 v$ExpectedVersion 已经在运行，正在打开浏览器。"
    Open-App $BasePort
    exit 0
}

# Reuse an instance started from this folder when possible.
if ((Test-Path $PidFile) -and (Test-Path $PortFile)) {
    $oldPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $oldPort = [int](Get-Content $PortFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($oldPid) {
        $proc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($proc) {
            $h = Get-Health $oldPort
            if ($h -and $h.app -eq 'scholar-pdf-translator' -and $h.version -eq $ExpectedVersion) {
                Write-Host "PDF 翻译工具 v$ExpectedVersion 已经在运行，正在打开浏览器。"
                Open-App $oldPort
                exit 0
            }
            try { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Remove-Item $PidFile,$PortFile -Force -ErrorAction SilentlyContinue
}

$port = $BasePort
if (-not (Test-PortFree $port)) {
    $found = $false
    foreach ($candidate in 8766..8795) {
        if (Test-PortFree $candidate) { $port = $candidate; $found = $true; break }
    }
    if (-not $found) {
        Write-Host '8765-8795 范围内没有可用端口。' -ForegroundColor Red
        Read-Host '按回车键关闭窗口'
        exit 1
    }
}

$py = Get-PythonCommand
if (-not $py) {
    Write-Host '没有找到 Python 3。' -ForegroundColor Red
    Write-Host '请从 https://www.python.org/downloads/windows/ 安装 Python 3，并勾选 Add Python to PATH。'
    Read-Host '按回车键关闭窗口'
    exit 1
}

# Ensure python-docx is available for Word export.
$pythonExe = $py.Exe
$pythonPrefix = $py.Args
$checkArgs = @() + $pythonPrefix + @('-c','import docx')
& $pythonExe @checkArgs 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host '正在安装 Word 导出组件 python-docx（仅首次需要）...'
    $pipArgs = @() + $pythonPrefix + @('-m','pip','install','--user','python-docx')
    & $pythonExe @pipArgs *>> $LogFile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "python-docx 安装失败，请查看：$LogFile" -ForegroundColor Red
        Read-Host '按回车键关闭窗口'
        exit 1
    }
}

$env:PDF_TRANSLATOR_PORT = "$port"
Set-Content -LiteralPath $LogFile -Value '' -Encoding UTF8
$pythonArgs = @() + $pythonPrefix + @('server.py')
$proc = Start-Process -FilePath $pythonExe -ArgumentList $pythonArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError (Join-Path $PSScriptRoot 'pdf-translator-error.log') -PassThru
Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII
Set-Content -LiteralPath $PortFile -Value $port -Encoding ASCII

$ready = $false
for ($i=0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $h = Get-Health $port
    if ($h -and $h.app -eq 'scholar-pdf-translator') {
        if ($h.version -ne $ExpectedVersion) {
            try { Stop-Process -Id $proc.Id -Force } catch {}
            Write-Host "启动到了错误版本：$($h.version)，预期 $ExpectedVersion。" -ForegroundColor Red
            break
        }
        $ready = $true; break
    }
    if ($proc.HasExited) { break }
}

if ($ready) {
    Write-Host "PDF 翻译工具 v$ExpectedVersion 已启动。"
    Write-Host ("地址：http://127.0.0.1:{0}" -f $port)
    Write-Host 'AI HTTPS：优先使用 Windows 系统 curl/Schannel 证书链。'
    Write-Host '各 AI 平台 API Key：按平台分别使用 Windows DPAPI 加密，仅当前 Windows 用户可解密。'
    Open-App $port
    Start-Sleep -Seconds 1
    exit 0
}

Write-Host '启动失败。请查看 pdf-translator.log 和 pdf-translator-error.log。' -ForegroundColor Red
Remove-Item $PidFile,$PortFile -Force -ErrorAction SilentlyContinue
Read-Host '按回车键关闭窗口'
exit 1