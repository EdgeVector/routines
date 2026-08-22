# dogfood-kanban probe harness

`scripts/kanban-stress.sh` is the repo-owned dogfood-kanban consistency
harness. It exercises only the scratch board named by `KSTRESS_BOARD`
(`agent-dogfood-scratch` by default) and never writes to the default board.

The harness must use the live fkanban column schema exactly:
`backlog,todo,doing,done`. The retired `review` lane is intentionally absent
from board creation and move-path checks, and the regression test
`test/kanban-stress-script.test.ts` guards that contract.

If the scheduler or an outer `timeout` interrupts the harness, the script traps
the signal, soft-deletes scratch cards created so far, emits `PARTIAL:`, and
prints `SUMMARY: ... partial=1 ...`. Treat that as a liveness/noop result for
the routine verdict, not as a consistency failure or a fleet error.

Run it manually with:

```sh
probe="$(routines probe-path dogfood-kanban)"
FKANBAN=fkanban bash "$probe"
```

`routines probe-path` resolves the harness from the immutable host-track
artifact. It does not require a source checkout. The EdgeVector repository
paths are portals and do not contain `scripts/kanban-stress.sh`.

The expected healthy summary is `SUMMARY: findings=0 errors=0 partial=0 ...`.
The harness also emits a partial summary when the shell exits before the normal
summary path.
