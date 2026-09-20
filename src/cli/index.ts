#!/usr/bin/env node
/**
 * Agent Relay Minimal CLI Core — Phase I3B
 * Commands: status, doctor, --help, --version, bare, --no-tui
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline';
import { discoverConfig, notInitializedMessage } from './config.js';
import { buildStatusSnapshot, renderStatusHuman, STATUS_SCHEMA_VERSION } from './status.js';
import { runDoctor, renderDoctorHuman, DOCTOR_SCHEMA_VERSION } from './doctor.js';

const VERSION = '0.3.1';

function printHelp(): void {
  console.log(`agent-relay — Agent Relay CLI

Usage:
  agent-relay [command] [options]

Commands:
  status              Show project status snapshot
  doctor              Run infrastructure health checks
  workspace start     Auto bootstrap multi-project lanes (REUSE FIRST, no dispatch)
  workspace status    Show workspace lanes + concurrency (AUTOMATION_STARTED view)
  workspace configure Save a workspace preset (fixtures|current, no manual prompts)
  workspace run       Run ONE project lane (dry-run default, --live is bounded)
  workspace cert      Write the complete Builder Result artifact for a cycle
  history <taskId>    Show read-only Task timeline (V2 H1, no state changes)
  resume-scan         Scan stuck/interrupted work (V2 R1, read-only report)
  resume act          Run one guided recovery action (V2 R2, Owner confirm required)
  init                Initialize project (interactive or --yes)
  connect <client>    Configure PM MCP (claude-code)
  host watch          Watch pending PM Deliveries and hand them to the PM Host

Options:
  --help, -h          Show this help
  --version, -v       Show version
  --json              JSON output (for status, doctor, init)
  --no-tui            Headless status entry (no TUI)
  --yes               Non-interactive defaults (for init)
  --force             Overwrite existing config/worker
  --once              Single pass and exit (for host watch)
  --poll-ms <ms>      Host watch cadence (for host watch, default 1000)
  --host-config <dir> Directory containing host.json (default <cwd>/.agent-relay)

Examples:
  agent-relay status
  agent-relay status --json
  agent-relay doctor
  agent-relay doctor --json
  agent-relay workspace start
  agent-relay workspace start --json
  agent-relay workspace status
  agent-relay workspace status --json
  agent-relay workspace configure --preset fixtures
  agent-relay workspace run --lane actl
  agent-relay workspace run --lane actl --live --project actl
  agent-relay history TASK-0001
  agent-relay history TASK-0001 --json
  agent-relay resume-scan
  agent-relay resume-scan --json
  agent-relay resume act --task TASK-0001 --pattern ORPHANED_DISPATCH --orphan-action KEEP_WAITING --yes
  agent-relay init
  agent-relay init --yes
  agent-relay init --yes --json
  agent-relay connect claude-code
  agent-relay host watch --once
  agent-relay --no-tui
`);
}

function parseArgs(argv: string[]): { command: string | null; sub: string | null; taskId: string | null; task: string | null; pattern: string | null; run: string | null; prep: string | null; orphanAction: string | null; reason: string | null; lane: string | null; preset: string | null; script: string | null; project: string | null; cycle: string | null; testsFile: string | null; risksFile: string | null; base: string | null; ready: string | null; maxTurns: number | null; live: boolean; dryRun: boolean; json: boolean; noTui: boolean; help: boolean; version: boolean; yes: boolean; force: boolean; once: boolean; pollMs: number | null; hostConfig: string | null; unknown: string | null } {
  const args = argv.slice(2);
  let command: string | null = null;
  let sub: string | null = null;
  let taskId: string | null = null;
  let task: string | null = null;
  let pattern: string | null = null;
  let run: string | null = null;
  let prep: string | null = null;
  let orphanAction: string | null = null;
  let reason: string | null = null;
  let lane: string | null = null;
  let preset: string | null = null;
  let script: string | null = null;
  let project: string | null = null;
  let cycle: string | null = null;
  let testsFile: string | null = null;
  let risksFile: string | null = null;
  let base: string | null = null;
  let ready: string | null = null;
  let maxTurns: number | null = null;
  let live = false;
  let dryRun = false;
  let json = false;
  let noTui = false;
  let help = false;
  let version = false;
  let yes = false;
  let force = false;
  let once = false;
  let pollMs: number | null = null;
  let hostConfig: string | null = null;
  let unknown: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v') version = true;
    else if (a === '--json') json = true;
    else if (a === '--no-tui') noTui = true;
    else if (a === '--yes') yes = true;
    else if (a === '--force') force = true;
    else if (a === '--once') once = true;
    else if (a === '--live') live = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--poll-ms' || a === '--host-config' || a === '--task' || a === '--pattern' || a === '--run' || a === '--prep' || a === '--orphan-action' || a === '--reason' || a === '--lane' || a === '--preset' || a === '--script' || a === '--project' || a === '--cycle' || a === '--tests' || a === '--risks-file' || a === '--base' || a === '--ready' || a === '--max-turns') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) { unknown = a; break; }
      if (a === '--poll-ms') {
        const n = Number(next);
        if (!Number.isFinite(n)) { unknown = `${a} ${next}`; break; }
        pollMs = n;
      } else if (a === '--max-turns') {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 1) { unknown = `${a} ${next}`; break; }
        maxTurns = Math.floor(n);
      } else if (a === '--lane') {
        lane = next;
      } else if (a === '--task') {
        task = next;
      } else if (a === '--preset') {
        preset = next;
      } else if (a === '--script') {
        script = next;
      } else if (a === '--project') {
        project = next;
      } else if (a === '--cycle') {
        cycle = next;
      } else if (a === '--tests') {
        testsFile = next;
      } else if (a === '--risks-file') {
        risksFile = next;
      } else if (a === '--base') {
        base = next;
      } else if (a === '--ready') {
        ready = next;
      } else if (a === '--pattern') {
        pattern = next;
      } else if (a === '--run') {
        run = next;
      } else if (a === '--prep') {
        prep = next;
      } else if (a === '--orphan-action') {
        orphanAction = next;
      } else if (a === '--reason') {
        reason = next;
      } else {
        hostConfig = next;
      }
      i++;
    } else if (a.startsWith('--')) {
      unknown = a;
      break;
    } else if (!command && (a === 'status' || a === 'doctor' || a === 'history' || a === 'resume-scan' || a === 'resume' || a === 'init' || a === 'connect' || a === 'host' || a === 'workspace')) {
      command = a;
    } else if ((command === 'connect' || command === 'host' || command === 'resume' || command === 'workspace') && !sub) {
      sub = a;
    } else if (command === 'history' && !taskId) {
      taskId = a;
    } else {
      unknown = a;
      break;
    }
  }

  return { command, sub, taskId, task, pattern, run, prep, orphanAction, reason, lane, preset, script, project, cycle, testsFile, risksFile, base, ready, maxTurns, live, dryRun, json, noTui, help, version, yes, force, once, pollMs, hostConfig, unknown };
}

async function promptOwnerConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { command, sub, taskId, task, pattern, run, prep, orphanAction, reason, lane, preset, script, project, cycle, testsFile, risksFile, base, ready, maxTurns, live, dryRun, json, noTui, help, version, yes, force, once, pollMs, hostConfig, unknown } = parseArgs(process.argv);
  const cwd = process.cwd();

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (version) {
    if (json) {
      // JSON mode version output should still be JSON? Spec says errors in JSON mode structured; but version in json is okay to output json
      console.log(JSON.stringify({ version: VERSION }, null, 2));
    } else {
      console.log(VERSION);
    }
    process.exit(0);
  }

  if (unknown) {
    const msg = `Unknown command or option: ${unknown}`;
    if (json) {
      console.log(JSON.stringify({ schemaVersion: 'cli.error.v1', ok: false, error: msg }, null, 2));
    } else {
      console.error(msg);
      console.error('Run: agent-relay --help');
    }
    process.exit(1);
  }

  // --no-tui as standalone flag without subcommand: treat as bare with noTui semantics
  if (noTui && !command) {
    // behave as headless status/runtime entry: load config, validate, print one startup/status summary, exit cleanly
    const snap = buildStatusSnapshot(cwd);
    if (json) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(renderStatusHuman(snap));
      console.log('');
      console.log('[headless] --no-tui mode: status shown, exiting.');
    }
    process.exit(0);
  }

  // Handle --no-tui with explicit command: status/doctor still work, but no daemon
  // (for this phase, --no-tui with command just runs command normally plus headless marker)
  if (command === 'status') {
    const snap = buildStatusSnapshot(cwd);
    if (json) {
      // Must be ONLY valid JSON on stdout
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(renderStatusHuman(snap));
      if (noTui) {
        console.log('');
        console.log('[headless] --no-tui mode: status shown, exiting.');
      }
    }
    // status exit code: 0 even if not initialized? Doctor determines health; status is informational
    // But if config forbidden error, maybe still 0; we'll exit 0 for status.
    process.exit(0);
  }

  if (command === 'doctor') {
    const result = runDoctor(cwd);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderDoctorHuman(result));
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'history') {
    const { runHistory, renderHistoryHuman, HISTORY_SCHEMA_VERSION } = await import('./history.js');
    if (!taskId) {
      const msg = 'Usage: agent-relay history <taskId> [--json]';
      if (json) console.log(JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    const res = runHistory(cwd, taskId);
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok && res.error === 'not-initialized') {
      console.log(notInitializedMessage());
    } else {
      console.log(renderHistoryHuman(res));
    }
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'resume-scan') {
    const { runResumeScan, renderResumeScanHuman, RESUME_SCAN_SCHEMA_VERSION } = await import('./resume-scan.js');
    const res = runResumeScan(cwd);
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok && res.error === 'not-initialized') {
      console.log(notInitializedMessage());
    } else {
      console.log(renderResumeScanHuman(res));
    }
    process.exit(res.ok ? 0 : 1);
  }

  // V2 R2 — guided recovery action. Locked rule: explicit Owner confirm
  // every time. --yes counts as explicit; otherwise an interactive [y/N]
  // prompt is required (TTY). Non-TTY without --yes refuses outright.
  if (command === 'resume') {
    const { runResumeAct, renderResumeActHuman, resumeActUsage, RESUME_SCHEMA_VERSION } = await import('./resume.js');
    if (sub !== 'act') {
      if (json) console.log(JSON.stringify({ schemaVersion: RESUME_SCHEMA_VERSION, ok: false, error: resumeActUsage() }, null, 2));
      else console.error(resumeActUsage());
      process.exit(1);
    }
    if (!task || !pattern) {
      if (json) console.log(JSON.stringify({ schemaVersion: RESUME_SCHEMA_VERSION, ok: false, error: resumeActUsage() }, null, 2));
      else console.error(resumeActUsage());
      process.exit(1);
    }
    let confirmed = yes;
    if (!confirmed) {
      if (process.stdin.isTTY) {
        confirmed = await promptOwnerConfirm(`Execute guided action ${pattern} on ${task}?`);
      }
      if (!confirmed) {
        const msg = 'refused: Owner confirmation required (--yes or interactive y). Nothing executed.';
        if (json) console.log(JSON.stringify({ schemaVersion: RESUME_SCHEMA_VERSION, ok: false, error: msg }, null, 2));
        else console.error(msg);
        process.exit(1);
      }
    }
    const res = await runResumeAct(cwd, {
      pattern, taskId: task,
      ...(run ? { runId: run } : {}),
      ...(prep ? { preparationId: prep } : {}),
      ...(orphanAction ? { orphanAction } : {}),
      ...(reason ? { reason } : {}),
      confirmed,
    });
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok && res.error === 'not-initialized') {
      console.log(notInitializedMessage());
    } else {
      console.log(renderResumeActHuman(res));
    }
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'init') {
    const { runInit, renderInitHuman, INIT_SCHEMA_VERSION } = await import('./init.js');
    try {
      const result = await runInit({ cwd, yes, force, json });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderInitHuman(result));
        // Run doctor internally then print summary
        const { runDoctor, renderDoctorHuman } = await import('./doctor.js');
        const doc = runDoctor(cwd);
        console.log('');
        console.log(renderDoctorHuman(doc));
      }
      process.exit(0);
    } catch (e) {
      const err = e as Error & { code?: string };
      const msg = err.message ?? String(e);
      if (json) {
        console.log(JSON.stringify({ schemaVersion: INIT_SCHEMA_VERSION, ok: false, error: msg, code: err.code }, null, 2));
      } else {
        console.error(msg);
        if (err.code === 'ALREADY_INITIALIZED') {
          console.error('Use --force to overwrite (runtime history preserved).');
        }
      }
      process.exit(1);
    }
  }

  if (command === 'connect') {
    const { runConnect } = await import('./connect.js');
    const client = sub ?? '';
    if (!client) {
      const msg = 'Usage: agent-relay connect <client>  (supported: claude-code)';
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.connect.v1', ok: false, client: '', configured: false, method: 'manual', message: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    const res = runConnect(cwd, client, { force });
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(res.message);
      if (res.mcpCommand) console.log(`\nMCP: ${res.mcpCommand}`);
      if (res.configPath) console.log(`Config: ${res.configPath}`);
      if (res.scope) console.log(`Scope: ${res.scope}`);
      if (res.warnings && res.warnings.length) {
        console.log('\nWarnings:');
        for (const w of res.warnings) console.log(`  ! ${w}`);
      }
      if (res.diagnostic) console.log(`\nDiagnostic: ${res.diagnostic.slice(0, 400)}`);
    }
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'host') {
    if (sub !== 'watch') {
      const msg = 'Usage: agent-relay host watch [--once] [--poll-ms <ms>] [--host-config <dir>]';
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.host.v1', ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    const { runHostWatch } = await import('./host.js');
    const code = await runHostWatch({
      cwd,
      once,
      ...(pollMs !== null ? { pollMs } : {}),
      ...(hostConfig !== null ? { hostConfigDir: hostConfig } : {}),
    });
    process.exit(code);
  }

  if (command === 'workspace') {
    if (sub !== 'start' && sub !== 'status' && sub !== 'configure' && sub !== 'run' && sub !== 'cert') {
      const msg = 'Usage: agent-relay workspace <start|status|configure|run|cert> [--json]';
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace.v1', ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    const { runWorkspaceStart, runWorkspaceStatus, renderWorkspaceStartHuman, renderWorkspaceStatusHuman, runWorkspaceConfigure } = await import('../workspace/bootstrap.js');
    if (sub === 'start') {
      const res = runWorkspaceStart(cwd);
      if (json) console.log(JSON.stringify(res, null, 2));
      else console.log(renderWorkspaceStartHuman(res));
      process.exit(res.ok ? 0 : 1);
    }
    if (sub === 'status') {
      const st = runWorkspaceStatus(cwd);
      if (json) console.log(JSON.stringify(st, null, 2));
      else console.log(renderWorkspaceStatusHuman(st));
      process.exit(st.ok ? 0 : 1);
    }
    if (sub === 'configure') {
      try {
        const res = runWorkspaceConfigure(cwd, preset ?? 'fixtures', force);
        if (json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Workspace preset: ${res.preset}`);
          for (const l of res.lanes) {
            console.log(`${l.id}: pm=${l.pm} builder=${l.builder} qa=${l.qa} fallback=${l.fallbackQa}`);
          }
          for (const w of res.warnings) console.log(`! ${w}`);
          console.log(`Config: ${res.configPath}`);
        }
        process.exit(0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (json) console.log(JSON.stringify({ schemaVersion: 'workspace.configure.v1', ok: false, error: msg }, null, 2));
        else console.error(msg);
        process.exit(1);
      }
    }
    // sub === 'run': ONE project lane. Dry-run default; --live is bounded.
    if (sub === 'run') {
    if (!lane) {
      const msg = 'Usage: agent-relay workspace run --lane <id> [--dry-run|--live] [--script accept|changes] [--project <name>] [--cycle <id>] [--max-turns N] [--json]';
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace-run.v1', ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    if (script !== null && script !== 'accept' && script !== 'changes') {
      const msg = `Unknown --script: ${script} (expected accept|changes)`;
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace-run.v1', ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    const { runLaneDryRun, runLaneLive } = await import('../workspace/run-cli.js');
    try {
      if (live && !dryRun) {
        const res = await runLaneLive(cwd, lane, {
          ...(project !== null ? { project } : {}),
          ...(maxTurns !== null ? { maxTurns } : {}),
          ...(cycle !== null ? { correlationId: cycle } : {}),
        });
        if (json) {
          console.log(JSON.stringify({ schemaVersion: 'cli.workspace-run.v1', ...res, audit: undefined }, null, 2));
        } else {
          console.log(`lane ${res.laneId} live: ${res.outcome.outcome}${res.outcome.reason ? ` — ${res.outcome.reason}` : ''}`);
          console.log(`sessions: builder=${res.boundSessions.builder} qa=${res.boundSessions.qa}`);
          console.log(`safeStop: ${res.safeStop} (a safe stop is a guardrail success, not an end-to-end pass)`);
          console.log(`founderRelayActions: ${res.founderRelayActions}`);
          console.log(`audit: ${res.auditFile}`);
        }
        process.exit(res.outcome.outcome === 'BLOCKED' || res.outcome.outcome === 'NO_DISPATCHABLE_TASK' ? 2 : 0);
      }
      const res = await runLaneDryRun(cwd, lane, {
        script: script === 'changes' ? 'changes' : 'accept',
        ...(maxTurns !== null ? { maxTurns } : {}),
        ...(cycle !== null ? { correlationId: cycle } : {}),
      });
      if (json) {
        console.log(JSON.stringify({ schemaVersion: 'cli.workspace-run.v1', mode: res.mode, laneId: res.laneId, outcome: res.outcome, auditFile: res.auditFile }, null, 2));
      } else {
        console.log(`lane ${res.laneId} dry-run: ${res.outcome.outcome}${res.outcome.reason ? ` — ${res.outcome.reason}` : ''}`);
        console.log(`attempts: ${res.outcome.attempts} qaMode: ${res.outcome.qaMode ?? 'primary'}`);
        console.log(`audit: ${res.auditFile}`);
      }
      process.exit(res.outcome.outcome === 'ACCEPT_AND_ADVANCE' ? 0 : 2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace-run.v1', ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exit(1);
    }
    } // end sub === 'run'

    if (sub === 'cert') {
      if (!cycle) {
        const msg = 'Usage: agent-relay workspace cert --cycle <id> [--task <text>] [--tests <summary.json>] [--commands-file <f>] [--risks-file <f>] [--base <sha>] [--ready YES|NO] [--json]';
        if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace-cert.v1', ok: false, error: msg }, null, 2));
        else console.error(msg);
        process.exit(1);
      }
      const { runWorkspaceCert } = await import('../workspace/cert-cli.js');
      try {
        const res = await runWorkspaceCert(cwd, {
          cycle,
          ...(task !== null ? { task } : {}),
          ...(testsFile !== null ? { testsFile } : {}),
          ...(risksFile !== null ? { risksFile } : {}),
          ...(base !== null ? { base } : {}),
          ...(ready !== null ? { ready } : {}),
        });
        if (json) {
          console.log(JSON.stringify({ schemaVersion: 'cli.workspace-cert.v1', ok: true, ...res }, null, 2));
        } else {
          console.log(`Builder Result Artifact: ${res.artifactPath}`);
          console.log(`artifact: ${res.artifact.artifactId} status=${res.artifact.status}`);
          console.log(`overallTestStatus: ${res.artifact.overallTestStatus} readyForIndependentQA: ${res.artifact.readyForIndependentQA}`);
        }
        process.exit(0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (json) console.log(JSON.stringify({ schemaVersion: 'cli.workspace-cert.v1', ok: false, error: msg }, null, 2));
        else console.error(msg);
        process.exit(1);
      }
    }
  }

  // Bare agent-relay (no command)
  if (!command) {
    const discovered = discoverConfig(cwd);
    const snap = buildStatusSnapshot(cwd);
    if (json) {
      console.log(JSON.stringify(snap, null, 2));
      process.exit(0);
    }
    // Non-TTY fallback: behave like --no-tui, no escape sequences, no hang
    const isTTY = !!process.stdout.isTTY && !!process.stdin.isTTY;
    if (noTui || !isTTY) {
      if (discovered.initialized) {
        console.log(renderStatusHuman(snap));
        console.log('');
        console.log('[headless] --no-tui mode: status shown, exiting.');
      } else {
        console.log(notInitializedMessage());
        if (snap.warnings.length > 0 || snap.error) {
          console.log('');
          console.log(renderStatusHuman(snap));
        }
      }
      process.exit(0);
    }
    // TTY + initialized → launch TUI
    if (discovered.initialized) {
      const { launchTui } = await import('../tui/tui.js');
      await launchTui({ cwd });
      // launchTui never returns normally (exits on q/Ctrl-C)
      process.exit(0);
    } else {
      console.log(notInitializedMessage());
      if (snap.warnings.length > 0 || snap.error) {
        console.log('');
        console.log(renderStatusHuman(snap));
      }
      process.exit(0);
    }
  }

  // Fallback unknown
  const msg2 = `Unknown command: ${command}`;
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 'cli.error.v1', ok: false, error: msg2 }, null, 2));
  } else {
    console.error(msg2);
  }
  process.exit(1);
}

void main();
