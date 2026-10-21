# Shared team learnings

<!-- Format: see README.md. Keep at most 40 active entries. -->

## Watchlist

- GitHub Copilot SDK / CLI: custom agents, MCP configuration and enabled models. Revalidate against the installed runtime when upgrading.
- WorkIQ and MSX MCP tool surfaces: revalidate read-only allowlists and service confirmation behavior when upgrading.

## Active

- [mistake] [office] Sorting sims by x+y alone can draw them behind long furniture, and straight-line walking clips through desks. Use `office-path.js` (A* grid and `simDepth`) and `test/office-path.test.mjs` whenever furniture moves.
- [convention] [tooling] HQ defaults to ports 4343-4353, separate from the original Pied Piper range. An explicit `DM_PORT` disables fallback.
- [work] [tooling] HQ uses connector `readOnlyTools` allowlists when a server does not supply read-only annotations. Other tools remain subject to the active mode's approval policy and service confirmations.
- [work] [tooling] Headless browsers may throttle `requestAnimationFrame`; Office animations must remain time-based.

## Retired

_None._
