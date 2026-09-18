// TEST-ONLY fixture: Windows launcher for the fake ACTL runtime (PE required).
//
// Production invokes worker.launchCommand with shell:false and an empty
// launchArgsPrefix, so on Windows the launch target must be a native
// executable: spawning the POSIX bash/shebang launcher fails with ENOENT
// from CreateProcess before any JSON reaches the fake runtime. Production
// forbids shell:true/cmd.exe/powershell launch shims, so this tiny launcher
// starts the existing Node fake (FAKE_ACTL_SCRIPT via FAKE_ACTL_NODE_BIN,
// both supplied by the test through the child env), forwards argv verbatim,
// pumps stdin/stdout/stderr as raw bytes, and returns the fake's exit code.
//
// The Node child is placed in a KILL_ON_JOB_CLOSE job (best effort) so a
// bridge timeout kill of this launcher cannot orphan the grandchild the way
// POSIX bash-exec reaps it. Written C# 5-compatible (Add-Type default).
// NEVER referenced by production code.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class FakeActlLauncher
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectBasicLimitInformation = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint SchedulingClass;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass,
        ref JOBOBJECT_BASIC_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

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

    private static void BindKillOnClose(Process child)
    {
        try
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                return;
            }
            JOBOBJECT_BASIC_LIMIT_INFORMATION info = new JOBOBJECT_BASIC_LIMIT_INFORMATION();
            info.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint len = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectBasicLimitInformation, ref info, len))
            {
                CloseHandle(job);
                return;
            }
            if (!AssignProcessToJobObject(job, child.Handle))
            {
                // Already in a job (e.g. nested CI job): proceed without the
                // reap guarantee rather than failing the suite on environment.
                Console.Error.Write("fake-actl-launcher: job bind unavailable, continuing\n");
                CloseHandle(job);
                return;
            }
            // Intentionally leaked: the job must outlive this launcher so a
            // timeout kill of this process reaps the Node grandchild.
        }
        catch
        {
            // Best effort only; stdio forwarding below is the real contract.
        }
    }

    public static int Main(string[] args)
    {
        string nodeBin = Environment.GetEnvironmentVariable("FAKE_ACTL_NODE_BIN");
        string script = Environment.GetEnvironmentVariable("FAKE_ACTL_SCRIPT");
        if (string.IsNullOrEmpty(nodeBin) || string.IsNullOrEmpty(script))
        {
            Console.Error.Write("fake-actl-launcher: FAKE_ACTL_NODE_BIN/FAKE_ACTL_SCRIPT missing\n");
            return 127;
        }
        if (!File.Exists(nodeBin) || !File.Exists(script))
        {
            Console.Error.Write("fake-actl-launcher: node binary or fake script missing\n");
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
            Console.Error.Write("fake-actl-launcher: start failed: " + ex.Message + "\n");
            return 127;
        }

        BindKillOnClose(child);

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
