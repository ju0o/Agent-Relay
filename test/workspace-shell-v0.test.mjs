/**
 * WORKSPACE SHELL V0 — focused frontend tests (read-only).
 *
 * Covers: project/binding selection data, goal/task rendering data,
 * status label mapping, same-task/multiple-run history, CHANGES reason,
 * retryInstruction, ACCEPT display, no-mutation guarantee, empty + blocked.
 *
 * Backend tests remain untouched. Run: node --test test/workspace-shell-v0.test.mjs
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-workspace-shell-v0');

const MUTATION_OPS = [
  'goal:create',
  'goal:update',
  'goal:transition',
  'goal:complete',
  'task:create',
  'task:dispatch',
  'task:update',
  'task:linkRun',
  'task:unlinkRun',
  'task:transitionExecution',
  'task:transitionPm',
  'task:markResultReceived',
  'task:acceptResult',
  'task:requestChanges',
  'task:requestRetry',
  'task:resolveOrphan',
  'capture:arm',
  'capture:disarm',
  'capture:select',
  'run:materialize',
  'prompt:save',
  'result:save',
  'projects:create',
  'project:delete',
  'run:delete',
  'evidence:record',
  'event:markDelivered',
  'event:acknowledge',
  'event:ignore',
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let labels = null;
let adapter = null;
let bindings = null;

before(() => {
  // Compile pure TS modules to CJS for behavioral tests (no new deps).
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  execFileSync(
    'npx',
    [
      'tsc',
      'src/frontend/features/shared/status-labels.ts',
      'src/frontend/features/relay/workspace-adapter.ts',
      'src/frontend/features/chat/chat-bindings.ts',
      'src/frontend/bridge.ts',
      'src/shared/types.ts',
      '--outDir',
      'test/.tmp-workspace-shell-v0',
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--lib',
      'es2020,dom',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--skipLibCheck',
      '--strict',
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  labels = require(path.join(TMP, 'frontend/features/shared/status-labels.js'));
  adapter = require(path.join(TMP, 'frontend/features/relay/workspace-adapter.js'));
  bindings = require(path.join(TMP, 'frontend/features/chat/chat-bindings.js'));
});

describe('workspace-shell-v0: status label mapping', () => {
  it('maps technical states to Korean (5)', () => {
    assert.equal(labels.statusLabel('READY'), '작업 준비됨');
    assert.equal(labels.statusLabel('RUNNING'), '작업 중');
    assert.equal(labels.statusLabel('RESULT_RECEIVED'), '결과 도착');
    assert.equal(labels.statusLabel('VERIFYING'), 'PM 검토 중');
    assert.equal(labels.statusLabel('CHANGES_REQUESTED'), '수정 필요');
    assert.equal(labels.statusLabel('ACCEPTED'), '완료 승인');
    assert.equal(labels.statusLabel('BLOCKED'), '진행 막힘');
    assert.equal(labels.statusLabel('OWNER_REQUIRED'), '사용자 확인 필요');
  });

  it('derives workspace status without duplicating transitions', () => {
    const d = labels.deriveWorkspaceStatus;
    assert.equal(d({ executionState: 'RUNNING', pmState: 'PENDING', hasCurrentTask: true }), 'RUNNING');
    assert.equal(d({ executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING', hasCurrentTask: true }), 'VERIFYING');
    assert.equal(d({ executionState: 'RESULT_RECEIVED', pmState: 'CHANGES_REQUESTED', hasCurrentTask: true }), 'CHANGES_REQUESTED');
    assert.equal(d({ executionState: 'BLOCKED', pmState: 'PENDING', hasCurrentTask: true }), 'BLOCKED');
    assert.equal(d({ hasCurrentTask: false }), 'IDLE');
  });

  it('blocked state maps to 진행 막힘 (12)', () => {
    assert.equal(labels.statusLabel('BLOCKED'), '진행 막힘');
    assert.equal(labels.statusDotTone('BLOCKED'), 'blocked');
  });
});

describe('workspace-shell-v0: view model (project/goal/task)', () => {
  const proj = { name: 'Juceipt', path: '/tmp/Juceipt' };
  const goal = (id, status) => ({
    schemaVersion: 2,
    goalId: id,
    project: 'Juceipt',
    title: `goal ${id}`,
    goalStatement: 'stmt',
    status,
    completionCriteria: [],
    permissionPolicy: { mode: 'PLAN' },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
  });
  const task = (id, exec, pm, seq = [1]) => ({
    schemaVersion: 2,
    taskId: id,
    goalId: 'GOAL-1',
    project: 'Juceipt',
    title: `task ${id}`,
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: [],
    executionState: exec,
    pmState: pm,
    dependencies: [],
    linkedRuns: seq.map((s) => ({ runId: `RUN-${id}-${s}`, folder: `/tmp/${s}`, taskRunSequence: s, agent: 'Claude Code' })),
    nextTaskRunSequence: seq.length + 1,
    createdAt: '2026-01-01',
    updatedAt: `2026-01-0${seq.length}`,
  });

  it('project selection: active project flows into view model (1)', () => {
    const vm = adapter.buildWorkspaceViewModel({
      project: proj,
      goals: [goal('GOAL-1', 'ACTIVE')],
      goalRuntime: null,
      tasks: [task('TASK-021', 'RUNNING', 'PENDING')],
      history: null,
      pendingEvents: [],
      workers: [],
    });
    assert.equal(vm.project.name, 'Juceipt'); // (1)
    assert.equal(vm.currentGoal.goalId, 'GOAL-1'); // (3)
    assert.equal(vm.currentTask.taskId, 'TASK-021'); // (4)
    assert.equal(vm.isRealRelayData, true);
  });

  it('chat binding selection is UI-only (2): bindings never enter the adapter', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/frontend/features/relay/workspace-adapter.ts'), 'utf8');
    assert.ok(!/chatBinding|ChatBinding/i.test(src), 'adapter must not know ChatBinding');
    const store = fs.readFileSync(path.join(ROOT, 'src/frontend/features/chat/chat-bindings.ts'), 'utf8');
    assert.ok(/uiOnly/.test(store), 'bindings marked UI-only');
    assert.ok(/localStorage/.test(store), 'bindings stored frontend-local');
    assert.ok(!/history:get|task:list|goal:list/.test(store), 'binding store issues no Relay ops');
  });

  it('current goal/task render from real records (3,4)', () => {
    const vm = adapter.buildWorkspaceViewModel({
      project: proj,
      goals: [goal('GOAL-1', 'ACTIVE')],
      goalRuntime: null,
      tasks: [task('TASK-021', 'RUNNING', 'PENDING')],
      history: null,
      pendingEvents: [{ eventId: 'E1', summary: 'wake', occurredAt: '2026-01-03' }],
      workers: [{ workerId: 'claude' }],
    });
    assert.equal(vm.currentGoal.title, 'goal GOAL-1');
    assert.equal(vm.currentTask.title, 'task TASK-021');
    assert.equal(vm.executionState, 'RUNNING');
    assert.equal(vm.pmState, 'PENDING');
    assert.equal(vm.worker.label, 'Claude Code');
    assert.equal(vm.pmActivity.pendingCount, 1);
  });

  it('empty state: no goal/task → idle, never throws (11)', () => {
    const vm = adapter.buildWorkspaceViewModel({
      project: proj,
      goals: [],
      goalRuntime: null,
      tasks: [],
      history: null,
      pendingEvents: [],
      workers: [],
    });
    assert.equal(vm.currentGoal, null);
    assert.equal(vm.currentTask, null);
    assert.equal(vm.nextAction, '새 목표 대기');
    assert.equal(vm.isRealRelayData, false);
    assert.equal(labels.deriveWorkspaceStatus({ hasCurrentTask: false }), 'IDLE');
  });

  it('blocked state surfaces 해소 hint (12)', () => {
    const vm = adapter.buildWorkspaceViewModel({
      project: proj,
      goals: [goal('GOAL-1', 'ACTIVE')],
      goalRuntime: null,
      tasks: [task('TASK-021', 'BLOCKED', 'PENDING')],
      history: null,
      pendingEvents: [],
      workers: [],
    });
    assert.equal(vm.nextAction, '막힘 해소 필요');
  });
});

describe('workspace-shell-v0: history (same task / multiple runs)', () => {
  const mkHistory = () => ({
    task: {
      taskId: 'TASK-021',
      title: 'Receipt 생성 오류 수정',
      executionState: 'RESULT_RECEIVED',
      pmState: 'CHANGES_REQUESTED',
      acceptedRunId: undefined,
      goalId: 'GOAL-1',
    },
    attempts: [
      {
        taskRunSequence: 1,
        runId: 'RUN-1',
        folder: '/tmp/1',
        agent: 'Claude Code',
        folderExists: true,
        hasPrompt: true,
        hasResult: true,
        tags: [],
        delivery: { deliveryId: 'D1', status: 'DELIVERED', deliveredAt: '2026-01-01' },
        judgment: { judgmentId: 'J1', decision: 'CHANGES', status: 'APPLIED', reason: '영수증 합계가 틀림 — 최소 10자 이상 사유', retryInstruction: '합계 로직을 다시 계산하고 테스트를 추가하세요' },
      },
      {
        taskRunSequence: 2,
        runId: 'RUN-2',
        folder: '/tmp/2',
        agent: 'Claude Code',
        folderExists: true,
        hasPrompt: true,
        hasResult: true,
        tags: [],
        delivery: { deliveryId: 'D2', status: 'DELIVERED', deliveredAt: '2026-01-02' },
        judgment: null,
      },
    ],
    events: [],
    evidence: [],
  });

  it('same task keeps multiple runs in sequence order (6)', () => {
    const h = adapter.toWorkspaceHistory(mkHistory());
    assert.equal(h.taskId, 'TASK-021'); // not flattened into separate tasks
    assert.equal(h.attempts.length, 2);
    assert.deepEqual(h.attempts.map((a) => a.seq), [1, 2]);
    assert.deepEqual(h.attempts.map((a) => a.runId), ['RUN-1', 'RUN-2']);
  });

  it('CHANGES reason display (7)', () => {
    const h = adapter.toWorkspaceHistory(mkHistory());
    assert.match(h.attempts[0].judgmentReason, /영수증 합계/);
  });

  it('retryInstruction display (8)', () => {
    const h = adapter.toWorkspaceHistory(mkHistory());
    assert.match(h.attempts[0].retryInstruction, /합계 로직/);
  });

  it('ACCEPT display keeps winner without deleting other attempts (9)', () => {
    const base = mkHistory();
    base.task.pmState = 'ACCEPTED';
    base.task.acceptedRunId = 'RUN-2';
    base.attempts[1].judgment = { judgmentId: 'J2', decision: 'ACCEPT', status: 'APPLIED', reason: '합계 수정 확인됨' };
    const h = adapter.toWorkspaceHistory(base);
    assert.equal(h.attempts.length, 2); // loser preserved
    assert.equal(h.attempts[1].isAccepted, true);
    assert.equal(h.attempts[0].isAccepted, false);
    assert.equal(h.acceptedRunId, 'RUN-2');
  });

  it('backend history model carries retryInstruction (read path)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/backend/task-history.ts'), 'utf8');
    assert.ok(/retryInstruction/.test(src), 'history read model must expose retryInstruction');
    assert.ok(/getRetryInstructionForDelivery/.test(src), 'read from durable intent payload');
  });
});

describe('workspace-shell-v0: chat binding truthfulness (FOUNDER FIX 01)', () => {
  function stubLocalStorage() {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, String(v)),
      removeItem: (k) => void mem.delete(k),
      clear: () => void mem.clear(),
    };
  }

  it('seed never claims connected without a chatUrl', () => {
    stubLocalStorage();
    for (const project of ['Juceipt', 'Controler']) {
      const list = bindings.listChatBindings(project);
      assert.ok(list.length >= 2);
      for (const b of list) {
        // Empty chatUrl cannot be connected — idle or unknown only.
        assert.ok(!b.chatUrl, 'seed has no URL');
        assert.ok(
          b.status === 'idle' || b.status === 'unknown',
          `seed binding ${b.id} must be idle/unknown, found ${b.status}`,
        );
        assert.equal(bindings.isBindingConnected(b), false);
        assert.equal(bindings.effectiveBindingStatus(b), 'idle');
      }
    }
    delete globalThis.localStorage;
  });

  it('empty chatUrl cannot be connected even when stored status lies', () => {
    const liar = {
      id: 'cb-x', projectId: 'P', name: 'PM', role: 'PM', provider: 'ChatGPT',
      chatUrl: '', status: 'connected', uiOnly: true,
    };
    assert.equal(bindings.effectiveBindingStatus(liar), 'idle');
    assert.equal(bindings.isBindingConnected(liar), false);
    const ws = {
      ...liar, chatUrl: '   ',
    };
    assert.equal(bindings.isBindingConnected(ws), false);
  });

  it('a real URL + established binding can be connected', () => {
    const real = {
      id: 'cb-x', projectId: 'P', name: 'PM', role: 'PM', provider: 'ChatGPT',
      chatUrl: 'https://chat.openai.com/c/abc', status: 'connected', uiOnly: true,
    };
    assert.equal(bindings.isBindingConnected(real), true);
    assert.equal(bindings.effectiveBindingStatus({ ...real, status: 'idle' }), 'idle');
  });

  it('unbound ChatBinding does not render active/green', () => {
    const sidebar = fs.readFileSync(
      path.join(ROOT, 'src/frontend/features/projects/ProjectSidebar.tsx'), 'utf8');
    const panel = fs.readFileSync(
      path.join(ROOT, 'src/frontend/features/chat/ChatBindingPanel.tsx'), 'utf8');
    // Renderers must go through the truthfulness guard, never raw status.
    assert.ok(/isBindingConnected/.test(sidebar), 'sidebar must use isBindingConnected');
    assert.ok(/isBindingConnected/.test(panel), 'panel must use isBindingConnected');
    assert.ok(!/b\.status\s*===\s*['"]connected['"]/.test(sidebar), 'sidebar must not map raw status to green');
    assert.ok(!/active\.status\s*===\s*['"]connected['"]/.test(panel), 'panel must not map raw status to green');
    // Green tone only behind the guard in both renderers.
    // (Project-level dots reflect Relay task state, not bindings — out of scope here.)
    for (const [name, src] of [['sidebar', sidebar], ['panel', panel]]) {
      const dotExprs = [...src.matchAll(/ws-dot[^\n]*?tone-\$\{([^}]+)\}/g)].map((m) => m[1].trim());
      const guardedAliases = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*isBindingConnected\(/g)].map((m) => m[1]);
      // Binding dots render a green/idle ternary; project dots use a plain Relay-state variable.
      const bindingDots = dotExprs.filter((e) => /'active'/.test(e));
      assert.ok(bindingDots.length > 0, `${name} has a binding dot`);
      for (const expr of bindingDots) {
        const ok =
          /isBindingConnected/.test(expr) || guardedAliases.some((a) => expr.includes(a));
        assert.ok(ok, `${name} binding dot must be guarded: ${expr}`);
      }
    }
    // Unbound selection highlight is neutral — no accent/green class for unbound.
    assert.ok(/unbound/.test(sidebar), 'sidebar distinguishes unbound bindings');
    const css = fs.readFileSync(path.join(ROOT, 'src/frontend/app/workspace.css'), 'utf8');
    assert.ok(/\.ws-binding\.unbound/.test(css), 'unbound style exists');
    assert.ok(!/\.ws-binding\.unbound[^}]*background:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))\s*;[^}]*#30[dD]158/.test(css), 'unbound never green');
  });

  it('Relay bridge connected state remains independent', () => {
    const layout = fs.readFileSync(
      path.join(ROOT, 'src/frontend/app/WorkspaceLayout.tsx'), 'utf8');
    const shell = fs.readFileSync(path.join(ROOT, 'src/frontend/app/AppShell.tsx'), 'utf8');
    // Top bar names the bridge explicitly — cannot be mistaken for chat binding.
    assert.ok(/Relay bridge/.test(layout), 'top bar must label the Relay bridge explicitly');
    assert.ok(!/['"]Connected['"]/.test(layout), 'bare "Connected" label is forbidden');
    // Bridge state comes from IPC transport only, never from a ChatBinding.
    assert.ok(/hasBridge/.test(shell), 'bridge state derives from hasBridge()');
    assert.ok(!/setConnected/.test(shell), 'bridge state is never updated from bindings');
    assert.ok(!/connected.*[Bb]inding|[Bb]inding.*connected/.test(shell), 'bridge state independent of bindings');
    const sidebar = fs.readFileSync(
      path.join(ROOT, 'src/frontend/features/projects/ProjectSidebar.tsx'), 'utf8');
    assert.ok(!/hasBridge|ws-conn/.test(sidebar), 'binding dots never read bridge state');
  });
});

describe('workspace-shell-v0: read-only guarantee', () => {
  it('no mutation call from V0 frontend tree (10)', () => {
    const roots = [
      path.join(ROOT, 'src/frontend/app'),
      path.join(ROOT, 'src/frontend/features'),
    ];
    const files = roots.flatMap((d) => (fs.existsSync(d) ? walk(d) : []));
    assert.ok(files.length >= 8, `expected V0 files, found ${files.length}`);
    const violations = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const op of MUTATION_OPS) {
        if (src.includes(`'${op}'`) || src.includes(`"${op}"`)) {
          violations.push(`${path.relative(ROOT, f)} :: ${op}`);
        }
      }
      // No direct window.relayApi mutation either.
      if (/\brelayApi\?\.(call)?\b/.test(src) && /task:|goal:|capture:|prompt:|result:/.test(src)) {
        violations.push(`${path.relative(ROOT, f)} :: raw relayApi write-shaped call`);
      }
    }
    assert.deepEqual(violations, [], `V0 must be read-only:\n${violations.join('\n')}`);
  });

  it('only read ops in the adapter loader', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/frontend/features/relay/workspace-adapter.ts'), 'utf8');
    const usedOps = [...src.matchAll(/op:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(usedOps.length > 0);
    const allowed = new Set(adapter.WORKSPACE_READ_OPS);
    for (const op of usedOps) {
      assert.ok(allowed.has(op), `adapter op must be read-only, found: ${op}`);
    }
  });
});
