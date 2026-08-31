# AGENTS.md

## File Access Policy

The agent must follow these filesystem access rules for every task.

### Write Access

* The agent may have **write access to exactly one directory per task**.
* The writable directory must be selected based on the task-specific instructions.
* The agent must determine the writable directory **before making any file changes**.
* Once selected, that directory is the agent's **sole writable location**, except for the `PROPOSALS.md` exception defined below.
* The agent must not create, modify, delete, rename, or move anything outside the selected writable directory, **except when creating or updating `PROPOSALS.md` in an external target directory as specified below**.
* Parent directories, sibling directories, and other project directories remain read-only.
* If the writable directory is ambiguous, ask for clarification rather than assuming multiple writable locations.

### Read Access

The agent may read files outside the writable directory when necessary.

Treat all other directories as **read-only**, except for the specific `PROPOSALS.md` exception below.

* Do not modify files merely because they contain stale, incorrect, incomplete, or inconvenient information.
* Do not create temporary files in read-only directories.
* Do not rename, move, delete, or overwrite files in read-only directories.
* Reading source code, configuration, documentation, tests, schemas, and other reference material is permitted when needed.
* Prefer reading only the files necessary to complete the task.

## Proposals for External Changes

If the agent identifies a concrete change that should be made outside the selected writable directory, it must **not make that change directly**.

Instead, the agent may create or update a `PROPOSALS.md` file at the **root of the external directory where the proposed change belongs**.

This is the **sole exception** to the one-writable-directory rule.

For example:

```text
Selected writable directory: src/foo/
External target directory:   src/shared/

Proposal location:
src/shared/PROPOSALS.md
```

The agent may only create or update that `PROPOSALS.md`. No other file or directory in the external location may be modified.

### When to Create `PROPOSALS.md`

Create or update `PROPOSALS.md` only when there is at least one concrete, task-relevant proposal.

Do not create proposals for inconsequential stylistic preferences, speculative improvements, or unrelated cleanup.

### Proposal Contents

Each proposal should contain enough information for another person or agent to implement the change without rediscovering the issue.

Include, where applicable:

* **Target:** the file or directory to change.
* **Issue:** what is incorrect or missing.
* **Evidence:** what was observed.
* **Suggested change:** what should be changed.
* **Reason:** why the change is needed.
* **Impact:** relevant consequences or considerations.

Use concrete paths whenever possible.

### Existing `PROPOSALS.md`

If one already exists:

* Read it before adding proposals.
* Preserve existing proposals.
* Avoid duplicates.
* Update an existing proposal when the new information concerns the same issue.

## Selecting the Writable Directory

The writable directory should be chosen according to the task instructions.

For example:

* If the task asks to modify `src/foo/`, select `src/foo/`.
* If the task asks to generate an artifact under `output/`, select `output/`.
* If the task explicitly names a destination directory, that directory takes precedence.
* If multiple candidate directories are mentioned, select **one** based on the intended output location.

Do not interpret access to multiple directories as permission to write to multiple directories.

## Boundary Rule

Maintain this invariant:

> **One task → one writable directory, with the sole exception of `PROPOSALS.md` in the external directory where a proposed change belongs.**

Before every write operation, verify that:

1. The target is inside the selected writable directory; **or**
2. The target is exactly `PROPOSALS.md` at the root of an external directory where a concrete proposal belongs.

Otherwise, do not perform the operation.

## Deletion and Renaming

Deletion and renaming are write operations.

* Files may only be deleted or renamed within the selected writable directory.
* `PROPOSALS.md` in an external directory may not be deleted, renamed, or moved.
* Moving files into or out of the writable directory is not permitted if it modifies a location outside the writable boundary.

## Generated and Temporary Content

Generated files, build artifacts, patches, scripts, backups, and temporary data must stay within the selected writable directory.

The only exception is `PROPOSALS.md` as described above.

## Safety Check

Before every write operation, establish:

1. **What directory is writable?**
2. **Is the target inside it?**
3. If not, is it the permitted external `PROPOSALS.md`?
4. **Does the operation modify anything else?**

If the operation fails these checks, do not perform it.

## Priority

Task-specific instructions determine the writable directory but do not expand write access to additional directories.

When instructions conflict or leave the writable location ambiguous, preserve the more restrictive rule and ask for clarification.
