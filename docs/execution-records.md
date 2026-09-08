# Execution records and recovery

Each provider run writes `execution.json` beside its logs. The terminal `meta.json`
and the run detail API include the same `execution` object.

The record contains the provider, model, session ID, observed tool completions,
tool failures, model errors, and provider-reported token counts. Missing usage
and cost remain `null`. A reported zero remains zero. The collector does not
estimate prices. It does not copy tool arguments, tool output, or error text.
The existing transcript logs retain their existing policy.

Codex uses JSON events. Claude and compatible Grok events supply available
fields. Text-only output leaves usage unknown. Tool counts describe observed
events. They do not prove that a provider exposed every tool call. Oversized
events set `truncated`; the next event remains readable. A final routine sink
or authored verdict still determines the work outcome.

## Persistent Codex sessions

Set `session_mode = "persistent"` for an implementation routine that needs
session retention. The default is `ephemeral`. Each scheduled fire starts a
new session. Retention does not join unrelated fires.

Use `routines run <id> --resume-run <run-directory>` for explicit recovery.
Configure `resume_check` as a bounded, read-only shell command. It must return
zero only when external effects permit continuation of that exact task.
It receives `ROUTINES_RESUME_RUN_DIR` and `ROUTINES_RESUME_SESSION_ID`.
There is no universal effect check.

Recovery requires the same routine, Codex model, persistent session, and a
finished run with an `error` or `unknown` outcome. The routine cwd must be a
Git worktree root. Its identity, HEAD, index, tracked contents, and non-ignored
untracked files must match the saved snapshot. The effect check must preserve
that snapshot. Large or unreadable snapshots refuse recovery.

The prior attempt can supply only one recovery. A new failed recovery has its
own record. Missing terminal evidence, including an outer process kill, refuses
native reuse. Provider fences still apply. Recovery never selects a fallback
provider or an implicit latest session. Ignored files and external services
remain the responsibility of the task-specific effect check.
