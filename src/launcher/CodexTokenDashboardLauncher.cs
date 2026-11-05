using System;
using System.Diagnostics;
using System.IO;

internal static class CodexTokenDashboardLauncher
{
    [STAThread]
    private static int Main()
    {
        string installRoot = AppDomain.CurrentDomain.BaseDirectory;
        string appDirectory = Path.Combine(installRoot, "CodexTokenDashboard");
        string target = Path.Combine(appDirectory, "Codex 用量监控.exe");

        if (!File.Exists(target))
        {
            return 2;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = target,
            WorkingDirectory = appDirectory,
            UseShellExecute = true
        });
        return 0;
    }
}
