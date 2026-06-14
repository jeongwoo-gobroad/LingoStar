param(
  [int] $Port = 8787,
  [switch] $DeveloperMode
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) {
  $nodeCommand.Source
} elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") {
  "$env:ProgramFiles\nodejs\node.exe"
} else {
  throw "Node.js was not found. Install Node.js 20+ or add node.exe to PATH."
}
$out = Join-Path $root "lingostar-server.out.log"
$err = Join-Path $root "lingostar-server.err.log"

$env:PORT = [string] $Port
$serverArgs = @("server.js")
if ($DeveloperMode) {
  $serverArgs += "--developer-mode"
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = ($serverArgs -join " ")
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$null = $process.Start()

Start-Sleep -Seconds 2

$response = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 5

[pscustomobject]@{
  Pid = $process.Id
  Port = $Port
  Status = $response.StatusCode
  Url = "http://localhost:$Port/mcp"
}
