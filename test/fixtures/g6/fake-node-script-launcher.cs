// TEST-ONLY fixture: Windows runner for the G6 fake worker scripts (PE required).
//
// The G6 suite's fake workers are .mjs scripts (#!/usr/bin/env node). POSIX
// execve honors the shebang under the wrapper's shell:false spawn, but Windows
// CreateProcess cannot start a non-PE script with shell:false (ENOENT before
// any fake output exists), which empties the diagnostic excerpt and trips a
// downstream TypeError in the test. Production forbids shell:true/cmd.exe, so
// this tiny launcher starts the SAME Node fake script (G6_NODE_SCRIPT via
// G6_NODE_BIN, both supplied by the test through the child env), forwards argv
// verbatim, pumps stdin/stdout/stderr as raw bytes, inherits the full
// environment (so Run-bound CLAUDE_CONFIG_DIR reaches the Node grandchild),
// and returns the fake's exit code.
//
// Deliberately NOT shared with the ACTL launcher: different contract (no
// collect-delay mode, no job-object reap — the wrapper never kills its child
// on the relay path, so there is no orphan to reap). Written C# 5-compatible
// (Add-Type default). NEVER referenced by production code.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

public static class FakeNodeScriptLauncher
{
    private static string QuoteArg(string value)
    {
        if (value.Length == 0)
        {
            return "\"\"";
        }
        bool needQuotes = false;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == ' ' || c == '\t' || c == '"' || c == '\n')
            {
                needQuotes = true;
                break;
            }
        }
        if (!needQuotes)
        {
            return value;
        }
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        string nodeBin = Environment.GetEnvironmentVariable("G6_NODE_BIN");
        string script = Environment.GetEnvironmentVariable("G6_NODE_SCRIPT");
        if (string.IsNullOrEmpty(nodeBin) || string.IsNullOrEmpty(script))
        {
            Console.Error.Write("fake-node-script-launcher: G6_NODE_BIN/G6_NODE_SCRIPT missing\n");
            return 127;
        }
        if (!File.Exists(nodeBin) || !File.Exists(script))
        {
            Console.Error.Write("fake-node-script-launcher: node binary or fake script missing\n");
            return 127;
        }

        string arguments = QuoteArg(script);
        for (int i = 0; i < args.Length; i++)
        {
            arguments += " " + QuoteArg(args[i]);
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = nodeBin;
        psi.Arguments = arguments;
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Console.Error.Write("fake-node-script-launcher: start failed: " + ex.Message + "\n");
            return 127;
        }

        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        Stream stderr = Console.OpenStandardError();
        Task stdinPump = stdin.CopyToAsync(child.StandardInput.BaseStream).ContinueWith(delegate
        {
            try { child.StandardInput.Close(); } catch { }
        });
        Task stdoutPump = child.StandardOutput.BaseStream.CopyToAsync(stdout);
        Task stderrPump = child.StandardError.BaseStream.CopyToAsync(stderr);
        child.WaitForExit();
        Task.WaitAll(stdinPump, stdoutPump, stderrPump);
        stdout.Flush();
        stderr.Flush();
        return child.ExitCode;
    }
}
