# Dogfood Onboarding Probe

The canonical dogfood-onboarding recipe lives in the Brain `probe-registry`
project record. This note pins the Mini-only contract that routines should
expect when rendering or running that probe.

The probe must not fail on retired desktop/Tauri surfaces. After the Mini
cutover, onboarding checks should exercise:

1. invite link minting on DEV,
2. invite preview on DEV,
3. `/join/<token>` page rendering with an invite code,
4. invite redemption on an ephemeral Mini node,
5. passwordless local keyfile setup,
6. Mini status health after connect,
7. cloud sync config presence while respecting active cloud-sync posture.

Removed desktop checks such as Ollama one-click setup, desktop AI provider
selection, and chat through a desktop gateway are not part of the active probe
unless they are explicitly reintroduced as future product scope.
