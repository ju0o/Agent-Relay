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

/** Strongly typed Claude driver options. Never allows arbitrary flags or shell fragments. */
export interface ClaudeDriverOptions {
  /**
   * Claude CLI permission mode (optional).
   * If absent, preserves existing Claude default (least privilege).
   */
  permissionMode?: ClaudePermissionMode;
}

/**
 * Driver-specific execution options, keyed by driver name.
 * Stored in trusted Worker Registry only — never from Task/Goal/PM narrative.
 */
export interface WorkerDriverOptions {
  /** Options specific to the 'claude-code' driver (relay-worker-claude.mjs). */
  claude?: ClaudeDriverOptions;
}

/** Allowed permissionMode enum values for Claude driver. */
export const ALLOWED_CLAUDE_PERMISSION_MODES: ReadonlySet<ClaudePermissionMode> = new Set([
  'default',
  'acceptEdits',
]);

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

  // Phase I: validate driverOptions (narrowly typed — no arbitrary flags).
  let driverOptions: WorkerDriverOptions | undefined;
  if (obj.driverOptions !== undefined && obj.driverOptions !== null) {
    if (typeof obj.driverOptions !== 'object' || Array.isArray(obj.driverOptions)) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', 'driverOptions must be an object.');
    }
    const doObj = obj.driverOptions as Record<string, unknown>;

    // Only 'claude' key allowed under driverOptions.
    for (const key of Object.keys(doObj)) {
      if (key !== 'claude') {
        throw new WorkerRegistryError('INVALID_ARGUMENT', `Unknown driverOptions key: '${key}'. Only 'claude' is allowed.`);
      }
    }

    let claudeDriverOpts: ClaudeDriverOptions | undefined;
    if (doObj.claude !== undefined && doObj.claude !== null) {
      if (typeof doObj.claude !== 'object' || Array.isArray(doObj.claude)) {
        throw new WorkerRegistryError('INVALID_ARGUMENT', 'driverOptions.claude must be an object.');
      }
      const claudeObj = doObj.claude as Record<string, unknown>;

      // Only 'permissionMode' allowed under driverOptions.claude.
      for (const key of Object.keys(claudeObj)) {
        if (key !== 'permissionMode') {
          throw new WorkerRegistryError('INVALID_ARGUMENT', `Unknown driverOptions.claude key: '${key}'. Only 'permissionMode' is allowed.`);
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
        claudeDriverOpts = { permissionMode: pm as ClaudePermissionMode };
      } else {
        claudeDriverOpts = {};
      }
    }

    if (claudeDriverOpts !== undefined) {
      driverOptions = { claude: claudeDriverOpts };
    } else {
      driverOptions = {};
    }
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
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new WorkerRegistryError('INVALID_ARGUMENT', `Unknown worker registry field: ${key}`);
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
