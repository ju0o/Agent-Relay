/**
 * Phase G — Trusted Worker Registry.
 *
 * Storage (global, trusted):
 *   {dataRoot}/_relay/workers/{workerId}.json
 *
 * Project paths such as {dataRoot}/{project}/workers/ are NEVER used.
 * Project Goal/Task/Event/Evidence content cannot redefine launchCommand.
 */
import * as fs from 'fs';
import * as path from 'path';

export const WORKER_REGISTRY_SCHEMA_VERSION = 'G.2' as const;

/** Allowlisted executable basenames (PATH-resolved). Absolute paths are also accepted. */
export const ALLOWED_EXECUTABLE_BASENAMES: ReadonlySet<string> = new Set([
  'node',
  'node.exe',
]);

/**
 * Phase I — Claude-driver permission mode.
 *
 * Controls which --permission-mode flag is passed to the Claude CLI.
 * Only a narrow typed enum is accepted — arbitrary CLI flags are not allowed.
 *
 * 'default'     → no --permission-mode flag; Claude uses its own default (least privilege).
 * 'acceptEdits' → passes --permission-mode acceptEdits; Claude auto-accepts file edits.
 *
 * 'dangerously-skip-permissions' is intentionally NOT supported.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits';

/**
 * Round 35 — strict Builder verification tool allowlist.
 *
 * A Builder (implementation role) Claude worker may declare a bounded set of
 * verification commands it may run via Bash in --print mode. Patterns are
 * forwarded as repeated `--allowedTool <pattern>` relay args and reach Claude
 * as a single `--allowedTools <p1> <p2> …` argv. Everything outside this
 * allowlist is rejected by the registry AND by the wrapper as a fatal ArgError
 * — least privilege, never a subtitle for arbitrary CLI flags or shell.
 */
export const ALLOWED_TOOL_BASH_CMDS: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'npx',
  'git status',
  'git diff',
  'git log',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'test',
]);

/** Non-Bash tools allowed exactly — Claude built-in read/write tools only. */
export const ALLOWED_TOOL_EXACT_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
]);

const ALLOWED_TOOL_BASH_RE = /^Bash\(([^:]+):\*\)$/;

/** True when `pattern` is one of the strict Builder verification patterns. */
export function isAllowedToolPattern(pattern: string): boolean {
  if (ALLOWED_TOOL_EXACT_TOOLS.has(pattern)) return true;
  const m = ALLOWED_TOOL_BASH_RE.exec(pattern);
  if (!m) return false;
  return ALLOWED_TOOL_BASH_CMDS.has(m[1]);
}

/** Strongly typed Claude driver options. Never allows arbitrary flags or shell fragments. */
export interface ClaudeDriverOptions {
  /** Explicit Claude profile directory for quota isolation. */
  configDir?: string;
  /**
   * Claude CLI permission mode (optional).
   * If absent, preserves existing Claude default (least privilege).
   */
  permissionMode?: ClaudePermissionMode;
  /**
   * Round 35 — optional strict Builder verification allowlist. Each entry must
   * satisfy `isAllowedToolPattern`: `Bash(<cmd>:*)` for a verify-only command
   * (node/npm/npx/git status/git diff/git log/ls/cat/head/tail/wc/grep/rg/find/test)
   * or exactly one of Read/Glob/Grep/Edit/Write. QA workers must never set this.
   */
  allowedTools?: string[];
}

/**
 * Phase 2 — trusted actl Managed driver options (opt-in only).
 * Absolute paths only; never arbitrary CLI flags or shell fragments.
 */
export interface ActlDriverOptions {
  /** Managed contract version — only 1 is accepted. */
  contractVersion: 1;
  /** Frozen actl runtime identity (not derived from Task narrative). */
  runtimeId: string;
  /** v1 Managed agent kind — Codex only for Phase 2. */
  agentKind: 'codex';
  /** Absolute Codex profile root expected on the live runtime. */
  expectedProfileRoot: string;
  /** Absolute explicit tmux socket path (never default-server inference). */
  socketPath: string;
}

/**
 * Driver-specific execution options, keyed by driver name.
 * Stored in trusted Worker Registry only — never from Task/Goal/PM narrative.
 */
export interface WorkerDriverOptions {
  /** Options specific to the 'claude-code' driver (relay-worker-claude.mjs). */
  claude?: ClaudeDriverOptions;
  /** Options specific to the actl-managed observation/execution branch. */
  actl?: ActlDriverOptions;
}

/** Allowed permissionMode enum values for Claude driver. */
export const ALLOWED_CLAUDE_PERMISSION_MODES: ReadonlySet<ClaudePermissionMode> = new Set([
  'default',
  'acceptEdits',
]);

const ACTL_DRIVER_KEYS = new Set([
  'contractVersion',
  'runtimeId',
  'agentKind',
  'expectedProfileRoot',
  'socketPath',
]);

function requireAbsolutePath(value: unknown, field: string): string {
  const s = requireNonEmptyString(value, field);
  if (!path.isAbsolute(s)) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `${field} must be an absolute path.`);
  }
  if (FORBIDDEN_LAUNCH_MARKERS.test(s) || s.includes('\t')) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `${field} path is invalid.`);
  }
  return path.resolve(s);
}

function requireExistingAbsoluteDirectory(value: unknown, field: string): string {
  const resolved = requireAbsolutePath(value, field);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch { /* fail below */ }
  throw new WorkerRegistryError('INVALID_ARGUMENT', `${field} must be an existing directory.`);
}

/** Validate narrowly typed driverOptions.actl (unknown keys rejected). */
export function validateActlDriverOptions(raw: unknown): ActlDriverOptions {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', 'driverOptions.actl must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ACTL_DRIVER_KEYS.has(key)) {
      throw new WorkerRegistryError(
        'INVALID_ARGUMENT',
        `Unknown driverOptions.actl key: '${key}'. Allowed: contractVersion, runtimeId, agentKind, expectedProfileRoot, socketPath.`,
      );
    }
  }
  if (obj.contractVersion !== 1) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      `driverOptions.actl.contractVersion must be 1 (got ${String(obj.contractVersion)}).`,
    );
  }
  const runtimeId = requireNonEmptyString(obj.runtimeId, 'driverOptions.actl.runtimeId');
  if (obj.agentKind !== 'codex') {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      `driverOptions.actl.agentKind must be 'codex' (got ${String(obj.agentKind)}).`,
    );
  }
  const expectedProfileRoot = requireAbsolutePath(obj.expectedProfileRoot, 'driverOptions.actl.expectedProfileRoot');
  const socketPath = requireAbsolutePath(obj.socketPath, 'driverOptions.actl.socketPath');
  return {
    contractVersion: 1,
    runtimeId,
    agentKind: 'codex',
    expectedProfileRoot,
    socketPath,
  };
}

/** True when the trusted registry record opts into the actl-managed branch. */
export function hasActlManagedDriver(rec: WorkerRegistryRecord): boolean {
  return rec.driverOptions?.actl !== undefined;
}

export interface WorkerRegistryRecord {
  schemaVersion: typeof WORKER_REGISTRY_SCHEMA_VERSION;
  workerId: string;
  displayName?: string;
  launchCommand: string;
  launchArgsPrefix: string[];
  workingDirectory?: string;
  capabilities?: string[];
  /**
   * Phase H G.2 — registered observation adapter id for CLOSED-LOOP / AUTO-OBSERVED dispatch.
   * Required for normal H dispatch; may be omitted for explicitly non-observed internal/test workers.
   * NEVER derived from workerId; NEVER accepted from Task/Goal narrative.
   */
  observationAdapterId?: string;
  /**
   * Phase I — driver-specific execution options (trusted registry only).
   * Contains only narrowly typed configuration; never arbitrary CLI flags.
   */
  driverOptions?: WorkerDriverOptions;
  /**
   * V1.6 Slice 3 additive — tags this registry entry's role (§10 Q14/Q15).
   * Absent ≡ 'implementation' (today's only meaning; every existing untagged
   * row remains valid). A worker tagged 'qa' is eligible to be resolved as a
   * Semantic QA Agent (qa-semantic-evaluator.ts); it is NOT thereby excluded
   * from also being used for implementation dispatch — this is a capability
   * tag, not a partition. A local-model or cheap-cloud QA worker later is a
   * new registry row with role:'qa', never a code change.
   */
  role?: 'implementation' | 'qa';
}

/** Safe public view — never includes launchCommand / cwd / env / absolute paths. */
export interface WorkerRegistryPublicView {
  workerId: string;
  displayName?: string;
  capabilities?: string[];
  observationAdapterId?: string;
}

export class WorkerRegistryError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_STATE';
  constructor(code: WorkerRegistryError['code'], message: string) {
    super(message);
    this.name = 'WorkerRegistryError';
    this.code = code;
  }
}

const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Shell / command-string markers forbidden inside launchCommand. */
const FORBIDDEN_LAUNCH_MARKERS = /[\n\r|&;<>`$(){}]|&&|\|\|/;

export function workersRegistryDir(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '_relay', 'workers');
}

export function workerRegistryPath(dataRoot: string, workerId: string): string {
  return path.join(workersRegistryDir(dataRoot), `${workerId}.json`);
}

/** Project-scoped workers path — intentionally unused / rejected for launch config. */
export function projectWorkersDir(dataRoot: string, project: string): string {
  const root = path.resolve(dataRoot);
  if (!project || project === '.') return path.join(root, 'workers');
  return path.join(root, project, 'workers');
}

export function isSafeWorkerId(workerId: string): boolean {
  return typeof workerId === 'string' && WORKER_ID_RE.test(workerId);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

/**
 * Validate launchCommand trust:
 * - absolute executable path, OR
 * - allowlisted basename (no path separators / spaces)
 * - never a shell command string
 */
export function validateLaunchCommand(launchCommand: string): void {
  const cmd = requireNonEmptyString(launchCommand, 'launchCommand');
  if (FORBIDDEN_LAUNCH_MARKERS.test(cmd)) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      'launchCommand must be a single executable (no shell operators).',
    );
  }
  if (path.isAbsolute(cmd)) {
    // Absolute path may contain spaces; reject only if it embeds extra argv-like tokens via tabs.
    if (cmd.includes('\t')) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', 'launchCommand absolute path is invalid.');
    }
    return;
  }
  // Basename-only allowlist
  if (cmd.includes('/') || cmd.includes('\\') || /\s/.test(cmd)) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      'Non-absolute launchCommand must be an allowlisted executable basename.',
    );
  }
  const base = cmd.toLowerCase();
  if (!ALLOWED_EXECUTABLE_BASENAMES.has(base)) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      `launchCommand basename '${cmd}' is not in the trusted allowlist.`,
    );
  }
}

export function validateWorkingDirectory(dataRoot: string, workingDirectory: string): string {
  const cwd = requireNonEmptyString(workingDirectory, 'workingDirectory');
  const approvedRoot = path.resolve(dataRoot);
  const resolved = path.resolve(approvedRoot, cwd);
  const rootWithSep = approvedRoot.endsWith(path.sep) ? approvedRoot : approvedRoot + path.sep;
  if (resolved !== approvedRoot && !resolved.startsWith(rootWithSep)) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      'workingDirectory must resolve under dataRoot.',
    );
  }
  return resolved;
}

export function validateWorkerRegistryRecord(
  dataRoot: string,
  raw: unknown,
  expectedWorkerId?: string,
): WorkerRegistryRecord {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', 'Worker registry record must be an object.');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== WORKER_REGISTRY_SCHEMA_VERSION) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      `schemaVersion must be '${WORKER_REGISTRY_SCHEMA_VERSION}'.`,
    );
  }

  const workerId = requireNonEmptyString(obj.workerId, 'workerId');
  if (!isSafeWorkerId(workerId)) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `Invalid workerId: ${workerId}`);
  }
  if (expectedWorkerId && workerId !== expectedWorkerId) {
    throw new WorkerRegistryError(
      'INVALID_ARGUMENT',
      `workerId mismatch: file=${expectedWorkerId} record=${workerId}`,
    );
  }

  const launchCommand = requireNonEmptyString(obj.launchCommand, 'launchCommand');
  validateLaunchCommand(launchCommand);

  if (!Array.isArray(obj.launchArgsPrefix) || !obj.launchArgsPrefix.every((x) => typeof x === 'string')) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', 'launchArgsPrefix must be string[].');
  }
  const launchArgsPrefix = obj.launchArgsPrefix.map((s) => String(s));

  let workingDirectory: string | undefined;
  if (obj.workingDirectory !== undefined && obj.workingDirectory !== null) {
    workingDirectory = validateWorkingDirectory(dataRoot, String(obj.workingDirectory));
  }

  let displayName: string | undefined;
  if (obj.displayName !== undefined && obj.displayName !== null) {
    displayName = requireNonEmptyString(obj.displayName, 'displayName');
  }

  let capabilities: string[] | undefined;
  if (obj.capabilities !== undefined && obj.capabilities !== null) {
    if (!Array.isArray(obj.capabilities) || !obj.capabilities.every((x) => typeof x === 'string')) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', 'capabilities must be string[].');
    }
    capabilities = obj.capabilities.map((s) => String(s));
  }

  let observationAdapterId: string | undefined;
  if (obj.observationAdapterId !== undefined && obj.observationAdapterId !== null) {
    observationAdapterId = requireNonEmptyString(obj.observationAdapterId, 'observationAdapterId');
    // Do not hard-code adapter allowlist here — dispatch validates via adapter registry.
  }

  // Phase I / Phase 2: validate driverOptions (narrowly typed — no arbitrary flags).
  let driverOptions: WorkerDriverOptions | undefined;
  if (obj.driverOptions !== undefined && obj.driverOptions !== null) {
    if (typeof obj.driverOptions !== 'object' || Array.isArray(obj.driverOptions)) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', 'driverOptions must be an object.');
    }
    const doObj = obj.driverOptions as Record<string, unknown>;

    // Only 'claude' and 'actl' keys allowed under driverOptions.
    for (const key of Object.keys(doObj)) {
      if (key !== 'claude' && key !== 'actl') {
        throw new WorkerRegistryError(
          'INVALID_ARGUMENT',
          `Unknown driverOptions key: '${key}'. Only 'claude' and 'actl' are allowed.`,
        );
      }
    }

    let claudeDriverOpts: ClaudeDriverOptions | undefined;
    if (doObj.claude !== undefined && doObj.claude !== null) {
      if (typeof doObj.claude !== 'object' || Array.isArray(doObj.claude)) {
        throw new WorkerRegistryError('INVALID_ARGUMENT', 'driverOptions.claude must be an object.');
      }
      const claudeObj = doObj.claude as Record<string, unknown>;

      // Only trusted Claude profile, permission, and Builder verification
      // allowlist settings are allowed.
      for (const key of Object.keys(claudeObj)) {
        if (key !== 'configDir' && key !== 'permissionMode' && key !== 'allowedTools') {
          throw new WorkerRegistryError('INVALID_ARGUMENT', `Unknown driverOptions.claude key: '${key}'. Only 'configDir', 'permissionMode', and 'allowedTools' are allowed.`);
        }
      }

      const configDir = claudeObj.configDir === undefined || claudeObj.configDir === null
        ? undefined
        : requireExistingAbsoluteDirectory(claudeObj.configDir, 'driverOptions.claude.configDir');
      // Round 35: optional Builder verification allowlist. Each pattern must be
      // one of the strict verify-only shapes below; everything else fails closed.
      let allowedTools: string[] | undefined;
      if (claudeObj.allowedTools !== undefined && claudeObj.allowedTools !== null) {
        if (!Array.isArray(claudeObj.allowedTools)) {
          throw new WorkerRegistryError(
            'INVALID_ARGUMENT',
            'driverOptions.claude.allowedTools must be string[].',
          );
        }
        const seen = new Set<string>();
        allowedTools = [];
        for (const p of claudeObj.allowedTools) {
          if (typeof p !== 'string' || !p.trim()) {
            throw new WorkerRegistryError(
              'INVALID_ARGUMENT',
              'driverOptions.claude.allowedTools entries must be non-empty strings.',
            );
          }
          const pattern = p.trim();
          if (!isAllowedToolPattern(pattern)) {
            throw new WorkerRegistryError(
              'INVALID_ARGUMENT',
              'Invalid driverOptions.claude.allowedTools pattern: ' +
              `'${pattern}'. Allowed: Bash(<cmd>:*) with <cmd> in ` +
              '{node, npm, npx, git status, git diff, git log, ls, cat, head, tail, wc, grep, rg, find, test}, ' +
              'or exactly one of Read, Glob, Grep, Edit, Write.',
            );
          }
          if (seen.has(pattern)) {
            throw new WorkerRegistryError(
              'INVALID_ARGUMENT',
              `Duplicate driverOptions.claude.allowedTools pattern: '${pattern}'.`,
            );
          }
          seen.add(pattern);
          allowedTools.push(pattern);
        }
      }
      if (claudeObj.permissionMode !== undefined && claudeObj.permissionMode !== null) {
        const pm = claudeObj.permissionMode;
        // Narrow enum check — explicit rejection of dangerous bypass.
        if (pm === 'dangerously-skip-permissions') {
          throw new WorkerRegistryError(
            'INVALID_ARGUMENT',
            "driverOptions.claude.permissionMode 'dangerously-skip-permissions' is not supported. " +
            "Allowed values: 'default', 'acceptEdits'.",
          );
        }
        if (!ALLOWED_CLAUDE_PERMISSION_MODES.has(pm as ClaudePermissionMode)) {
          throw new WorkerRegistryError(
            'INVALID_ARGUMENT',
            `Invalid driverOptions.claude.permissionMode: '${String(pm)}'. ` +
            "Allowed values: 'default', 'acceptEdits'.",
          );
        }
        claudeDriverOpts = {
          ...(configDir ? { configDir } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          permissionMode: pm as ClaudePermissionMode,
        };
      } else {
        claudeDriverOpts = {
          ...(configDir ? { configDir } : {}),
          ...(allowedTools ? { allowedTools } : {}),
        };
      }
    }

    let actlDriverOpts: ActlDriverOptions | undefined;
    if (doObj.actl !== undefined && doObj.actl !== null) {
      actlDriverOpts = validateActlDriverOptions(doObj.actl);
    }

    driverOptions = {
      ...(claudeDriverOpts !== undefined ? { claude: claudeDriverOpts } : {}),
      ...(actlDriverOpts !== undefined ? { actl: actlDriverOpts } : {}),
    };
  }

  // V1.6 Slice 3 additive: role tag (§10 Q14/Q15). Absent ≡ 'implementation'.
  let role: 'implementation' | 'qa' | undefined;
  if (obj.role !== undefined && obj.role !== null) {
    if (obj.role !== 'implementation' && obj.role !== 'qa') {
      throw new WorkerRegistryError('INVALID_ARGUMENT', `Invalid role: '${String(obj.role)}'. Allowed values: 'implementation', 'qa'.`);
    }
    role = obj.role;
  }

  // Reject unknown fields that look like executable overrides from untrusted authors.
  const allowed = new Set([
    'schemaVersion',
    'workerId',
    'displayName',
    'launchCommand',
    'launchArgsPrefix',
    'workingDirectory',
    'capabilities',
    'observationAdapterId',
    'driverOptions',
    'role',
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', `Unknown worker registry field: ${key}`);
    }
  }

  // §9.1: when driverOptions.actl is present, enforce managed pairing at write time.
  if (driverOptions?.actl) {
    if (!path.isAbsolute(launchCommand)) {
      throw new WorkerRegistryError(
        'INVALID_ARGUMENT',
        'driverOptions.actl requires launchCommand to be an absolute actl executable path.',
      );
    }
    if (launchArgsPrefix.length !== 0) {
      throw new WorkerRegistryError(
        'INVALID_ARGUMENT',
        'driverOptions.actl requires launchArgsPrefix to be [] (actl bridge supplies runtime argv).',
      );
    }
    if (observationAdapterId !== 'actl-managed') {
      throw new WorkerRegistryError(
        'INVALID_ARGUMENT',
        "driverOptions.actl requires observationAdapterId='actl-managed'.",
      );
    }
  }

  return {
    schemaVersion: WORKER_REGISTRY_SCHEMA_VERSION,
    workerId,
    launchCommand,
    launchArgsPrefix,
    ...(displayName ? { displayName } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(observationAdapterId ? { observationAdapterId } : {}),
    ...(driverOptions !== undefined ? { driverOptions } : {}),
    ...(role !== undefined ? { role } : {}),
  };
}

export function loadWorkerRegistryRecord(dataRoot: string, workerId: string): WorkerRegistryRecord {
  const id = requireNonEmptyString(workerId, 'workerId');
  if (!isSafeWorkerId(id)) {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `Invalid workerId: ${id}`);
  }

  // Explicitly refuse project-scoped registry paths as a source of truth.
  const projectProbe = projectWorkersDir(dataRoot, '_any_');
  void projectProbe;

  const filePath = workerRegistryPath(dataRoot, id);
  if (!fs.existsSync(filePath)) {
    throw new WorkerRegistryError('NOT_FOUND', `Worker registry entry not found: ${id}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new WorkerRegistryError('INVALID_ARGUMENT', `Worker registry JSON unreadable: ${id}`);
  }
  return validateWorkerRegistryRecord(dataRoot, raw, id);
}

export function listWorkerRegistryRecords(dataRoot: string): WorkerRegistryRecord[] {
  const dir = workersRegistryDir(dataRoot);
  if (!fs.existsSync(dir)) return [];
  const out: WorkerRegistryRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const workerId = name.slice(0, -'.json'.length);
    if (!isSafeWorkerId(workerId)) continue;
    try {
      out.push(loadWorkerRegistryRecord(dataRoot, workerId));
    } catch {
      // Skip invalid entries deterministically (do not throw entire list).
    }
  }
  return out.sort((a, b) => a.workerId.localeCompare(b.workerId));
}

export function toPublicWorkerView(rec: WorkerRegistryRecord): WorkerRegistryPublicView {
  return {
    workerId: rec.workerId,
    ...(rec.displayName ? { displayName: rec.displayName } : {}),
    ...(rec.capabilities ? { capabilities: [...rec.capabilities] } : {}),
    ...(rec.observationAdapterId ? { observationAdapterId: rec.observationAdapterId } : {}),
  };
}

/** Test/admin helper — writes a trusted registry record under dataRoot/_relay/workers. */
export function writeWorkerRegistryRecord(dataRoot: string, record: WorkerRegistryRecord): string {
  const validated = validateWorkerRegistryRecord(dataRoot, record, record.workerId);
  const dir = workersRegistryDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = workerRegistryPath(dataRoot, validated.workerId);
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 2), 'utf8');
  return filePath;
}
