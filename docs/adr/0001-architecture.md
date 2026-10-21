# ADR 0001: Reuse the Pied Piper HQ architecture with Microsoft 365 and MSX connectors

- Status: accepted
- Date: 2026-10-17

## Current-state amendment

This ADR records the original design. Subsequent releases supersede two details below:

- Approved Autopilot work uses conversation-scoped consent; Interactive retains per-action approvals.
  Managed approvals, Azure restrictions, manual sign-in/MFA and service-owned confirmation cards remain.
- Edge automation and reference-document extraction now add runtime dependencies, including Playwright MCP,
  OfficeParser and yauzl. The committed package manifest/lockfile are authoritative.

The app is standalone; the original Pied Piper repository is not needed to install or run it.
See [Deployment and operations](../DEPLOYMENT.md) for current prerequisites and hosting limitations.

## Context

We want a persona-driven, multi-agent day-to-day operations assistant. A lead agent routes work to specialists,
each agent can use a different LLM, and the agents can read email, Teams, calendar, OneDrive, SharePoint and MSX. It also
needs a themed web UI with an org chart and an animated office. `mcaps/Soccer/apps/pied-piper-hq` already solves the
hard parts:

- `@github/copilot-sdk` sessions with a lead agent and `customAgents` loaded from `.github/agents/*.agent.md`
- Per-agent `model:` frontmatter, per-request overrides validated against `listModels()`
- Plan, Interactive and Autopilot modes, browser approvals and `ask_user` cards, durable history, a live NDJSON stream
- A Sims-style isometric office driven by the real delegation events

## Decision

1. Fork the Pied Piper HQ app into `apps/dunder-mifflin-hq` and keep its runtime, safety model and tests.
2. Attach MCP servers per session from `mcp-servers.json`, namely `workiq` (M365), `msx` (D365), the optional `msxi-snap`
   and `ms-learn`. Use `${HOME}`/`${env:X|default}` expansion and skip any connector that isn't installed.
3. **Outbound guard:** a connector tool counts as read-only only if the server annotates it that way or it appears in
   `readOnlyTools`. Every other connector tool needs a browser click in **every** mode, Autopilot included. WorkIQ doesn't
   annotate its read tools, so the allowlist is what lets Plan mode read the calendar.
4. Draw original SVG avatars instead of downloading character photos (copyright and personality rights). Offer a
   git-ignored `avatars/custom/` override for the user's own images.

## Consequences

- No new runtime dependencies. Everything runs locally under the user's own identity, so the connectors see only what
  the user can see.
- The allowlist needs maintenance when the WorkIQ or MSX tool surfaces change (on the `_team.md` watchlist).
- Customer data stays in chat and local history (`~/.dunder-mifflin-hq`), outside git.
