import { useState, useMemo } from 'react';

type Props = {
  entries: HarnessDirEntry[];
  onSelectFile?: (relativePath: string) => void;
  onRefresh?: () => void;
  loading?: boolean;
};

interface TreeNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  children: Map<string, TreeNode>;
}

function buildTree(entries: HarnessDirEntry[]): TreeNode {
  const rootNode: TreeNode = {
    name: '',
    relativePath: '',
    type: 'directory',
    size: 0,
    children: new Map(),
  };

  for (const entry of entries) {
    const parts = entry.name.split(/[\\/]/);
    let current = rootNode;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentRel = parts.slice(0, i + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          relativePath: currentRel,
          type: isLast ? entry.type : 'directory',
          size: isLast ? entry.size : 0,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }

  return rootNode;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">TS</span>;
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">JS</span>;
    case 'json':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">{}</span>;
    case 'md':
    case 'txt':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">MD</span>;
    case 'py':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">PY</span>;
    case 'css':
    case 'scss':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">CSS</span>;
    case 'csv':
    case 'xlsx':
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">XS</span>;
    default:
      return <span className="text-[var(--text-tertiary)] font-mono text-xs">·</span>;
  }
}

function TreeItem({
  node,
  depth,
  collapsed,
  toggleCollapse,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggleCollapse: (path: string) => void;
  onSelectFile?: (path: string) => void;
}) {
  const isDir = node.type === 'directory';
  const isCollapsed = collapsed.has(node.relativePath);
  const childList = Array.from(node.children.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      <div
        onClick={() => {
          if (isDir) {
            toggleCollapse(node.relativePath);
          } else {
            onSelectFile?.(node.relativePath);
          }
        }}
        className="group flex items-center justify-between py-1.5 px-2 rounded-[var(--radius-sm)] text-sm cursor-pointer select-none transition-colors hover:bg-[var(--bg-surface-raised)]"
        style={{ paddingLeft: `${Math.max(depth * 14, 8)}px` }}
        title={node.relativePath}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isDir ? (
            <span className="text-[var(--text-secondary)] shrink-0 text-xs">
              {isCollapsed ? '📁' : '📂'}
            </span>
          ) : (
            <span className="shrink-0 w-4 text-center flex items-center justify-center">
              {getFileIcon(node.name)}
            </span>
          )}
          <span className={`truncate text-sm ${isDir ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'}`}>
            {node.name}
          </span>
        </div>

        {!isDir && node.size > 0 && (
          <span className="text-xs text-[var(--text-tertiary)] font-mono shrink-0 ml-1.5">
            {formatBytes(node.size)}
          </span>
        )}
      </div>

      {isDir && !isCollapsed && (
        <div>
          {childList.map((child) => (
            <TreeItem
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ entries, onSelectFile, onRefresh, loading = false }: Props) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const filteredEntries = useMemo(() => {
    if (!filter.trim()) return entries;
    const lower = filter.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(lower));
  }, [entries, filter]);

  const treeRoot = useMemo(() => buildTree(filteredEntries), [filteredEntries]);
  const topLevelChildren = Array.from(treeRoot.children.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex flex-col h-full overflow-hidden text-xs">
      <div className="flex items-center gap-1.5 pb-2 shrink-0">
        <div className="relative flex-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="w-full bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-2.5 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              ✕
            </button>
          )}
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            className="w-6 h-6 rounded-[var(--radius-sm)] neu-button flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0 disabled:opacity-40"
            title="Refresh tree"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={loading ? 'animate-spin' : ''}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-0.5 min-h-0">
        {topLevelChildren.length === 0 ? (
          <div className="text-xs text-[var(--text-tertiary)] text-center py-4">
            {filter ? 'No matching files' : 'Empty directory'}
          </div>
        ) : (
          topLevelChildren.map((node) => (
            <TreeItem
              key={node.relativePath}
              node={node}
              depth={0}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              onSelectFile={onSelectFile}
            />
          ))
        )}
      </div>
    </div>
  );
}
