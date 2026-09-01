#!/usr/bin/env node
/**
 * Agent Relay Minimal CLI Core — Phase I3B
 * Commands: status, doctor, --help, --version, bare, --no-tui
 */
import * as fs from 'fs';
import * as path from 'path';
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

Options:
  --help, -h          Show this help
  --version, -v       Show version
  --json              JSON output (for status, doctor)
  --no-tui            Headless status entry (no TUI)

Examples:
  agent-relay status
  agent-relay status --json
  agent-relay doctor
  agent-relay doctor --json
  agent-relay --no-tui
`);
}

function parseArgs(argv: string[]): { command: string | null; json: boolean; noTui: boolean; help: boolean; version: boolean; unknown: string | null } {
  const args = argv.slice(2);
  let command: string | null = null;
  let json = false;
  let noTui = false;
  let help = false;
  let version = false;
  let unknown: string | null = null;

  for (const a of args) {
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v') version = true;
    else if (a === '--json') json = true;
    else if (a === '--no-tui') noTui = true;
    else if (a.startsWith('--')) {
      unknown = a;
      break;
    } else if (!command && (a === 'status' || a === 'doctor')) {
      command = a;
    } else if (!command && a === 'init') {
      // init not implemented yet — treat as known but forward UX
      command = a;
    } else {
      unknown = a;
      break;
    }
  }

  return { command, json, noTui, help, version, unknown };
}

function main(): void {
  const { command, json, noTui, help, version, unknown } = parseArgs(process.argv);
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

  if (command === 'init') {
    // init not implemented yet
    const msg = 'agent-relay init is not implemented yet.';
    if (json) {
      console.log(JSON.stringify({ schemaVersion: 'cli.init.v1', ok: false, error: msg }, null, 2));
    } else {
      console.log(msg);
      console.log('Future: creates .agent-relay/config.json');
    }
    process.exit(1);
  }

  // Bare agent-relay (no command)
  if (!command) {
    const discovered = discoverConfig(cwd);
    const snap = buildStatusSnapshot(cwd);
    if (json) {
      console.log(JSON.stringify(snap, null, 2));
      process.exit(0);
    }
    if (discovered.initialized) {
      console.log(renderStatusHuman(snap));
      console.log('');
      console.log('TUI is not installed in this build yet.');
    } else {
      // Not initialized
      console.log(notInitializedMessage());
      // Also show brief status for context
      if (snap.warnings.length > 0 || snap.error) {
        console.log('');
        console.log(renderStatusHuman(snap));
      }
    }
    if (noTui) {
      console.log('');
      console.log('[headless] --no-tui mode: status shown, exiting.');
    }
    process.exit(0);
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

main();
