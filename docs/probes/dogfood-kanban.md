# dogfood-kanban probe harness

`scripts/kanban-stress.sh` is the repo-owned dogfood-kanban consistency
harness. It exercises only the scratch board named by `KSTRESS_BOARD`
(`agent-dogfood-scratch` by default) and never writes to the default board.

The harness must use the live fkanban column schema exactly:
`backlog,todo,doing,done`. The retired `review` lane is intentionally absent
from board creation and move-path checks, and the regression test
`test/kanban-stress-script.test.ts` guards that contract.

Run it manually with:

```sh
FKANBAN=fkanban bash scripts/kanban-stress.sh
```

The expected healthy summary is `SUMMARY: findings=0 errors=0 ...`.
