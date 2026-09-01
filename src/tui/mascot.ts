/**
 * Minimal mascot mapping for future I3E animation.
 * Static only for I3D.
 */
export function mascotForWorker(workerId: string, adapter: string): string {
  const a = (adapter || '').toLowerCase();
  if (a.includes('claude')) return '🐙';
  if (a.includes('codex')) return '🦊';
  if (a.includes('opencode')) return '🪼';
  if (workerId === 'claude-code' || a === 'claude-code') return '🐙';
  if (workerId.toLowerCase().includes('pm')) return '🤖';
  // default PM
  return '🤖';
}

export function mascotForPm(): string {
  return '🤖';
}
