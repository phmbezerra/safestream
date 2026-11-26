param(
  [ValidateRange(10,600)][int]$Seconds = 100,
  [ValidateRange(1,10)][int]$IntervalSeconds = 2,
  [string]$Output = '.\reports\t12\process.csv'
)
# Samples ONLY the Node API (3101) and the Go/Pion SFU (3002) server processes.
# Portable PowerShell 5.1 / Windows 10. No external modules or admin needed in a typical local setup.
$ErrorActionPreference='Stop'
$folder=Split-Path -Parent $Output
if($folder){ New-Item -ItemType Directory -Force -Path $folder | Out-Null }
$previous=@{}
$cpuCount=[Environment]::ProcessorCount
$records=New-Object 'System.Collections.Generic.List[object]'
Write-Host "Monitoring listeners at ports 3002 (SFU) and 3101 (API) for $Seconds seconds. CSV: $Output"
$until=(Get-Date).AddSeconds($Seconds)
while((Get-Date) -lt $until){
  $stamp=(Get-Date).ToUniversalTime()
  foreach($entry in @(@{Name='SFU';Port=3002},@{Name='API';Port=3101})){
    try {
      $conn=Get-NetTCPConnection -State Listen -LocalPort $entry.Port -ErrorAction Stop | Select-Object -First 1
      if(-not $conn){throw "listener missing"}
      $proc=Get-Process -Id $conn.OwningProcess -ErrorAction Stop
      $key=$entry.Name
      $cpuSeconds=[double]$proc.CPU
      $cpuPercent=$null
      if($previous.ContainsKey($key) -and $previous[$key].pid -eq $proc.Id){
        $elapsed=($stamp-$previous[$key].stamp).TotalSeconds
        if($elapsed -gt 0){$cpuPercent=[math]::Round((($cpuSeconds-$previous[$key].cpu)/$elapsed/$cpuCount)*100,2)}
      }
      $previous[$key]=@{stamp=$stamp;cpu=$cpuSeconds;pid=$proc.Id}
      $records.Add([pscustomobject]@{
        at=$stamp.ToString('o');role=$key;port=$entry.Port;pid=$proc.Id;
        cpu_pct_normalized=$cpuPercent;
        working_set_mb=[math]::Round($proc.WorkingSet64/1MB,2);
        private_memory_mb=[math]::Round($proc.PrivateMemorySize64/1MB,2)
      })
    }catch{Write-Warning "$($entry.Name) listener on port $($entry.Port) not sampled: $($_.Exception.Message)"}
  }
  Start-Sleep -Seconds $IntervalSeconds
}
if($records.Count){$records | Export-Csv -Path $Output -NoTypeInformation -Encoding UTF8;Write-Host "Wrote $($records.Count) rows to $Output"}
else{Write-Warning 'No samples were collected; check server ports before rerunning.'}
