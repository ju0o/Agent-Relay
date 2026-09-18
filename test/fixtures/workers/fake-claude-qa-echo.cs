// TEST-ONLY fixture: fake `claude` executable for Windows (PE required).
//
// Mirrors the .mjs fixtures' semantics. Behavior selected by FAKE_CLAUDE_MODE
// (default "echo"); a single compiled .exe therefore covers all three fake
// roles without duplicating fixtures:
//   echo (default) : scan argv for `--print`, echo the trailing prompt inside
//                    a structured semantic-QA block, exit 0.
//                    (mirrors fake-claude-qa-echo.mjs)
//   fail           : exit 3 (mirrors fake-claude-qa-fail.mjs).
//   argv           : print `argv.join("|") + "|CONFIG=<dir>|PWD=<cwd>"`
//                    (mirrors the dynamic fake-claude-argv.mjs).
// When FAKE_CLAUDE_ARGV_DUMP is set, the received argv (one per line) is
// written there in every mode, proving the wrapper forwarded its argv
// across the shell:false spawn. NEVER referenced by production code.
using System;
using System.IO;

public static class FakeClaudeQaEcho
{
    static void DumpArgv(string[] args)
    {
        string dump = Environment.GetEnvironmentVariable("FAKE_CLAUDE_ARGV_DUMP");
        if (!string.IsNullOrEmpty(dump))
        {
            try { File.WriteAllText(dump, string.Join("\n", args)); } catch { }
        }
    }

    public static int Main(string[] args)
    {
        string mode = Environment.GetEnvironmentVariable("FAKE_CLAUDE_MODE") ?? "echo";
        if (mode == "fail")
        {
            DumpArgv(args);
            Console.Error.Write("fake claude failure\n");
            return 3;
        }
        if (mode == "argv")
        {
            DumpArgv(args);
            Console.Write(
                string.Join("|", args)
                + "|CONFIG=" + (Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? "")
                + "|PWD=" + (Environment.GetEnvironmentVariable("PWD") ?? ""));
            return 0;
        }
        string prompt = "";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--print" && i + 1 < args.Length)
            {
                prompt = args[i + 1];
                break;
            }
        }
        string head = prompt.Length <= 64 ? prompt : prompt.Substring(0, 64);
        Console.Write("status: PASS\ncriteria:\n- AC-02: PASS\nECHO:" + head + "\n");
        DumpArgv(args);
        return 0;
    }
}
