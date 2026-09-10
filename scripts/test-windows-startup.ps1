param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$RequireGraph,
    [switch]$VerifyZoom
)

# Native UI verification for the CI-built production executable. Wails disables
# external WebView2 debugger overrides; use Windows accessibility instead.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ($VerifyZoom) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OrenetaNativeInput {
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public IntPtr extraInfo; }
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    private static Input Key(ushort key, uint flags) => new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { virtualKey = key, scanCode = 0, flags = flags, time = 0, extraInfo = IntPtr.Zero } } };
    public static bool SendZoomReset() { return SendInput(4, new[] { Key(0x11, 0), Key(0x30, 0), Key(0x30, 2), Key(0x11, 2) }, Marshal.SizeOf(typeof(Input))) == 4; }
    public static bool SendZoomIn() { return SendInput(6, new[] { Key(0x11, 0), Key(0x10, 0), Key(0xBB, 0), Key(0xBB, 2), Key(0x10, 2), Key(0x11, 2) }, Marshal.SizeOf(typeof(Input))) == 6; }
}
"@
}
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
        $hasEmailInput = $false
        do {
            if ($process.HasExited) { throw "Application exited during launch $launch" }
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
                $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
                $names = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
                $hasEmailInput = @($elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit }).Count -gt 0
                if ($hasEmailInput -and $names -contains 'Google' -and $names -contains 'Microsoft') { break }
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        $names | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "launch-$launch-ui.json")
        if (!$hasEmailInput -or $names -notcontains 'Google' -or $names -notcontains 'Microsoft') { throw "Onboarding did not render on launch $launch" }
        if ($RequireGraph -and !($names -match '^Microsoft Graph')) { throw "Graph account choice did not render on launch $launch" }
        if ($names -match 'Something went wrong|useSyncExternalStore') { throw 'React startup error in native UI' }

        if ($VerifyZoom) {
            $focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
            do {
                [OrenetaNativeInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
                Start-Sleep -Milliseconds 100
            } while ([OrenetaNativeInput]::GetForegroundWindow() -ne $process.MainWindowHandle -and [DateTime]::UtcNow -lt $focusDeadline)
            if ([OrenetaNativeInput]::GetForegroundWindow() -ne $process.MainWindowHandle) { throw 'Could not focus native window for zoom validation' }
            if (![OrenetaNativeInput]::SendZoomReset()) { throw 'Windows rejected Ctrl+0 zoom input' }
            Start-Sleep -Milliseconds 250
            $baseWindow = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            $baseEditors = @($baseWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
                $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and !$_.Current.IsOffscreen
            })
            $baseHeight = if ($baseEditors.Count -gt 0) { $baseEditors[0].Current.BoundingRectangle.Height } else { 0 }
            if ($baseHeight -le 0) { throw 'Email editor is not visible before native zoom-layout validation' }
            1..6 | ForEach-Object {
                if (![OrenetaNativeInput]::SendZoomIn()) { throw 'Windows rejected Ctrl+plus zoom input' }
                Start-Sleep -Milliseconds 100
            }
            Start-Sleep -Milliseconds 500
            $zoomWindow = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            $zoomBounds = $zoomWindow.Current.BoundingRectangle
            $zoomElements = $zoomWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
            $zoomNames = @($zoomElements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
            if ($zoomNames -notcontains 'Google' -or $zoomNames -notcontains 'Microsoft') { throw 'Provider choices disappeared at native zoom-layout validation' }
            $zoomEditors = @($zoomElements | Where-Object {
                $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and !$_.Current.IsOffscreen
            })
            if ($zoomEditors.Count -eq 0) { throw 'Email editor is not visible after native zoom-layout validation' }
            if ($zoomEditors[0].Current.BoundingRectangle.Height -le ($baseHeight * 1.1)) {
                throw 'Native zoom input did not change the editor layout'
            }
            foreach ($element in @($zoomEditors | Select-Object -First 1)) {
                $bounds = $element.Current.BoundingRectangle
                if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
                    $bounds.Left -lt $zoomBounds.Left -or $bounds.Top -lt $zoomBounds.Top -or
                    $bounds.Right -gt $zoomBounds.Right -or $bounds.Bottom -gt $zoomBounds.Bottom) {
                    throw 'Email editor bounds escaped the native window during zoom-layout validation'
                }
            }
            $zoomNames | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "launch-$launch-zoom-ui.json")
            Write-Output "PASS native zoom-layout launch $launch : essential controls remain visible"
        }

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
