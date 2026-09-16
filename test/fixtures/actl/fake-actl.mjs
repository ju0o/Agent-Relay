#!/usr/bin/env node
/**
 * Deterministic fake actl JSON CLI for Phase 2 Relay bridge tests.
 * Speaks: actl runtime <op> --request-stdin
 * No live Codex / tmux / operational state.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv[0] !== 'runtime' || argv[2] !== '--request-stdin') {
  process.stderr.write('Usage: fake-actl runtime <op> --request-stdin\n');
  process.exit(3);
}
const cliOp = argv[1];

const STATE_DIR = process.env.FAKE_ACTL_STATE_DIR
  ? path.resolve(process.env.FAKE_ACTL_STATE_DIR)
  : path.join(process.cwd(), '.fake-actl-state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { reservations: {}, commands: {}, sent: false, collectCount: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function envelope(requestId, ok, data, error) {
  return {
    contractVersion: 1,
    requestId,
    ok,
    observedAt: new Date().toISOString(),
    ...(data ? { data } : {}),
    ...(error ? { error } : {}),
  };
}

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

const raw = await readStdin();
let request;
try {
  request = JSON.parse(raw);
} catch (err) {
  emit(envelope(null, false, null, { code: 'INVALID_ARGUMENT', detail: `invalid JSON: ${err}` }), 3);
}

if (!request || typeof request !== 'object') {
  emit(envelope(null, false, null, { code: 'INVALID_ARGUMENT', detail: 'request must be object' }), 3);
}

const requestId = request.requestId ?? null;
if (request.operation !== cliOp) {
  emit(envelope(requestId, false, null, {
    code: 'INVALID_ARGUMENT',
    detail: `operation mismatch: body=${request.operation} cli=${cliOp}`,
  }), 3);
}
if (request.contractVersion !== 1) {
  emit(envelope(requestId, false, null, { code: 'INVALID_ARGUMENT', detail: 'contractVersion must be 1' }), 3);
}

const mode = process.env.FAKE_ACTL_MODE || 'happy';
const state = loadState();

if (mode === 'status-down' && cliOp === 'status') {
  emit(envelope(requestId, false, { processState: 'DOWN' }, {
    code: 'DOWN',
    detail: 'fixture runtime down',
  }), 2);
}

if (cliOp === 'status') {
  const fixturePane = process.env.FAKE_ACTL_PANE_ID || '%fixture';
  const ctx = { ...(request.expectedContext ?? { agentKind: 'codex' }), paneId: fixturePane };
  if (mode === 'status-busy') {
    emit(envelope(requestId, true, {
      runtimeId: request.runtimeId,
      processState: 'UP',
      inputState: 'BUSY',
      context: ctx,
      identityEvidence: { paneId: fixturePane },
      currentSnapshotHash: process.env.FAKE_ACTL_SNAPSHOT || 'fixture-snapshot',
    }), 0);
  }
  emit(envelope(requestId, true, {
    runtimeId: request.runtimeId,
    processState: 'UP',
    inputState: 'READY',
    context: ctx,
    identityEvidence: { paneId: fixturePane },
    currentSnapshotHash: process.env.FAKE_ACTL_SNAPSHOT || 'fixture-snapshot',
    capabilities: { 'managed.collect.final': true },
  }), 0);
}

if (cliOp === 'discover') {
  emit(envelope(requestId, true, {
    candidates: [{
      runtimeId: request.runtimeId || 'rt_fixture',
      agentKind: 'codex',
      processState: 'UP',
    }],
  }), 0);
}

if (cliOp === 'reserve') {
  const action = request.action;
  if (action === 'acquire') {
    const reservationId = 'rsv_' + crypto.randomBytes(8).toString('hex');
    const leaseToken = crypto.randomBytes(16).toString('hex');
    const fence = '1';
    const fixturePane = process.env.FAKE_ACTL_PANE_ID || '%fixture';
    const frozenContext = {
      ...(request.expectedContext && typeof request.expectedContext === 'object' ? request.expectedContext : {}),
      paneId: (request.expectedContext && request.expectedContext.paneId) || fixturePane,
    };
    state.reservations[reservationId] = {
      reservationId,
      leaseToken,
      fence,
      runtimeId: request.runtimeId,
      state: 'HELD',
      paneId: frozenContext.paneId,
      context: frozenContext,
    };
    saveState(state);
    emit(envelope(requestId, true, {
      reservationId,
      leaseToken,
      fence,
      expiresBootNs: '999999999999',
      runtimeId: request.runtimeId,
      mode: 'MANAGED',
      context: frozenContext,
      inputState: 'READY',
      observationCursor: { kind: 'BOOTSTRAP', runtimeId: request.runtimeId },
      currentSnapshotHash: process.env.FAKE_ACTL_SNAPSHOT || 'fixture-snapshot',
    }), 0);
  }
  if (action === 'release') {
    const held = state.reservations[request.reservationId];
    if (!held || held.leaseToken !== request.leaseToken || String(held.fence) !== String(request.fence)) {
      emit(envelope(requestId, false, null, { code: 'BUSY', detail: 'stale reservation credentials', sideEffect: 'NONE' }), 2);
    }
    if (held.state === 'RELEASED') {
      emit(envelope(requestId, false, null, {
        code: 'INVALID_ARGUMENT', detail: 'reservation already released', sideEffect: 'NONE',
      }), 3);
    }
    if (held.commandAttached) {
      const ack = request.captureAck;
      const validFinal = ack && ack.kind === 'FINAL_CAPTURE' && ack.acknowledged === true && ack.resultId;
      const validReconcile = ack && ack.kind === 'RECONCILE' && ack.commandId && ack.acknowledged === true
        && ['FAILED', 'CANCEL_REQUESTED', 'DELIVERY_AMBIGUOUS'].includes(ack.disposition);
      if (!validFinal && !validReconcile) {
        emit(envelope(requestId, false, null, { code: 'INVALID_ARGUMENT', detail: 'captureAck required when commands are attached', sideEffect: 'NONE' }), 3);
      }
      held.captureAck = ack;
    }
    held.state = 'RELEASED';
    saveState(state);
    emit(envelope(requestId, true, {
      reservationId: request.reservationId,
      runtimeId: request.runtimeId,
      state: 'RELEASED',
      releasedAt: new Date().toISOString(),
    }), 0);
  }
  if (action === 'renew') {
    emit(envelope(requestId, true, {
      reservationId: request.reservationId,
      leaseToken: request.leaseToken,
      fence: request.fence,
      runtimeId: request.runtimeId,
    }), 0);
  }
  emit(envelope(requestId, false, null, { code: 'INVALID_ARGUMENT', detail: 'bad reserve action' }), 3);
}

if (cliOp === 'send') {
  state.sendCount = (state.sendCount || 0) + 1;
  saveState(state);

  // Fail closed on remapped/stale pane or snapshot before any "input".
  const rsv = state.reservations[request.reservationId];
  const sendPane = request.expectedContext && request.expectedContext.paneId;
  if (!sendPane) {
    emit(envelope(requestId, false, null, {
      code: 'INVALID_ARGUMENT',
      detail: 'expectedContext.paneId is required for send',
      sideEffect: 'NONE',
    }), 3);
  }
  if (rsv && rsv.paneId && sendPane !== rsv.paneId) {
    emit(envelope(requestId, false, null, {
      code: 'MISMATCH',
      detail: `send paneId ${sendPane} != reserved paneId ${rsv.paneId}`,
      sideEffect: 'NONE',
    }), 2);
  }
  if (mode === 'stale-snapshot' || (
    request.currentSnapshotHash
    && process.env.FAKE_ACTL_LIVE_SNAPSHOT
    && request.currentSnapshotHash !== process.env.FAKE_ACTL_LIVE_SNAPSHOT
  )) {
    emit(envelope(requestId, false, null, {
      code: 'INPUT_STATE_UNKNOWN',
      detail: 'pane snapshot changed before send',
      sideEffect: 'NONE',
      retryAction: 'refresh_input_permit',
    }), 2);
  }
  if (mode === 'stale-fence' || (rsv && request.fence && String(request.fence) !== String(rsv.fence))) {
    emit(envelope(requestId, false, null, {
      code: 'BUSY',
      detail: 'stale fence',
      sideEffect: 'NONE',
    }), 2);
  }
  if (mode === 'wrong-runtime' || (request.runtimeId && rsv && rsv.runtimeId && request.runtimeId !== rsv.runtimeId)) {
    emit(envelope(requestId, false, null, {
      code: 'MISMATCH',
      detail: 'runtimeId does not match reservation',
      sideEffect: 'NONE',
    }), 2);
  }

  if (mode === 'hang-send') {
    // Never respond — Relay invoke timeout / SIGKILL path.
    await new Promise(() => {});
  }
  if (mode === 'ambiguous-send') {
    emit(envelope(requestId, false, { commandId: request.commandId }, {
      code: 'DELIVERY_AMBIGUOUS',
      detail: 'fixture ambiguous send',
      sideEffect: 'POSSIBLE_INPUT',
      retryAction: 'query_same_command_do_not_resend',
    }), 2);
  }
  if (mode === 'possible-input-busy') {
    emit(envelope(requestId, false, null, {
      code: 'BUSY',
      detail: 'fixture busy after possible input',
      sideEffect: 'POSSIBLE_INPUT',
    }), 2);
  }
  if (mode === 'reject-send' || mode === 'reject-send-clean') {
    emit(envelope(requestId, false, null, {
      code: 'BUSY',
      detail: 'fixture rejected send cleanly',
      sideEffect: 'NONE',
    }), 2);
  }
  state.sent = true;
  state.lastSendPaneId = sendPane;
  state.commands[request.commandId] = {
    commandId: request.commandId,
    runtimeId: request.runtimeId,
    stage: 'TRANSPORT_SENT',
    wirePrompt: request.wirePrompt,
    paneId: sendPane,
    sessionId: null,
    turnId: null,
  };
  if (rsv) rsv.commandAttached = true;
  saveState(state);
  emit(envelope(requestId, true, {
    commandId: request.commandId,
    stage: 'TRANSPORT_SENT',
    observationCursor: request.observationCursor,
    transportReceipt: { ok: true, fixture: true, paneId: sendPane },
  }), 0);
}

if (cliOp === 'collect') {
  if (!state.sent && (mode === 'happy' || mode === 'final-same-poll')) {
    emit(envelope(requestId, false, null, {
      code: 'RESULT_NOT_FINAL',
      detail: 'no send yet',
    }), 2);
  }
  state.collectCount = (state.collectCount || 0) + 1;
  const cmd = state.commands[request.commandId] || {
    commandId: request.commandId,
    runtimeId: request.runtimeId,
    stage: 'TRANSPORT_SENT',
  };

  const resultId = 'res1_' + crypto.createHash('sha256').update(String(request.commandId)).digest('hex');
  const makeFinal = () => ({
    contractVersion: 1,
    resultId,
    commandId: request.commandId,
    runtimeId: request.runtimeId,
    sessionId: 'sess_fixture_1',
    turnId: 'turn_fixture_1',
    observedAt: new Date().toISOString(),
    completionKind: 'RESPONSE_COMPLETE',
    rawFinalText: process.env.FAKE_ACTL_FINAL_TEXT || 'ACTL_TEST_OK',
  });

  // Same poll: AGENT_RECEIVED evidence + FINAL together.
  if (mode === 'final-same-poll') {
    cmd.stage = 'FINAL';
    cmd.sessionId = 'sess_fixture_1';
    cmd.turnId = 'turn_fixture_1';
    state.commands[request.commandId] = cmd;
    saveState(state);
    emit(envelope(requestId, true, {
      command: { ...cmd, stage: 'FINAL', resultId },
      final: makeFinal(),
    }), 0);
  }

  // First collect → AGENT_RECEIVED; second → FINAL (default happy path).
  if (state.collectCount === 1 || mode === 'received-only') {
    cmd.stage = 'AGENT_RECEIVED';
    cmd.sessionId = 'sess_fixture_1';
    cmd.turnId = 'turn_fixture_1';
    state.commands[request.commandId] = cmd;
    saveState(state);
    emit(envelope(requestId, true, {
      command: { ...cmd },
    }), 0);
  }

  cmd.stage = 'FINAL';
  cmd.sessionId = 'sess_fixture_1';
  cmd.turnId = 'turn_fixture_1';
  const final = makeFinal();
  state.commands[request.commandId] = cmd;
  saveState(state);
  emit(envelope(requestId, true, {
    command: { ...cmd, resultId },
    final,
  }), 0);
}

if (cliOp === 'interrupt') {
  emit(envelope(requestId, true, {
    commandId: request.commandId,
    stage: 'CANCEL_REQUESTED',
  }), 0);
}

emit(envelope(requestId, false, null, {
  code: 'INVALID_ARGUMENT',
  detail: `unsupported op ${cliOp}`,
}), 3);
