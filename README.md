# routines

Unified scheduler + dispatcher for agent routines (Claude Code / Codex, per-routine model routing). Spec: fbrain design-routines-orchestrator

## Forge

This repo merges through **LastGit-native change requests**, not GitHub PRs
(GitHub is a read-only mirror). Venue: `.last-stack/pr-venue`; CI gate:
`.lastgit/ci.sh` (`ci-required`). Pin `LASTGIT_SOCKET` to the dedicated forge
node socket (`~/.lastgit/forge/data/folddb.sock`) for every lastgit call —
see fbrain `sop-lastgit-native-forge-workflow`.
