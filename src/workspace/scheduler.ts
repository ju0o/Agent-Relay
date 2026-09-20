/**
 * Lane scheduler — concurrency governor with acquire/release semantics.
 *
 * Global defaults (workspace concurrency policy): max Builders = 2,
 * max QA = 1. Connected panes may all stay alive; READY does not mean
 * RUNNING. A lane RUNs only while holding its slots; HUMAN_GATE parks
 * only the gated lane, other independent lanes continue.
 */
export interface SchedulerLimits {
  maxActiveBuilders: number;
  maxActiveQa: number;
}

export type SlotKind = 'builder' | 'qa';

export interface SchedulerSnapshot {
  limits: SchedulerLimits;
  builders: string[];
  qa: string[];
  parked: string[];
}

export class LaneScheduler {
  private builders = new Set<string>();
  private qa = new Set<string>();
  private parked = new Set<string>();

  constructor(private readonly limits: SchedulerLimits) {
    if (limits.maxActiveBuilders < 1 || limits.maxActiveQa < 1) {
      throw new Error('Scheduler limits must be >= 1');
    }
  }

  /** Try to take a slot. Returns true on grant, false when the cap is hit
   *  (caller keeps the lane WAITING — never over-admits). */
  acquire(laneId: string, kind: SlotKind): boolean {
    if (this.parked.has(laneId)) return false;
    if (kind === 'builder') {
      if (this.builders.has(laneId)) return true;
      if (this.builders.size >= this.limits.maxActiveBuilders) return false;
      this.builders.add(laneId);
      return true;
    }
    if (this.qa.has(laneId)) return true;
    if (this.qa.size >= this.limits.maxActiveQa) return false;
    this.qa.add(laneId);
    return true;
  }

  release(laneId: string, kind?: SlotKind): void {
    if (!kind || kind === 'builder') this.builders.delete(laneId);
    if (!kind || kind === 'qa') this.qa.delete(laneId);
  }

  /** HUMAN_GATE: park only this lane (slots freed); others continue. */
  park(laneId: string): void {
    this.release(laneId);
    this.parked.add(laneId);
  }

  unpark(laneId: string): void {
    this.parked.delete(laneId);
  }

  isParked(laneId: string): boolean {
    return this.parked.has(laneId);
  }

  snapshot(): SchedulerSnapshot {
    return {
      limits: { ...this.limits },
      builders: [...this.builders],
      qa: [...this.qa],
      parked: [...this.parked],
    };
  }
}
