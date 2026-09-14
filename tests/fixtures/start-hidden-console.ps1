param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$ArgumentsBase64
)

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentCommitHiddenConsole {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
        public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share,
        ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public sealed class Child : IDisposable {
        public readonly IntPtr ProcessHandle; public readonly uint ProcessId;
        public Child(IntPtr handle, uint processId) { ProcessHandle = handle; ProcessId = processId; }
        public int Wait() {
            if (WaitForSingleObject(ProcessHandle, 0xffffffff) == 0xffffffff) throw new Win32Exception();
            uint code;
            if (!GetExitCodeProcess(ProcessHandle, out code)) throw new Win32Exception();
            return unchecked((int)code);
        }
        public void Dispose() { CloseHandle(ProcessHandle); }
    }

    public static Child Start(string executable, string commandLine, string workingDirectory) {
        const uint CREATE_NEW_CONSOLE = 0x00000010;
        const int STARTF_USESHOWWINDOW = 0x00000001;
        const int STARTF_USESTDHANDLES = 0x00000100;
        SetConsoleCtrlHandler(IntPtr.Zero, false);
        var security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(security);
        security.bInheritHandle = true;
        var nullHandle = CreateFileW("NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
        if (nullHandle == new IntPtr(-1)) throw new Win32Exception();
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(startup);
        startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
        startup.wShowWindow = 0;
        startup.hStdInput = nullHandle;
        startup.hStdOutput = nullHandle;
        startup.hStdError = nullHandle;
        PROCESS_INFORMATION process;
        if (!CreateProcessW(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
            true, CREATE_NEW_CONSOLE, IntPtr.Zero, workingDirectory,
            ref startup, out process)) {
            CloseHandle(nullHandle);
            throw new Win32Exception();
        }
        CloseHandle(nullHandle);
        CloseHandle(process.hThread);
        return new Child(process.hProcess, process.dwProcessId);
    }
}
'@

Add-Type -TypeDefinition $source
$argumentsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
$arguments = ConvertFrom-Json $argumentsJson
function ConvertTo-WindowsArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
$commandLine = ((@($Executable) + @($arguments) | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ')
$process = [AgentCommitHiddenConsole]::Start($Executable, $commandLine, $WorkingDirectory)
try {
    [Console]::Out.WriteLine("PID=$($process.ProcessId)")
    [Console]::Out.Flush()
    exit $process.Wait()
} finally {
    $process.Dispose()
}
