# Agent learnings (continuous learning)

Each agent keeps a short, curated memory here. Consult relevant lessons for substantial work and record genuinely new, reusable findings. Routine requests skip memory reads/writes unless a known lesson is needed; the fast-response policy in [AGENTS.md](../../AGENTS.md) takes precedence.

| File | Purpose |
|---|---|
| `<agent-id>.md` | One agent's **Watchlist** (topics to keep current), **Active** lessons and **Retired** lessons |
| `_team.md` | Lessons and watch topics for everyone (repo conventions, user preferences, Azure, data providers) |

## Three sources of learning
| Source | Trigger | What to record |
|---|---|---|
| `[mistake]` Past mistakes | A test or build fails, a deploy fails, `qa-reviewer` rejects the work, or the user corrects you | What went wrong, the root cause, and how to prevent it. Mistakes are always read first. |
| `[work]` New information | A new verified fact about the repo, data, Azure or user preferences | The fact, phrased as guidance |
| `[research]` Internet research | The task touches a fast-moving topic, or a Watchlist item is past its review date | What changed, with the source URL, the date checked and a review-by date |

## Loop
1. **Recall.** When relevant, read your own file and `_team.md`. Apply `[mistake]` notes first.
2. **Refresh.** If a Watchlist topic you rely on is due, research it (primary sources first) and update `last checked`.
3. **Reflect.** Include `LEARNINGS:` only for new, verified, reusable lessons (at most 3); otherwise omit it.
4. **Record.** Append them (or have the lead do it). In Plan mode nothing is written; the lead lists them instead.
5. **Promote.** A lesson confirmed three or more times, or a lasting rule, moves into `.github/agents/<id>.agent.md` or `AGENTS.md` (with an ADR if significant) and is removed from the notes.
6. **Prune.** Wrong, outdated or expired research entries move to **Retired** with a reason. Keep at most 40 active entries per file.

To refresh lessons on demand, ask Michael to review the relevant watchlist topics and verify their sources.
No separate `/learning-refresh` command is bundled.

## Entry format
```
- 2026-10-17 · [mistake] [azure] · Always pass --subscription to az; the default subscription pointed to the wrong tenant. Prevention: check `az account show` first. (source: HQ run)
- 2026-10-17 · [research] [msx] · <What changed, summarised in your own words>. (source: https://..., checked 2026-10-17, review by 2027-01-15)
- 2026-10-17 · [work] [preference] · The user wants advice only when they say "don't make changes". (source: chat)
```
Topic tags: `[convention]`, `[gotcha]`, `[preference]`, `[azure]`, `[data]`, `[m365]`, `[msx]`, `[tooling]`. Do not use account names, customer identifiers or customer-specific code names.

## Rules
- Record only verified, reusable lessons. Don't record task logs or one-off facts.
- Research entries must cite a source and a review-by date. Summarise in your own words and never paste copyrighted text.
- **Never** record secrets, keys, connection strings, personal, biometric or youth data, client data, or licensed provider content.
- These files are committed to git, so review them like code. `qa-reviewer` may reject a wrong lesson.
