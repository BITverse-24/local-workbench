# Proposals for Frontend React UI & Bridge

## Proposal 1: Add Workspace Declarations to TypeScript Bridge

- **Target:** `frontend/src/bridge.d.ts`
- **Issue:** The `window.workbench` interface does not include type definitions for workspace methods.
- **Evidence:** `frontend/src/bridge.d.ts` only declares chat and run IPC methods on `Workbench`.
- **Suggested change:**
  Add workspace methods to the `Workbench` interface:
  ```typescript
  export interface WorkspaceInfo {
    root: string;
    registeredAt: string;
  }

  export interface HarnessDirEntry {
    name: string;
    type: "file" | "directory";
    size: number;
  }

  export interface HarnessSearchMatch {
    file: string;
    lineNumber: number;
    matchingLine: string;
  }

  export interface HarnessWriteResult {
    written: string;
    backedUp: boolean;
    backupPath?: string;
    diff?: string;
  }

  export interface HarnessCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
  }

  export interface Workbench {
    // ... existing methods ...
    pickWorkspaceFolder(): Promise<string | null>;
    registerWorkspace(dirPath: string): Promise<WorkspaceInfo>;
    deregisterWorkspace(): Promise<{ ok: boolean }>;
    getCurrentWorkspace(): Promise<WorkspaceInfo | null>;
    listWorkspaceDir(path?: string): Promise<{ tool: "list_dir"; result: HarnessDirEntry[] }>;
    readWorkspaceFile(path: string): Promise<{ tool: "read_file"; result: string }>;
    searchWorkspace(query: string, path?: string): Promise<{ tool: "search"; result: HarnessSearchMatch[] }>;
    writeWorkspaceFile(path: string, content: string): Promise<{ tool: "write_file"; result: HarnessWriteResult }>;
    runWorkspaceCommand(command: string): Promise<{ tool: "run_command"; result: HarnessCommandResult }>;
    onWorkspaceEvent(listener: (event: any) => void): () => void;
  }
  ```
- **Reason:** Enables type-safe invocation of workspace harness methods throughout frontend components.
- **Impact:** Type definitions only; no runtime impact.

## Proposal 2: Add WorkspacePicker Component in Sidebar

- **Target:** `frontend/src/components/WorkspacePicker.tsx` (new file)
- **Issue:** Users have no UI mechanism to choose, view, or close an active local project workspace.
- **Evidence:** Frontend currently only supports single-file uploads via `UploadModal` and `registerAttachment`.
- **Suggested change:**
  Create `frontend/src/components/WorkspacePicker.tsx`:
  - Button with folder icon: "Open Folder" / "Change Workspace".
  - Invokes `wb.pickWorkspaceFolder()`, then calls `wb.registerWorkspace(dir)`.
  - When active, displays the folder basename (e.g. `📁 my-project`) with a "Close" button.
  - Placed in `frontend/src/components/LeftSidebar.tsx` above or beside the chat list.
- **Reason:** Provides the entry point for the user task loop specified in HARNESS.md §6 ("User selects a directory → workspace registered").
- **Impact:** Adds a clean folder selection control without altering existing chat list functionality.

## Proposal 3: Add FileTree Sidebar View

- **Target:** `frontend/src/components/FileTree.tsx` (new file)
- **Issue:** When a workspace is active, the user should be able to see the project's structure as a tree snapshot.
- **Evidence:** HARNESS.md §2 states the agent receives a directory tree at task start; presenting this tree in the UI makes the workspace context transparent to the user.
- **Suggested change:**
  Create `frontend/src/components/FileTree.tsx`:
  - Consumes `HarnessDirEntry[]` from `workspace_tree` event or `wb.listWorkspaceDir()`.
  - Renders collapsible folders and file rows with size indicators.
  - Clicking a file can preview its content or insert its relative path into the chat input.
- **Reason:** Visualizes the project structure and helps users orient when issuing instructions.
- **Impact:** Non-breaking modular component for the sidebar.

## Proposal 4: Wire Workspace State into App.tsx

- **Target:** `frontend/src/App.tsx`
- **Issue:** `App.tsx` coordinates active runs and messages, but has no state awareness of an active workspace.
- **Evidence:** When a user starts a run while a workspace is active, the agent prompt should inject the directory tree and enable the 5 harness tools.
- **Suggested change:**
  - Add `const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null)`.
  - In `useEffect`, query `wb.getCurrentWorkspace()` on launch.
  - Subscribe to `wb.onWorkspaceEvent` to update workspace state.
  - When submitting a message via `handleSend`, include `workspaceRoot: activeWorkspace?.root` in the run request or context so the agent orchestrator activates harness tools.
- **Reason:** Seamlessly ties workspace mode into chat runs so the user can prompt the agent to fix bugs, search code, and verify fixes in the open directory.
- **Impact:** Composes with existing chat without breaking attachment-based runs.
