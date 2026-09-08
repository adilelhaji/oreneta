param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

# Native UI verification for the CI-built production executable. Wails disables
# external WebView2 debugger overrides; use Windows accessibility instead.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$profile = Join-Path ([IO.Path]::GetTempPath()) ('oreneta-native-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile, $OutputDirectory -Force | Out-Null

for ($launch = 1; $launch -le 2; $launch++) {
    $log = Join-Path $profile 'Roaming/oreneta-dev/oreneta.log'
    # Keep the profile for restart coverage, but require fresh engine evidence.
    if (Test-Path -LiteralPath $log) {
        Move-Item -LiteralPath $log -Destination (Join-Path $OutputDirectory "before-launch-$launch.log") -Force
    }
    $start = [Diagnostics.ProcessStartInfo]::new($executablePath)
    $start.UseShellExecute = $false
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.Environment['APPDATA'] = Join-Path $profile 'Roaming'
    $start.Environment['LOCALAPPDATA'] = Join-Path $profile 'Local'
    $start.Environment['USERPROFILE'] = $profile
    $start.Environment['MERON_KEYRING'] = 'off'
    $start.Environment['MERON_DISABLE_SELF_UPDATE'] = '1'
    # Release Wails ignores this value; the app's existing profile selection
    # gives this test a separate single-instance identity from a user's app.
    $start.Environment['devserver'] = 'native-startup-test'
    $start.Environment['frontenddevserverurl'] = ''
    $process = [Diagnostics.Process]::Start($start)
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(40)
        $names = @()
        do {
            if ($process.HasExited) { throw "Application exited during launch $launch" }
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
                $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
                $names = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
                if ($names -contains 'IMAP / SMTP') { break }
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        $names | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "launch-$launch-ui.json")
        if ($names -notcontains 'IMAP / SMTP') { throw "Onboarding did not render on launch $launch" }
        if ($names -match 'Something went wrong|useSyncExternalStore') { throw 'React startup error in native UI' }

        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            $logText = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
            if ($logText -match 'invoke account.list ok') { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($logText -notmatch 'core started' -or $logText -notmatch 'invoke account.list ok') {
            throw 'Native window did not reach the embedded mail engine'
        }
        if ($logText -match 'App startup failed|core.fatal') { throw 'Native startup logged a failure' }
        Write-Output "PASS native launch $launch : onboarding and embedded core available"
    } finally {
        # Only the process created by this test is terminated. Closing Oreneta's
        # window hides it to the tray, which would retain its single-instance lock.
        if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
        $log = Join-Path $profile 'Roaming/oreneta-dev/oreneta.log'
        if (Test-Path -LiteralPath $log) {
            Copy-Item -LiteralPath $log -Destination (Join-Path $OutputDirectory "launch-$launch.log")
        }
    }
}
Write-Output "Temporary native profile retained: $profile"
