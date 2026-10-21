# macOS execution limits

Local Workbench uses `/usr/bin/sandbox-exec` when its startup check passes.
Each profile starts with `deny default` and blocks `network*`.

For Work Python:

- Python can read its runtime, installed library folders, and this run's inputs and intermediate files.
- It can write only in the execution output folder. Staged input files and their Python aliases remain read-only, including deletion and replacement.
- It can execute the selected interpreter and its matching framework helper. Other programs and process forks remain blocked.

For Agent commands:

- Commands use a workspace copy and a scratch folder. These folders allow reads and writes.
- System runtime folders allow reads. Child programs can start, but inherit the file and network limits.
- File links are blocked. The existing publication checks control which changes reach the workspace.
- Snapshot limits remain 10,000 files and 128 MiB.

## Startup compatibility

Recent macOS loaders open the root directory during startup. The profile allows a read of the literal `/` directory. This does not allow reads of its descendants. Ancestors of allowed paths permit metadata queries only; their contents remain blocked unless separately allowed.

Framework Python launchers start a second executable inside the same framework. That exact helper receives execution permission. A helper redirected outside the runtime receives no additional permission.

Homebrew library links need read access to their real paths. The profile resolves installed `opt/*/lib` folders within the Homebrew Cellar. It does not follow these links into unrelated user folders. Discovery stops with an error if the `opt` list exceeds 512 entries.

Agent shell and developer-tool shims can read the exact macOS selector paths under `/var/select`. This does not expose the rest of `/var`.

If the startup check fails, the existing separate approval is still required for execution without OS isolation. The app never retries failed user code outside isolation on its own.

`backend/tests/macos-sandbox.test.ts` runs real Python and Agent commands on macOS. It requires isolated success and checks outside file access, directory listings, symlink escapes, input replacement, unrelated execution, and network denial. The Work test also checks staging and publication without fallback approval.
