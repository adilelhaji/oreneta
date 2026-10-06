[CmdletBinding(DefaultParameterSetName = 'Startup')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Startup')][string]$Executable,
    [Parameter(Mandatory = $true, ParameterSetName = 'Startup')][string]$OutputDirectory,
    [switch]$RequireGraph,
    [switch]$VerifyZoom,
    [Parameter(Mandatory = $true, ParameterSetName = 'InputLayout')][switch]$ValidateInputLayout
)

# Native UI verification for the CI-built production executable. Wails disables
# external WebView2 debugger overrides; use Windows accessibility instead.
$ErrorActionPreference = 'Stop'
if ($VerifyZoom -or $ValidateInputLayout) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OrenetaNativeInput {
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputUnion data; }
    // INPUT includes the largest union member even when sending keyboard input.
    // A keyboard-only union is too short (32 instead of 40 bytes on Win64).
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion {
        [FieldOffset(0)] public KeyboardInput keyboard;
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public HardwareInput hardware;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public IntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct HardwareInput { public uint message; public ushort paramLow; public ushort paramHigh; }
    public static int InputSize { get { return Marshal.SizeOf(typeof(Input)); } }
    public static int DataOffset { get { return Marshal.OffsetOf(typeof(Input), "data").ToInt32(); } }
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    public static bool ReleaseModifiers() { return SendInput(2, new[] { Key(0x11, 2), Key(0x10, 2) }, Marshal.SizeOf(typeof(Input))) == 2; }
    private static Input Key(ushort key, uint flags) { return new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { virtualKey = key, scanCode = 0, flags = flags, time = 0, extraInfo = IntPtr.Zero } } }; }
    public static bool SendZoomWheel(int delta) {
        var wheel = new Input { type = 0, data = new InputUnion { mouse = new MouseInput { mouseData = unchecked((uint)delta), flags = 0x0800 } } };
        return SendInput(3, new[] { Key(0x11, 0), wheel, Key(0x11, 2) }, Marshal.SizeOf(typeof(Input))) == 3;
    }
    public static bool SendTab(bool reverse) {
        var inputs = reverse ? new[] { Key(0x10, 0), Key(0x09, 0), Key(0x09, 2), Key(0x10, 2) } : new[] { Key(0x09, 0), Key(0x09, 2) };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
    }
}
"@
    $expectedSize = if ([IntPtr]::Size -eq 8) { 40 } else { 28 }
    $expectedOffset = if ([IntPtr]::Size -eq 8) { 8 } else { 4 }
    if ([OrenetaNativeInput]::InputSize -ne $expectedSize -or [OrenetaNativeInput]::DataOffset -ne $expectedOffset) {
        throw "Invalid Win32 INPUT layout: size=$([OrenetaNativeInput]::InputSize), offset=$([OrenetaNativeInput]::DataOffset)"
    }
}
if ($ValidateInputLayout) {
    Write-Output "PASS Win32 INPUT layout: size=$expectedSize, union offset=$expectedOffset (no input sent)"
    return
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$profile = Join-Path ([IO.Path]::GetTempPath()) ('oreneta-native-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile, $OutputDirectory -Force | Out-Null
$initialEditorHeight = $null

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
            $originalCursor = New-Object OrenetaNativeInput+Point
            if (![OrenetaNativeInput]::GetCursorPos([ref]$originalCursor)) { throw 'Could not capture cursor position' }
            try {
                $focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
                do {
                    [OrenetaNativeInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
                    Start-Sleep -Milliseconds 100
                } while ([OrenetaNativeInput]::GetForegroundWindow() -ne $process.MainWindowHandle -and [DateTime]::UtcNow -lt $focusDeadline)
                if ([OrenetaNativeInput]::GetForegroundWindow() -ne $process.MainWindowHandle) { throw 'Could not focus native window for zoom validation' }
                $baseWindow = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
                $baseEditors = @($baseWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
                    $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and !$_.Current.IsOffscreen
                })
                $baseHeight = if ($baseEditors.Count -gt 0) { $baseEditors[0].Current.BoundingRectangle.Height } else { 0 }
                if ($baseHeight -le 0) { throw 'Email editor is not visible before native zoom-layout validation' }
                if ($null -ne $initialEditorHeight -and [Math]::Abs($baseHeight - $initialEditorHeight) -gt 2) {
                    throw 'Native restart did not preserve the initial editor scale'
                }
                $initialEditorHeight = $baseHeight
                $baseEditors[0].SetFocus()
                $editorBounds = $baseEditors[0].Current.BoundingRectangle
                if (![OrenetaNativeInput]::SetCursorPos([int]($editorBounds.Left + $editorBounds.Width / 2), [int]($editorBounds.Top + $editorBounds.Height / 2))) {
                    throw 'Could not position pointer over the native editor for Ctrl+wheel'
                }
                1..6 | ForEach-Object {
                    if (![OrenetaNativeInput]::SendZoomWheel(120)) { throw 'Windows rejected Ctrl+wheel zoom input' }
                    Start-Sleep -Milliseconds 100
                }
                Start-Sleep -Milliseconds 500
                $zoomWindow = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
                $zoomBounds = $zoomWindow.Current.BoundingRectangle
                $zoomElements = $zoomWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
                $zoomNames = @($zoomElements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
                @($zoomElements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit } | ForEach-Object {
                    @{ name = $_.Current.Name; offscreen = $_.Current.IsOffscreen; focused = $_.Current.HasKeyboardFocus; bounds = $_.Current.BoundingRectangle.ToString() }
                }) | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "launch-$launch-before-scroll.json")
                if ($zoomNames -notcontains 'Google' -or $zoomNames -notcontains 'Microsoft') { throw 'Provider choices disappeared at native zoom-layout validation' }
                # Reflow is allowed to scroll vertically at high zoom. Exercise
                # actual keyboard reachability instead of requiring the whole
                # form to fit above the fold. No button is activated.
                if (![OrenetaNativeInput]::SendTab($false)) { throw 'Windows rejected forward focus navigation' }
                Start-Sleep -Milliseconds 200
                if (![OrenetaNativeInput]::SendTab($true)) { throw 'Windows rejected backward focus navigation' }
                Start-Sleep -Milliseconds 200
                $zoomElements = $zoomWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
                $zoomEditors = @($zoomElements | Where-Object {
                    $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and !$_.Current.IsOffscreen
                })
                if ($zoomEditors.Count -eq 0) { throw 'Email editor is not visible after native zoom-layout validation' }
                if (!$zoomEditors[0].Current.HasKeyboardFocus) { throw 'Keyboard navigation did not return to the email editor after zoom' }
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
                $enlargedHeight = $zoomEditors[0].Current.BoundingRectangle.Height
                $editorBounds = $zoomEditors[0].Current.BoundingRectangle
                if (![OrenetaNativeInput]::SetCursorPos([int]($editorBounds.Left + $editorBounds.Width / 2), [int]($editorBounds.Top + $editorBounds.Height / 2))) {
                    throw 'Could not position pointer for zoom restoration'
                }
                1..6 | ForEach-Object {
                    if (![OrenetaNativeInput]::SendZoomWheel(-120)) { throw 'Windows rejected zoom restoration input' }
                    Start-Sleep -Milliseconds 100
                }
                Start-Sleep -Milliseconds 500
                $restoredEditors = @($zoomWindow.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
                    $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and !$_.Current.IsOffscreen
                })
                if ($restoredEditors.Count -eq 0 -or [Math]::Abs($restoredEditors[0].Current.BoundingRectangle.Height - $baseHeight) -gt 2) {
                    throw 'Native zoom-out did not restore the original editor layout'
                }
                @{ before = $baseHeight; enlarged = $enlargedHeight; restored = $restoredEditors[0].Current.BoundingRectangle.Height } |
                    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "launch-$launch-zoom-measurements.json")
                Write-Output "PASS native zoom-layout launch $launch : editor visible, provider choices present, original size restored"
            } finally {
                $released = [OrenetaNativeInput]::ReleaseModifiers()
                $cursorRestored = [OrenetaNativeInput]::SetCursorPos($originalCursor.x, $originalCursor.y)
                if (!$released -or !$cursorRestored) { throw 'Could not restore native input state after zoom validation' }
            }
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
