/**
 * Setup-UI descriptor surface — the same underlying Workspace config (v2)
 * a future GUI edits. Describes every editable field (key, label, kind,
 * options) so a form can be rendered without duplicating config knowledge.
 */
import { KNOWN_RUNTIMES } from './config-v2.js';

export interface ConfigFieldDescriptor {
  key: string;
  label: string;
  kind: 'text' | 'path' | 'select' | 'integer';
  options?: string[];
  required: boolean;
  help: string;
}

export function laneFieldDescriptors(): ConfigFieldDescriptor[] {
  return [
    { key: 'id', label: 'Project identity', kind: 'text', required: true, help: 'Stable lane id (never a pane number).' },
    { key: 'label', label: 'Display label', kind: 'text', required: true, help: 'Human label shown in workspace status.' },
    { key: 'root', label: 'Project root', kind: 'path', required: true, help: 'Absolute project root; verified at start.' },
    { key: 'goal', label: 'Product goal', kind: 'text', required: true, help: 'Independent product goal (one line).' },
    ...(['pm', 'builder', 'qa'] as const).flatMap((role): ConfigFieldDescriptor[] => [
      { key: `${role}.runtime`, label: `${role.toUpperCase()} runtime`, kind: 'select', options: [...KNOWN_RUNTIMES], required: true, help: 'Engine/adapter (never a model name).' },
      { key: `${role}.model`, label: `${role.toUpperCase()} model/profile`, kind: 'text', required: true, help: 'Provider-selected model or subscription profile.' },
      { key: `${role}.roleProfile.sessionPolicy`, label: `${role.toUpperCase()} session policy`, kind: 'select', options: ['persistent', 'per-task'], required: true, help: 'Reuse one session or bind per task.' },
      { key: `${role}.roleProfile.permissionProfile`, label: `${role.toUpperCase()} permission profile`, kind: 'select', options: ['read-only', 'write-workspace', 'shell'], required: true, help: 'Least-privilege workspace access.' },
    ]),
    { key: 'qaFallback.runtime', label: 'Fallback QA runtime', kind: 'select', options: [...KNOWN_RUNTIMES], required: true, help: 'Configuration-driven fallback (not hardcoded per project).' },
    { key: 'qaFallback.model', label: 'Fallback QA model/profile', kind: 'text', required: true, help: 'Model/profile for the fallback QA runtime.' },
    { key: 'concurrency.maxBuilders', label: 'Lane builder cap (override)', kind: 'integer', required: false, help: 'Optional lane-local cap within the global policy.' },
    { key: 'concurrency.maxQa', label: 'Lane QA cap (override)', kind: 'integer', required: false, help: 'Optional lane-local cap within the global policy.' },
  ];
}

export function workspaceFieldDescriptors(): ConfigFieldDescriptor[] {
  return [
    { key: 'concurrency.maxActiveBuilders', label: 'Max active Builders', kind: 'integer', required: true, help: 'Global cap (default 2). READY does not mean RUNNING.' },
    { key: 'concurrency.maxActiveQa', label: 'Max active QA', kind: 'integer', required: true, help: 'Global cap (default 1).' },
  ];
}
