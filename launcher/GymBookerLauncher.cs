using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

internal static class GymBookerLauncher
{
    private const int DefaultPort = 3210;

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            LauncherOptions options = ParseArgs(args);
            string root = FindWorkspaceRoot();
            string nodePath = FindNodeExecutable(root);
            string url = "http://localhost:" + options.Port;

            if (!IsPortOpen("127.0.0.1", options.Port))
            {
                StartServer(root, nodePath, options);
                WaitForPort("127.0.0.1", options.Port, TimeSpan.FromSeconds(15));
            }

            if (options.OpenBrowser)
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Failed to start GymBooker.\n\n" + ex.Message,
                "GymBooker Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static LauncherOptions ParseArgs(string[] args)
    {
        var options = new LauncherOptions
        {
            OpenBrowser = true,
            Port = DefaultPort
        };
        ApplyDefaultsFromExeName(options);

        for (int index = 0; index < args.Length; index++)
        {
            string key = args[index];
            string value = index + 1 < args.Length ? args[index + 1] : null;

            if (EqualsAny(key, "--no-browser", "/nobrowser"))
            {
                options.OpenBrowser = false;
            }
            else if (EqualsAny(key, "--port") && !string.IsNullOrWhiteSpace(value))
            {
                options.Port = int.Parse(value);
                index++;
            }
            else if (EqualsAny(key, "--config") && !string.IsNullOrWhiteSpace(value))
            {
                options.ConfigPath = value;
                index++;
            }
            else if (EqualsAny(key, "--instance") && !string.IsNullOrWhiteSpace(value))
            {
                options.InstanceName = value;
                index++;
            }
        }

        return options;
    }

    private static void ApplyDefaultsFromExeName(LauncherOptions options)
    {
        string exeName = Path.GetFileNameWithoutExtension(Application.ExecutablePath).ToLowerInvariant();
        if (exeName.Contains("card-c") || exeName.Contains("card_c") || exeName.Contains("3212"))
        {
            options.ConfigPath = "config\\multi-instance.json";
            options.InstanceName = "card_c";
            options.Port = 3212;
            return;
        }

        if (exeName.Contains("card-b") || exeName.Contains("card_b") || exeName.Contains("3211"))
        {
            options.ConfigPath = "config\\multi-instance.json";
            options.InstanceName = "card_b";
            options.Port = 3211;
            return;
        }

        if (exeName.Contains("card-a") || exeName.Contains("card_a") || exeName.Contains("3210"))
        {
            options.ConfigPath = "config\\multi-instance.json";
            options.InstanceName = "card_a";
            options.Port = 3210;
        }
    }

    private static string FindWorkspaceRoot()
    {
        string[] candidates =
        {
            AppDomain.CurrentDomain.BaseDirectory,
            Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."))
        };

        foreach (string candidate in candidates)
        {
            string serverPath = Path.Combine(candidate, "src", "ui-server.js");
            string packagePath = Path.Combine(candidate, "package.json");
            if (File.Exists(serverPath) && File.Exists(packagePath))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("Project root not found. Put GymBooker.exe in the project folder or in dist.");
    }

    private static string FindNodeExecutable(string root)
    {
        string[] candidates =
        {
            Path.Combine(root, "node.exe"),
            Path.Combine(root, "runtime", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
        };

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        return "node";
    }

    private static void StartServer(string root, string nodePath, LauncherOptions options)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = BuildServerArguments(options),
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        Process process = Process.Start(startInfo);
        if (process == null)
        {
            throw new InvalidOperationException("Failed to start local UI server process.");
        }
    }

    private static string BuildServerArguments(LauncherOptions options)
    {
        var parts = new List<string>
        {
            QuoteArg("src/ui-server.js"),
            "--port",
            QuoteArg(options.Port.ToString())
        };

        if (!string.IsNullOrWhiteSpace(options.ConfigPath))
        {
            parts.Add("--config");
            parts.Add(QuoteArg(options.ConfigPath));
        }

        if (!string.IsNullOrWhiteSpace(options.InstanceName))
        {
            parts.Add("--instance");
            parts.Add(QuoteArg(options.InstanceName));
        }

        return string.Join(" ", parts.ToArray());
    }

    private static string QuoteArg(string value)
    {
        if (value == null)
        {
            return "\"\"";
        }

        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static void WaitForPort(string host, int port, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (IsPortOpen(host, port))
            {
                return;
            }

            Thread.Sleep(250);
        }

        throw new TimeoutException("Local UI server startup timed out. Check Node.js and project files.");
    }

    private static bool IsPortOpen(string host, int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var result = client.BeginConnect(host, port, null, null);
                bool success = result.AsyncWaitHandle.WaitOne(250);
                if (!success)
                {
                    return false;
                }

                client.EndConnect(result);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool EqualsAny(string value, params string[] candidates)
    {
        foreach (string candidate in candidates)
        {
            if (string.Equals(value, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private sealed class LauncherOptions
    {
        public bool OpenBrowser { get; set; }
        public int Port { get; set; }
        public string ConfigPath { get; set; }
        public string InstanceName { get; set; }
    }
}
