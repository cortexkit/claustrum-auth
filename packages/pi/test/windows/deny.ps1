# Asks the provisioned standard user to read the Pi extension's private files.
# Adapted from the 'deny' action of common-auth's test/windows/inspect.ps1.
# Runs as the job's own (administrator) user and reads one JSON request on
# stdin: { controlDir, directory, paths }. controlDir is Pi's agent folder,
# directory the plugin's claustrum-auth folder inside it, and paths the files
# in that folder.
#
# Before the probe runs, the probe user is let in to the agent folder (list
# only, nothing inherited) and to one control file written there. The plugin's
# folder keeps its own protected ACL, so it must still refuse the probe; the
# controls show the refusal does not come from the profile around it.
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
function Progress($message) { [Console]::Error.WriteLine("deny: +$($clock.ElapsedMilliseconds)ms $message"); [Console]::Error.Flush() }
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
trap {
  $errorObject = $_.Exception
  while ($errorObject.InnerException) { $errorObject = $errorObject.InnerException }
  [Console]::Error.WriteLine((@{ event = 'powershell-error'; type = $errorObject.GetType().FullName; message = $errorObject.Message; hresult = $errorObject.HResult } | ConvertTo-Json -Compress))
  break
}
Import-Module Microsoft.PowerShell.Utility
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$name = $env:CLAUSTRUM_AUTH_PROBE_USER
if (-not $name -or -not $env:CLAUSTRUM_AUTH_PROBE_PASSWORD -or -not $env:CLAUSTRUM_AUTH_PROBE_SID) { throw 'Provision the standard probe user (provision-user.ps1) before this probe' }
$user = Get-LocalUser -Name $name
if ($user.SID.Value -ne $env:CLAUSTRUM_AUTH_PROBE_SID) { throw 'Provisioned probe SID mismatch' }
$password = ConvertTo-SecureString $env:CLAUSTRUM_AUTH_PROBE_PASSWORD -AsPlainText -Force
Progress "reusing warmed standard user: $($user.SID.Value)"

# Positive controls inside the agent folder.
$controlFile = Join-Path $request.controlDir 'second-user-control.txt'
[IO.File]::WriteAllText($controlFile, 'agent control')
$fileAcl = [Security.AccessControl.FileSecurity]::new($controlFile, [Security.AccessControl.AccessControlSections]::Access)
$fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Read', 'Allow'))
[IO.File]::SetAccessControl($controlFile, $fileAcl)
$dirAcl = [Security.AccessControl.DirectorySecurity]::new($request.controlDir, [Security.AccessControl.AccessControlSections]::Access)
$dirAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'ReadAndExecute', 'None', 'None', 'Allow'))
[IO.Directory]::SetAccessControl($request.controlDir, $dirAcl)
Progress 'agent folder controls granted'

$public = Join-Path $env:PUBLIC ('claustrum-auth-probe-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $public | Out-Null
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($public, $acl)
  [IO.File]::WriteAllText((Join-Path $public 'control.txt'), 'public control')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'second-user.ps1') -Destination (Join-Path $public 'probe.ps1')
  @{ paths = @($request.paths); directory = $request.directory; controlDir = $request.controlDir; controlFile = $controlFile; expectedSid = $user.SID.Value } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $public 'request.json')
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Progress 'credentialed child launch'
  $child = Start-Process -FilePath $exe -Credential $credential -LoadUserProfile -WorkingDirectory $public -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $public 'probe.ps1') + '"')) -PassThru -RedirectStandardOutput (Join-Path $public 'stdout.txt') -RedirectStandardError (Join-Path $public 'stderr.txt')
  # Holding the handle before exit makes ExitCode observable for credentialed children.
  $null = $child.Handle
  if (-not $child.WaitForExit(60000)) { $child.Kill(); $child.WaitForExit(5000) | Out-Null; throw 'Second-user probe timed out' }
  $child.WaitForExit()
  Progress "credentialed child exit: $($child.ExitCode)"
  $resultExists = [IO.File]::Exists((Join-Path $public 'result.json'))
  if ($child.ExitCode -ne 0 -or -not $resultExists) {
    $diagnostic = @{ exitCode = $child.ExitCode; resultExists = $resultExists; stdout = [IO.File]::ReadAllText((Join-Path $public 'stdout.txt')); stderr = [IO.File]::ReadAllText((Join-Path $public 'stderr.txt')) } | ConvertTo-Json -Compress
    throw ('Second-user probe failed: ' + $diagnostic)
  }
  $result = [IO.File]::ReadAllText((Join-Path $public 'result.json')) | ConvertFrom-Json
  if ($result.sid -ne $user.SID.Value -or -not $result.standardUser -or -not $result.publicRead -or -not $result.controlRead -or -not $result.controlListed -or -not $result.directoryDenied -or -not $result.filesDenied) { throw 'Second-user identity, positive control or denial failed' }
  $result | ConvertTo-Json -Depth 4 -Compress
} finally {
  # A credentialed process can keep a file open for a moment after it exits,
  # so removal is retried briefly.
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([IO.Directory]::Exists($public)) {
    try { Remove-Item -LiteralPath $public -Recurse -Force -ErrorAction Stop; break }
    catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}
