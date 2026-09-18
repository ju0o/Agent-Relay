// TEST-ONLY fixture: fake `claude` executable for Windows (PE required).
//
// Mirrors test/fixtures/workers/fake-claude-qa-echo.mjs semantics: scan argv
// for `--print`, echo the trailing prompt inside a structured semantic-QA
// block, exit 0. Additionally appends nothing but writes the received argv
// (one per line) to FAKE_CLAUDE_ARGV_DUMP when set, proving the wrapper
// forwarded `--print <prompt>` verbatim across the shell:false spawn.
//
// Compiled on demand by the Slice8 test via PowerShell Add-Type (Windows
// only). NEVER referenced by production code.
using System;
using System.IO;

public static class FakeClaudeQaEcho
{
    public static int Main(string[] args)
    {
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
        string dump = Environment.GetEnvironmentVariable("FAKE_CLAUDE_ARGV_DUMP");
        if (!string.IsNullOrEmpty(dump))
        {
            try { File.WriteAllText(dump, string.Join("\n", args)); } catch { }
        }
        return 0;
    }
}
