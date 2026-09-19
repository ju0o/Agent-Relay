/**
 * WORKSPACE SHELL V0 — AppShell.
 *
 * Owns project/binding selection + the single read-adapter load.
 * READ-ONLY: only calls loadWorkspaceViewModel (read ops). No mutation
 * buttons exist anywhere under this shell.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { hasBridge, must } from '../bridge.js';
import type { ProjectInfo, SettingsView } from '../../shared/types.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import {
  emptyWorkspaceViewModel,
  loadWorkspaceViewModel,
  type WorkspaceViewModel,
} from '../features/relay/workspace-adapter.js';
import { listChatBindings, type ChatBinding } from '../features/chat/chat-bindings.js';
import type { SidebarProject } from '../features/projects/ProjectSidebar.js';
import './workspace.css';

interface Props {
  onBack: () => void;
}

export function AppShell(props: Props): React.ReactElement {
  const [dataRoot, setDataRoot] = useState('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState('');
  const [bindingsByProject, setBindingsByProject] = useState<Record<string, ChatBinding[]>>({});
  const [activeBindingId, setActiveBindingId] = useState('');
  const [vm, setVm] = useState<WorkspaceViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected] = useState(() => hasBridge());

  // Boot: settings + projects (read-only).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await must<SettingsView>({ op: 'settings:get' });
        if (cancelled) return;
        setDataRoot(s.dataRoot);
        if (!s.dataRoot) return;
        const list = await must<ProjectInfo[]>({ op: 'projects:list', dataRoot: s.dataRoot });
        if (cancelled) return;
        setProjects(list);
        const first = s.lastProject && list.some((p) => p.name === s.lastProject)
          ? s.lastProject
          : (list[0]?.name ?? '');
        if (first) selectProject(first);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProject = useCallback(
    (name: string) => {
      setActiveProject(name);
      const bindings = listChatBindings(name);
      setBindingsByProject((prev) => ({ ...prev, [name]: bindings }));
      setActiveBindingId(bindings[0]?.id ?? '');
      void refreshVm(name);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataRoot],
  );

  async function refreshVm(projectName: string): Promise<void> {
    const root = dataRootRef.current;
    if (!root || !projectName) return;
    setLoading(true);
    setError(null);
    try {
      const info = projectsRef.current.find((p) => p.name === projectName);
      const model = await loadWorkspaceViewModel(root, {
        name: projectName,
        path: info?.path ?? projectName,
      });
      setVm(model);
    } catch (e) {
      setVm(emptyWorkspaceViewModel({ name: projectName, path: projectName }));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Refs so selectProject/refreshVm read latest without dep churn.
  const dataRootRef = React.useRef(dataRoot);
  dataRootRef.current = dataRoot;
  const projectsRef = React.useRef(projects);
  projectsRef.current = projects;

  // Reload when dataRoot arrives after boot.
  useEffect(() => {
    if (dataRoot && activeProject) void refreshVm(activeProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRoot]);

  const bindings: ChatBinding[] = useMemo(
    () => bindingsByProject[activeProject] ?? (activeProject ? listChatBindings(activeProject) : []),
    [bindingsByProject, activeProject],
  );

  const sidebarProjects: SidebarProject[] = useMemo(
    () =>
      projects.map((p) => ({
        name: p.name,
        path: p.path,
        bindings: p.name === activeProject ? bindings : listChatBindings(p.name),
        statusKind:
          p.name === activeProject && vm?.currentTask
            ? vm.executionState === 'BLOCKED'
              ? 'BLOCKED'
              : vm.pmState === 'ACCEPTED'
                ? 'ACCEPTED'
                : vm.executionState === 'READY'
                  ? 'READY'
                  : 'RUNNING'
            : 'IDLE',
      })),
    [projects, activeProject, bindings, vm],
  );

  function handleSelectBinding(projectName: string, bindingId: string): void {
    if (projectName !== activeProject) {
      selectProject(projectName);
      // After project switch, select the requested binding.
      setTimeout(() => setActiveBindingId(bindingId), 0);
      return;
    }
    setActiveBindingId(bindingId);
  }

  return (
    <WorkspaceLayout
      projects={sidebarProjects}
      activeProject={activeProject}
      bindings={bindings}
      activeBindingId={activeBindingId || bindings[0]?.id || ''}
      onSelectProject={(n) => selectProject(n)}
      onSelectBinding={handleSelectBinding}
      onSelectCenterBinding={(id) => setActiveBindingId(id)}
      vm={vm}
      loading={loading}
      error={error}
      connected={connected}
      onBack={props.onBack}
    />
  );
}
