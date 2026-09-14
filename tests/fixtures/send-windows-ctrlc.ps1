param([Parameter(Mandatory = $true)][int]$TargetPid)

$source = @'
using System;
using System.Runtime.InteropServices;
public static class AgentCommitConsoleSignal {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);
}
'@

Add-Type -TypeDefinition $source
[void][AgentCommitConsoleSignal]::FreeConsole()
if (-not [AgentCommitConsoleSignal]::AttachConsole([uint32]$TargetPid)) {
    throw "AttachConsole failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
if (-not [AgentCommitConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) {
    throw "SetConsoleCtrlHandler failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
if (-not [AgentCommitConsoleSignal]::GenerateConsoleCtrlEvent(0, 0)) {
    throw "GenerateConsoleCtrlEvent failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
Start-Sleep -Milliseconds 250
[void][AgentCommitConsoleSignal]::FreeConsole()
