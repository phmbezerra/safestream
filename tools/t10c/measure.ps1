#requires -Version 5.1
<# SafeStream T-10C - Windows process resource sampler for Pion and Node.
    Uses T-10A phase markers to exclude setup and compilation from resource
    sampling. Never transmits data or sessions to outside services. #>
[CmdletBinding()]
param(
    [ValidateRange(3,30)][int]$Seconds = 8,
    [ValidateRange(5,60)][int]$Pps = 30,
    [ValidateRange(100,1100)][int]$Payload = 900,
    [ValidateRange(100,2000)][int]$SampleMs = 250,
    [ValidateSet(1,2,5,10,20)][int[]]$Levels = @(1,2,5,10,20)
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sfu = Join-Path $repo 'sfu'
$reports = Join-Path $repo 'reports\t10\t10c'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$go = (Get-Command go -ErrorAction Stop).Source

function Get-ListenerPid([int]$port) {
    $listen = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if ($listen.Count -ne 1) {
        throw "Expected exactly one 127.0.0.1 listener on port $port, got $($listen.Count)."
    }
    return [int]$listen[0].OwningProcess
}

function Get-Snapshot([int]$processId, [string]$role, [double]$elapsed) {
    $p = Get-Process -Id $processId -ErrorAction Stop
    if ($null -eq $p.CPU) { throw "Cannot access CPU time for $role PID $processId" }
    [pscustomobject]@{
        Role=$role; Pid=$processId; ElapsedSeconds=$elapsed;
        CpuSeconds=[double]$p.CPU;
        WorkingSetMB=[math]::Round([double]$p.WorkingSet64 / 1MB, 3);
        PrivateMemoryMB=[math]::Round([double]$p.PrivateMemorySize64 / 1MB, 3)
    }
}

function Summarize([object[]]$samples, [string]$role) {
    $v = @($samples | Where-Object { $_.Role -eq $role })
    if ($v.Count -lt 3) { throw "Too few active phase samples for ${role}: $($v.Count)" }
    $first=$v[0]; $last=$v[-1]
    $span = $last.ElapsedSeconds - $first.ElapsedSeconds
    if ($span -le 0) {throw "Invalid sample span for $role"}
    $cpuDelta = $last.CpuSeconds - $first.CpuSeconds
    if ($cpuDelta -lt 0) {throw "CPU time decreased for $role; process may have restarted"}
    [pscustomobject]@{
        pid=$first.Pid
        samples=$v.Count
        sampledSeconds=[math]::Round($span,3)
        averageCoreEquivalentCpuPercent=[math]::Round(100*$cpuDelta/$span,2)
        peakWorkingSetMB=[math]::Round(($v | Measure-Object -Property WorkingSetMB -Maximum).Maximum,2)
        peakPrivateMemoryMB=[math]::Round(($v | Measure-Object -Property PrivateMemoryMB -Maximum).Maximum,2)
    }
}

$api = Invoke-RestMethod 'http://127.0.0.1:3101/api/health' -TimeoutSec 5
$sfuHealth = Invoke-RestMethod 'http://127.0.0.1:3002/health' -TimeoutSec 5
if (-not $api.ok -or -not $sfuHealth.ok) {throw 'Node and Pion health checks must both succeed.'}
$nodePid = Get-ListenerPid 3101
$pionPid = Get-ListenerPid 3002
Write-Host "Sampling Node PID $nodePid and Pion PID $pionPid (processes owning ports 3101 and 3002)."
Write-Host 'Close any other benchmark clients; avoid using production sessions.'
$rows = New-Object System.Collections.ArrayList
$overall = [Diagnostics.Stopwatch]::StartNew()
foreach ($n in $Levels) {
    Write-Host "===== T-10C load: $n viewer(s) ====="
    $phaseFile = Join-Path $reports "phase-$n.txt"
    $benchmarkJson = Join-Path $reports "t10a-level-$n.json"
    $stdout = Join-Path $reports "level-$n.stdout.txt"
    $stderr = Join-Path $reports "level-$n.stderr.txt"
    foreach ($path in @($phaseFile, $benchmarkJson, $stdout, $stderr)) {
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Force }
    }
    # Arguments/paths must contain no whitespace for Windows PowerShell 5.1
    # Start-Process ArgumentList. These generated filenames contain none,
    # but the repository path is allowed to contain spaces (Go receives the
    # artifact paths relative to its working directory).
    $runArgs = @('run','./bench/t10','-levels',"$n",'-seconds',"$Seconds",'-pps',"$Pps",'-payload',"$Payload",'-out',"../reports/t10/t10c/t10a-level-$n.json",'-phase-file',"../reports/t10/t10c/phase-$n.txt")
    $child = Start-Process -FilePath $go -ArgumentList $runArgs -WorkingDirectory $sfu -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $samples = New-Object System.Collections.ArrayList
    $clock=[Diagnostics.Stopwatch]::StartNew()
    try {
        while ($true) {
            $child.Refresh()
            if ($child.HasExited) {break}
            $phase = ''
            if (Test-Path $phaseFile) {
                try { $phase = (Get-Content -LiteralPath $phaseFile -Raw -ErrorAction Stop).Trim() } catch { $phase = '' }
            }
            if ($phase -eq 'active') {
                if ((Get-ListenerPid 3002) -ne $pionPid -or (Get-ListenerPid 3101) -ne $nodePid) {
                    throw 'Node or Pion listener changed PID during benchmark.'
                }
                $elapsed = $clock.Elapsed.TotalSeconds
                [void]$samples.Add((Get-Snapshot -processId $pionPid -role 'pion' -elapsed $elapsed))
                [void]$samples.Add((Get-Snapshot -processId $nodePid -role 'node' -elapsed $elapsed))
            }
            Start-Sleep -Milliseconds $SampleMs
        }
        $child.WaitForExit()
        $exit = $child.ExitCode
        if ($null -eq $exit) {
            if (-not (Select-String -LiteralPath $stdout -Pattern '^OBSERVED:' -Quiet)) {
                throw "T-10A level ${n}: exit code unavailable and no success marker. Inspect $stdout and $stderr"
            }
        } elseif ($exit -ne 0) {
            Write-Host 'Benchmark output:'
            Get-Content -LiteralPath $stdout
            Get-Content -LiteralPath $stderr
            throw "T-10A level $n failed: exit code $exit"
        }
        if (-not (Test-Path $benchmarkJson)) { throw "Missing benchmark JSON: $benchmarkJson" }
        $data = Get-Content -LiteralPath $benchmarkJson -Raw | ConvertFrom-Json
        if (@($data.levels).Count -ne 1) { throw "Unexpected level count for $n" }
        $level = $data.levels[0]
        if ($level.requestedViewers -ne $n -or $level.admittedAndConnected -ne $n -or $level.viewersWithPackets -ne $n) {
            throw "T-10A viewers incomplete for $n; see $benchmarkJson"
        }
        $pion = Summarize -samples @($samples.ToArray()) -role 'pion'
        $node = Summarize -samples @($samples.ToArray()) -role 'node'
        $csv = Join-Path $reports "samples-level-$n.csv"
        $samples | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
        $aggregatePayloadMbps = 0
        if ($level.durationSeconds -gt 0) {
            $aggregatePayloadMbps = [math]::Round(8.0*[double]$level.totalPayloadBytesReceived/[double]$level.durationSeconds/1000000.0,3)
        }
        $row = [pscustomobject]@{
            viewers=$n
            connected=$level.admittedAndConnected
            receivingRtp=$level.viewersWithPackets
            publisherPacketsSent=$level.publisherPacketsSent
            totalPayloadBytesReceived=$level.totalPayloadBytesReceived
            aggregateReceivedPayloadMbps=$aggregatePayloadMbps
            pion=$pion
            node=$node
            samplesCsv="samples-level-$n.csv"
            benchmarkJson="t10a-level-$n.json"
        }
        [void]$rows.Add($row)
        Write-Host ("  connected={0}/{0} PionCPU={1}% PionWSpeak={2}MB NodeCPU={3}% payload={4}Mbps" -f $n,$pion.averageCoreEquivalentCpuPercent,$pion.peakWorkingSetMB,$node.averageCoreEquivalentCpuPercent,$aggregatePayloadMbps)
    } finally {
        $child.Refresh()
        if (-not $child.HasExited) {
            Write-Warning 'Sampler encountered an error; stopping only the benchmark launcher (not Node/Pion).'
            Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        }
        $child.Dispose()
    }
}
$summary = [pscustomobject]@{
    schemaVersion='t10c-1'
    generatedAt=[DateTime]::UtcNow.ToString('o')
    scope='Windows process CPU/memory during active local synthetic-RTP phase only'
    pionPid=$pionPid
    nodePid=$nodePid
    secondsPerLevel=$Seconds
    packetsPerSecond=$Pps
    payloadBytes=$Payload
    sampleIntervalMs=$SampleMs
    elapsedTotalSeconds=[math]::Round($overall.Elapsed.TotalSeconds,2)
    levels=@($rows.ToArray())
    limitations=@(
        'CPU percent uses CPU-seconds/wall-seconds * 100; 100% = one logical CPU core, can exceed 100%.',
        'CPU samples exclude compilation/peer setup; sampled window can be shorter than nominal RTP phase.',
        'Working set/private memory are Windows process counters, not Go heap-only allocations.',
        'RTP payload Mbps excludes ICE/DTLS/SRTP, UDP/IP overhead, RTCP and all authorization API traffic.',
        'A single host and sequential viewer admission do not establish capacity or WAN behavior.',
        'No production performance guarantee.'
    )
}
$summaryPath=Join-Path $reports 't10c-summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Host 'T-10C resource sampling complete.'
Write-Host "JSON: $summaryPath"
$rows | Select-Object viewers,connected,receivingRtp,aggregateReceivedPayloadMbps,@{N='PionCPUcorePct';E={$_.pion.averageCoreEquivalentCpuPercent}},@{N='PionPeakWSMB';E={$_.pion.peakWorkingSetMB}},@{N='NodeCPUcorePct';E={$_.node.averageCoreEquivalentCpuPercent}} | Format-Table -AutoSize
