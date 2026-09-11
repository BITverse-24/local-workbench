# Local Project Harness — MVP Spec

**Scope:** lets the agent work inside a user-chosen directory the way Claude Code/Codex do — list
files, read them on demand, write changes, run commands — scoped strictly to that directory. This
is the general infrastructure Flow 2 (coding task) already assumes; this spec formalizes it.

---

## 1. Non-Goals (explicitly stripped for MVP)

- ❌ Git commit/branch automation — if the folder is a git repo, use `git diff`/`git status` as a
  read-only audit trail. The agent doesn't commit, branch, or manage git state.
- ❌ Embedding-based / semantic code search — grep-style keyword search is enough for MVP. Same
  logic as deferring re-ranking in the RAG spec: don't add a retrieval model where a simple search
  does the job.
- ❌ Multi-workspace concurrent sessions — one active workspace at a time per session.
- ❌ Fine-grained per-file permissions — the whole registered directory is read/write for the
  agent, or none of it is. No file-level ACLs.
- ❌ Real-time file-watching for external edits — the agent's view of the directory is a snapshot
  taken at task start plus whatever it explicitly re-reads. No live sync daemon.
- ❌ Collaborative multi-user editing / file locking — single user per workspace.

---

## 2. Core Concept: Lazy Context, Not Full Dump

Don't preload file contents into the prompt. Mirror how Codex/Claude Code actually work:

1. At task start, the agent gets a **directory tree only** — names, types, sizes. No content.
2. The agent decides what to read via tool calls (`read_file`, `search`) based on the task.
3. Content only enters context for files the agent actually chose to open.

This keeps context usage proportional to task complexity instead of dumping an entire codebase up
front, and it's also the more honest architecture — a real coding agent doesn't need to have read
every file to start working, it needs to be able to find the right one.

---

## 3. Components

| Component | MVP choice |
|---|---|
| Workspace registration | one directory path, validated and canonicalized once |
| Directory listing | recursive walk with an ignore list (`.git`, `node_modules`, `venv`, binaries) |
| File read/write | direct filesystem calls, path-checked against workspace root on every call |
| Search | shell out to `ripgrep` (or `grep -rn` fallback) scoped to workspace root |
| Execution | reuse the existing sandbox container from Flow 2, mounted with only the workspace dir |
| Change safety | copy-on-write backup before overwrite; git diff shown if repo present |

No new services. This is a thin tool layer over the filesystem plus the sandbox you already built.

---

## 4. The One Non-Negotiable Guardrail: Path Containment

Every read, write, list, and search call must resolve the requested path, canonicalize it
(resolve `..` and symlinks), and reject anything that falls outside the registered workspace root.
This is the filesystem equivalent of the private-IP check on model endpoints — cheap to implement,
and a strong thing to demo explicitly: try to make the agent read `../../etc/passwd` on stage and
show it getting refused. That's a concrete, checkable safety claim, not just an assertion.

```
def resolve_safe(workspace_root, requested_path):
    full = (workspace_root / requested_path).resolve()
    if not full.is_relative_to(workspace_root.resolve()):
        raise PermissionError("path escapes workspace root")
    return full
```

Apply this function as the first line of every tool handler below — no exceptions, including for
the execution sandbox's working directory.

---

## 5. Tool Contract (what the agent actually calls)

Keep this to five tools — this is deliberately smaller than a full IDE-integration surface:

```
list_dir(path=".")            → [{name, type, size}], ignore-list applied
read_file(path)                → file content (reject if >~200KB, ask agent to search instead)
search(query, path=".")        → [{file, line_number, matching_line}]
write_file(path, content)      → writes, backs up previous version first, returns diff summary
run_command(command)           → executes in sandbox, cwd = workspace root, returns stdout/stderr/exit
```

`write_file`'s backup step: before overwriting, copy the existing file to
`.harness_backups/<timestamp>/<relative_path>` inside the workspace. This gives you a crude but
real undo path without building git integration — good enough for MVP, and honest about not being
a full version control system.

---

## 6. Task Loop

1. User selects a directory → workspace registered, root canonicalized and stored.
2. User gives a task ("fix the CSV parsing bug").
3. Agent calls `list_dir` to see the shape of the project, then `search` for likely-relevant
   filenames/keywords, then `read_file` on what it finds — this sequence is what makes the "context
   access" look real rather than scripted.
4. Agent proposes a change, calls `write_file`, then `run_command` to execute/verify it.
5. If verification fails, agent reads the error, edits again, re-runs — this is your visible
   iteration loop from Flow 2, now generalized to any file in the workspace.
6. Agent reports what changed, referencing the actual diff/backup, not just a description.

---

Every one of these five handlers calls `resolve_safe()` from §4 before touching disk — that's the
whole security model for MVP, and it's small enough to actually get right.

---

## 7. Acceptance Criteria (what "done" means for the demo)

- [ ] Selecting a directory registers it and returns a browsable tree within a couple seconds even
      for a moderately sized project (ignore-list is doing its job on `node_modules`/`.git`).
- [ ] Given a task without being told which file is relevant, the agent finds it via `search`
      before reading it — not via a hardcoded path.
- [ ] A write creates a timestamped backup before overwriting, and the diff shown to the user
      matches what was actually written.
- [ ] `run_command` executes with the workspace directory as its working directory and cannot see
      or affect files outside it.
- [ ] A deliberate path-escape attempt (`../../../etc/passwd`, or an absolute path outside the
      root) is rejected by every tool, not just some of them.
- [ ] The full loop — list → search → read → edit → run → fix → re-run — completes without a human
      manually feeding the agent file contents at any step.

---

## 8. Explicitly Deferred (post-MVP backlog)

Git commit/branch management · embedding-based repo-wide code search · multi-workspace sessions ·
per-file permissions · live file-watching · collaborative editing/locking · large-file streaming
reads (>200KB files) · language-aware chunking of source files for context (e.g. AST-based).