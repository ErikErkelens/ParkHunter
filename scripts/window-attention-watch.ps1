param(
    [string]$LogPath = "",
    [int]$DurationSeconds = 0
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

$source = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public sealed class ShellAttentionWatcher : Form
{
    private const int HSHELL_WINDOWACTIVATED = 4;
    private const int HSHELL_REDRAW = 6;
    private const int HSHELL_RUDEAPPACTIVATED = 0x8004;
    private const int HSHELL_FLASH = 0x8006;

    private readonly Action<string> _log;
    private readonly int _shellHookMessage;

    public ShellAttentionWatcher(Action<string> log)
    {
        _log = log;
        ShowInTaskbar = false;
        Width = 360;
        Height = 110;
        StartPosition = FormStartPosition.CenterScreen;
        Text = "ParkHunter Window Watcher";
        KeyPreview = true;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;

        _shellHookMessage = RegisterWindowMessage("SHELLHOOK");
        RegisterShellHookWindow(Handle);

        var label = new Label();
        label.Dock = DockStyle.Fill;
        label.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        label.Text = "Watching window attention events.\r\nPress Q or Esc to stop.";
        Controls.Add(label);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Q || e.KeyCode == Keys.Escape)
        {
            Application.Exit();
            return;
        }

        base.OnKeyDown(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == _shellHookMessage)
        {
            var code = m.WParam.ToInt32();
            var hwnd = m.LParam;
            var eventName = ShellEventName(code);
            if (eventName != null)
            {
                _log(String.Format(
                    "{0:yyyy-MM-dd HH:mm:ss.fff} {1} hwnd=0x{2:X} {3}",
                    DateTime.Now,
                    eventName,
                    hwnd.ToInt64(),
                    DescribeWindow(hwnd)));
            }
        }

        base.WndProc(ref m);
    }

    private static string ShellEventName(int code)
    {
        switch (code)
        {
            case HSHELL_WINDOWACTIVATED:
                return "WINDOW_ACTIVATED";
            case HSHELL_RUDEAPPACTIVATED:
                return "RUDE_APP_ACTIVATED";
            case HSHELL_FLASH:
                return "TASKBAR_FLASH";
            case HSHELL_REDRAW:
                return "WINDOW_REDRAW";
            default:
                return null;
        }
    }

    private static string DescribeWindow(IntPtr hwnd)
    {
        var title = GetWindowText(hwnd);
        int processId;
        GetWindowThreadProcessId(hwnd, out processId);

        var processName = "";
        try
        {
            processName = Process.GetProcessById(processId).ProcessName;
        }
        catch
        {
            processName = "unknown";
        }

        return String.Format("pid={0} process={1} title=\"{2}\"", processId, processName, title);
    }

    private static string GetWindowText(IntPtr hwnd)
    {
        var length = GetWindowTextLength(hwnd);
        var builder = new StringBuilder(length + 1);
        GetWindowText(hwnd, builder, builder.Capacity);
        return builder.ToString().Replace("\r", " ").Replace("\n", " ");
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterShellHookWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int RegisterWindowMessage(string lpString);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing

if (-not $LogPath) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $LogPath = Join-Path $PWD "window-attention-$timestamp.log"
}

$resolvedLogPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogPath)
$logDirectory = Split-Path -Parent $resolvedLogPath
if ($logDirectory -and -not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
}

function Write-AttentionLog {
    param([string]$Line)

    Write-Host $Line
    Add-Content -Path $resolvedLogPath -Value $Line
}

Write-AttentionLog "Window attention watcher started. Log: $resolvedLogPath"
Write-AttentionLog "Reproduce the Commander frequency-change flash, then press Q or Esc in the watcher window to stop."

$watcher = [ShellAttentionWatcher]::new([Action[string]] { param($line) Write-AttentionLog $line })

[Console]::TreatControlCAsInput = $true

if ($DurationSeconds -gt 0) {
    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = $DurationSeconds * 1000
    $timer.Add_Tick({
        $timer.Stop()
        [System.Windows.Forms.Application]::Exit()
    })
    $timer.Start()
}

try {
    [System.Windows.Forms.Application]::Run($watcher)
}
finally {
    [Console]::TreatControlCAsInput = $false
    if ($timer) {
        $timer.Dispose()
    }
    $watcher.Dispose()
    Write-Host "Window attention watcher stopped."
}
