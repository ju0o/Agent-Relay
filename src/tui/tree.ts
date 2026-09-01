import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TreeNode {
  name: string;
  rel: string; // relative to workspaceRoot
  isDir: boolean;
  depth: number;
  children?: TreeNode[];
}

const IGNORE = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.agent-relay',
  '.next',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
  '.tmp',
]);

const MAX_NODES = 50;
const MAX_DEPTH = 2;

export interface TreeResult {
  nodes: TreeNode[];
  truncated: boolean;
  total: number;
  visible: number;
}

export function buildTree(workspaceRoot: string): TreeResult {
  const root = path.resolve(workspaceRoot);
  let total = 0;
  let visible = 0;
  let truncated = false;
  const nodes: TreeNode[] = [];

  function walk(dir: string, depth: number, parentRel: string): TreeNode[] {
    if (depth > MAX_DEPTH) return [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    // filter ignored
    const filtered = entries.filter((e) => !IGNORE.has(e.name) && !e.name.startsWith('.agent-relay'));
    // also ignore dotfiles that are large cache? keep .gitignore etc? But spec says ignore at least those.
    // Sort: dirs first then files, alphabetical
    filtered.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const out: TreeNode[] = [];
    for (const ent of filtered) {
      if (visible >= MAX_NODES) {
        truncated = true;
        break;
      }
      const rel = parentRel ? path.join(parentRel, ent.name) : ent.name;
      total++;
      visible++;
      const node: TreeNode = {
        name: ent.name,
        rel,
        isDir: ent.isDirectory(),
        depth,
      };
      if (ent.isDirectory() && depth < MAX_DEPTH) {
        const childDir = path.join(dir, ent.name);
        const children = walk(childDir, depth + 1, rel);
        if (children.length) node.children = children;
      }
      out.push(node);
      if (visible >= MAX_NODES) {
        // count remaining for total without adding
        const remaining = filtered.length - out.length;
        total += remaining;
        // quick estimate for deeper? we just mark truncated
        truncated = true;
        break;
      }
    }
    return out;
  }

  const top = walk(root, 0, '');
  // If truncated due to max, total may be underestimated; we can keep truncated flag
  return { nodes: top, truncated, total, visible };
}
