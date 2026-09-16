import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-ghpm-'));
const dataRoot = path.join(root, 'data');
const repo = path.join(root, 'repo');
const state = path.join(root, 'state.json');
const audit = path.join(root, 'audit');
fs.mkdirSync(dataRoot, { recursive: true });
execFileSync('git', ['init', '--bare', path.join(root, 'origin.git')]);
fs.mkdirSync(repo); execFileSync('git', ['-C', repo, 'init']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(root, 'origin.git')]);
execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base']);

const cli = path.resolve('dist/server/github-pm/main.js');
const args = ['--dataRoot', dataRoot, '--project', 'NotAllowlisted', '--transport', 'git-gh', '--repo-dir', repo, '--pr', 'ju0o/Agent-Relay#5', '--state-file', state, '--audit-dir', audit, '--mode', 'export', '--dry-run', '--once'];
const output = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
assert.equal(output, '', 'empty allowlist result has no packet or network command');
assert.equal(fs.existsSync(path.join(dataRoot, 'NotAllowlisted')), false, 'bridge does not create project state');
assert.equal(fs.existsSync(path.join(dataRoot, 'V02CControlTower')), false, 'live-data marker untouched');
console.log('PASS github-pm bridge disposable boundary and allowlist');
