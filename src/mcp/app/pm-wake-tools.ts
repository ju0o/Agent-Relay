/**
 * V1-G6-MCP — PM Wake MCP tools.
 *
 * New, additive tools used ONLY by the MCP App wake adapter. They reuse the
 * canonical durable pm-delivery/pm-wake kernels; they never bypass the frozen
 * PM Delivery / Verification Context / Judgment semantics.
 *
 *   relay_pm_claim_wake       — atomically claim one wake for a pending
 *                               delivery (dedupe + bounded attempts). Returns
 *                               the frozen AGENT_RELAY_PM_WAKE instruction.
 *   relay_pm_mark_wake_failed — widget reports ui/message failure → FAILED,
 *                               allowing a bounded retry.
 *   relay_pm_get_wake_status  — pure read of the additive wake record.
 *
 * None of these touch the PM Delivery record beyond reading it; delivery
 * completion still belongs to the canonical receipt/judgment path.
 */
import * as pmWake from '../../backend/pm-wake.js';
import { objectSchema, optionalString, rejectUnknownFields, requireString } from '../schemas.js';
import { mapCoreError } from '../errors.js';
import type { McpTool, PmServerContext } from '../server.js';

export function buildPmWakeTools(ctx: PmServerContext): McpTool[] {
  const { dataRoot, project } = ctx;
  return [
    {
      name: 'relay_pm_claim_wake',
      description:
        'G6-MCP: atomically claim ONE durable PM wake for a pending PM Delivery. ' +
        'Returns claimable=false when already SENT (no re-wake) or max attempts reached. ' +
        'When claimable, returns the frozen AGENT_RELAY_PM_WAKE instruction (deliveryId/project/taskId only — ' +
        'no Result text, no transcript). Writes ONLY the additive wake record; never mutates the PM Delivery.',
      inputSchema: objectSchema({ deliveryId: { type: 'string' } }, ['deliveryId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId']);
        try {
          return await pmWake.claimPmWake(dataRoot, project, requireString(args, 'deliveryId'));
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_mark_wake_failed',
      description:
        'G6-MCP: widget reports the ui/message wake attempt failed (host rejected it). ' +
        'Marks the additive wake record FAILED so a later bounded retry is allowed. ' +
        'Never mutates the PM Delivery.',
      inputSchema: objectSchema({ deliveryId: { type: 'string' }, reason: { type: 'string' } }, ['deliveryId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId', 'reason']);
        try {
          return await pmWake.markPmWakeFailed(
            dataRoot, project, requireString(args, 'deliveryId'), optionalString(args, 'reason') ?? 'widget-report',
          );
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_get_wake_status',
      description:
        'G6-MCP: pure read of the additive wake record for a delivery. ' +
        'Returns null when no wake has ever been claimed. Identity/state only.',
      inputSchema: objectSchema({ deliveryId: { type: 'string' } }, ['deliveryId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId']);
        try {
          const record = pmWake.getPmWake(dataRoot, project, requireString(args, 'deliveryId'));
          return record === null ? null : {
            deliveryId: record.deliveryId,
            project: record.project,
            taskId: record.taskId,
            status: record.status,
            attemptCount: record.attemptCount,
            lastAttemptAt: record.lastAttemptAt ?? null,
            sentAt: record.sentAt ?? null,
            failureReason: record.failureReason ?? null,
          };
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
  ];
}