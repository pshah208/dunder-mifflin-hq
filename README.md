# Dunder Mifflin HQ 📄

A multi-agent **day-to-day operations team** with personas inspired by NBC's *The Office*. You chat with
**Michael Scott** (the Regional Manager). He reads the request and sends each part to the teammate whose expertise
fits it, using the model that suits the task. The agents can read your **Outlook email, Teams chats and meetings, calendar,
OneDrive, SharePoint** and **MSX (Dynamics 365 CRM)**.

**Start here:** [Deployment and operations](docs/DEPLOYMENT.md) ·
[Agent operating manual](AGENTS.md) · [Architecture](docs/adr/0001-architecture.md)

This is a **local, single-user application**, not a hosted website. It runs a Node.js server plus the
GitHub Copilot runtime on your machine. Connectors use your own authorized identities; cloning this
repository does not provide Microsoft 365, MSX, MSXi or Power BI access. Windows with an interactive
desktop is the supported deployment path for the complete Edge/MSXi experience.

### At a glance

- 15 character-based agents, manager-led routing, per-agent models and Quick / Auto / Team response lanes.
- Chat with persistent history, file references, screenshot attachments and per-conversation message queues.
- A live Office scene, conference-room discussions, downtime, basketball and feedback-driven Dundie awards.
- Optional MCP connections for Microsoft 365, CRM, consumption analytics and Microsoft Learn.
- Plan, Interactive and approve-once Autopilot modes, with explicit service confirmations and manual MFA.

| Team | Who | What they do |
|---|---|---|
| **Leadership** | Michael Scott | Routing, task breakdown, one consolidated answer |
| **Scranton Branch** (sales & customer) | Dwight (sub-lead, MSX pipeline), Jim (account strategy), Pam (inbox, calendar, Teams), Angela (ACR, quota, MACC), Stanley (renewals), Phyllis (relationships), Kelly (comms), Kevin (TL;DR) | The business side: customers, pipeline, your day |
| **Dunder Mifflin Infinity** (engineering & product) | **Oscar (sub-lead; Azure, infrastructure, databases & AI expert)**, Ryan (product), Darryl (code & automation), Andy (decks & docs) | The technical side |
| **Quality gates** | Creed (QA), Toby (HR & compliance for anything outbound) | Review before anything ships or leaves the building |

Each agent has its own default model in `.github/agents/<id>.agent.md` (`model:`). For example, Oscar uses Claude Opus,
Darryl uses GPT Codex and Pam uses Claude Haiku. Michael can switch an agent to another model for a single task, and
you can override any agent's model in the UI.

### Responsive coordination

Use **Theme: Light / Theme: Dark** in the header to switch appearance across Chat, Org chart, Office
and Automations. The choice is saved in this browser and synchronized across tabs on the same HQ address.
Light remains the default; Office artwork and character colors are preserved in either theme.

Use the **⚡ Quick · Auto · 👥 Team** control beside the composer, inspired by Pied Piper HQ:

- **Quick:** Michael answers directly, with an available fast lead model unless you chose one explicitly.
  Routine planning, learning-file work, scorecard loading and specialist round-trips are skipped.
- **Auto** (default): direct answers for follow-ups and bounded lookups; specialists only where judgment or
  independent work is needed.
- **Team:** relevant specialists work on independent outcomes in parallel, then Michael consolidates the answer.

The selected lane is remembered per conversation. Speed does not change Plan / Interactive / Autopilot
permissions or bypass required reviews. Model and connector caches remain shared; actual latency still
depends on model generation and upstream services.

**Reference files and screenshots:** use **Attach files**, paste files, or drag and drop up to **4**
files per message (10 MB each, 20 MB total). Supported: PDF, DOCX, XLSX, PPTX, TXT/Markdown,
CSV/TSV, JSON/YAML/XML, logs and common source-code files, alongside PNG/JPEG/WebP screenshots.
The composer shows filenames for references and previews for images; mixed uploads and queued messages
retain all files. History includes authenticated downloads of the original documents.
Documents are parsed **locally**, with text previews and a full extracted-text file supplied to Michael.
Document-only requests work with non-vision models. Extraction is text-only: no OCR, embedded-image/chart
interpretation, reliable table-layout preservation, or formula recalculation. Attach screenshots for
visual questions. Encrypted, unreadable, empty, macro-enabled and oversized-expanded documents fail
explicitly; legacy DOC/XLS/PPT, arbitrary archives and executable binaries are not accepted.
Extraction is limited to 20 seconds and 1,000,000 text characters per document; Office archives are
bounded to 40 MB expanded. Split larger files before uploading. Originals and extracted text stay in
the conversation's local attachment directory and are removed when that conversation is deleted.

If a model accepts only one image inline, remaining images are supplied as local files for its `view`
tool instead of rejecting the message. All images remain in chat history; unavailable images must be
reported explicitly rather than silently ignored.

Michael now defaults to **Claude Sonnet 5.5** for coordination (existing user model overrides still win).
He answers small requests and bounded read-only lookups directly instead of always spawning a specialist.
Deeper work uses one specialist; independent tasks run in parallel, with team meetings and required reviews retained.
Routine replies skip mandatory learning-file reads/writes and coordination tables. Approvals and source/freshness
requirements are unchanged.

The runtime reuses its **30-second model catalog cache**, shares concurrent catalog fetches, and resolves connectors
**once per run**, reusing that snapshot for the prompt and SDK resume/create fallback. This removes redundant setup;
model generation and upstream Microsoft 365/MSX/Power BI calls can still dominate response time.
Restart the HQ server after changing server code or agent instructions.

### Michael's message queue

While Michael is busy, **Queue for Michael** saves another request (up to 20 per conversation).
Each request keeps its screenshots, mode, speed, model overrides and target; it runs in FIFO order
after the previous request finishes. The queue shows pending requests with **Remove**, **Pause queue**
and **Resume queue** controls. Other conversations remain independent.

Queues are stored locally under `~/.dunder-mifflin-hq/history/queues` (or `DM_DATA_DIR`).
**Stop or a failed run pauses the queue.** After an HQ restart, review and resume pending work explicitly.
A request interrupted during admission is marked uncertain: check history and remove it before resuming,
so a potentially completed action is never automatically duplicated. Revoke affects new Autopilot
submissions, not already authorized queued requests; remove those or pause the queue.
Remove pending messages before deleting a conversation.

The Office now replays active delegations when opened/reconnected and keeps specialists active until
their SDK completion event. Specialist text/results cannot end Michael's scene. Meeting task descriptions
retain the `Meeting:` prefix that sends participants to the conference room.
Office positions, walking paths, breaks and social scenes resume when you switch to Chat and back in
the same browser tab (including a page refresh). Decorative animation pauses while away; live work
is reconciled with the server on return. Idle outings rotate fairly across all available characters.
Initial and restored positions are drawn before animation starts, so deferred browser animation cannot
pile the characters into one spot. Rendering errors are shown in the Office rather than failing silently.
For a request involving multiple teams, Michael gathers its stakeholders in the conference room,
regardless of where their desks are, and keeps them together while he synthesizes their results.
The runtime waits past intermediate Autopilot idle events, preserves delta-only replies and reports an
explicit failure rather than silently saving an empty successful answer.
If tools finished but Michael omitted the final answer, HQ makes one summary-only follow-up using
existing results; tool permissions are denied during that follow-up so it cannot repeat actions.
If that still produces no final answer, the run fails explicitly and the queue stays paused.

### Automations

Open **Automations** in the navigation to build recurring work without writing code.
Ryan is the **Automation Builder**: describe a workflow and he proposes a disabled draft with
triggers, ordered steps, conditions and specialist assignments. Review/edit that draft or use a
Morning briefing / Pipeline review template. Each step can name a specialist or let Michael route it.
Darryl remains the code/integration specialist.

**Save draft → Test read-only → Enable schedule**. Test is a real read-only model run, not a simulation.
An enabled schedule must have a successful test of its current revision; editing pauses it and requires
another test. **Run now** executes the saved revision on demand. Results, errors and approval cards
open in a dedicated Chat conversation; actual delegations also appear in the Office.

- Triggers: on demand, every 15 minutes or longer, daily, or weekly. Daily/weekly schedules use an
  explicit IANA timezone. Nonexistent daylight-saving times are skipped; a repeated local hour runs once.
- Scheduled jobs are **read-only**. Jobs requiring writes must use **Interactive + On demand** and retain
  the existing approval/service-confirmation flow. Scheduled browser navigation/filter clicks are not supported.
- Optional per-agent model overrides use the same enabled model catalog as Chat. If a persona's configured
  default is unavailable, it inherits the session model and a notice appears in activity; explicit overrides
  are validated and never silently substituted.
- Conditions are **LLM-evaluated instructions**, not executable expressions or deterministic branching.
  Steps run in one coordinated agent conversation; there is no per-step resume/retry engine.
- Run history keeps 200 records and links to the full conversation. One automation/builder runs at a time;
  scheduled work waits while other HQ work is active. Run limits are 1-30 minutes.
- Failed runs pause their workflow. After restart, interrupted runs are marked interrupted and their
  workflow is paused; missed schedule slots are skipped, never replayed in a catch-up burst.
- Keep HQ running and the host awake. Closing the browser is fine. Every build/test/run consumes normal
  model usage. `DM_AUTOMATION_SCHEDULER=0` disables automatic scheduling without removing saved workflows.

Definitions and execution snapshots are private under `DM_DATA_DIR\automations\store.json` (default:
`%USERPROFILE%\.dunder-mifflin-hq\automations\store.json`). Run only one HQ instance against a data directory.
No webhook/email-arrival triggers, Power Automate exports, cloud scheduler or unattended writes are included.

### Customer360 through Edge

Ask Michael to have **Dwight** read a customer in your **Active Customer360S** MSX view.
Dwight opens the supplied view in the shared HQ Edge profile, uses visible search/filter/paging controls,
reads the relevant record sections and returns a sourced summary. This is read-only: no CRM edits or exports.
Angela's Power BI browsing and Dwight's Customer360 browsing must run one at a time.
MSX sign-in/MFA and record access still depend on your own account; the agent cannot grant permissions.
Supply your own Customer360 view link in the conversation; no organization-specific view is bundled.
The read-only workflow and metadata-discovery fallback are in [Dwight's instructions](.github/agents/sales-lead.agent.md).

## Quick start

```powershell
git clone https://github.com/pshah208/dunder-mifflin-hq.git
Set-Location .\dunder-mifflin-hq\apps\dunder-mifflin-hq
npm ci
$env:DM_PORT = "4343"
$env:DM_STUDY_SCHEDULER = "0"  # Opt into automatic character studies later
npm start
```

You'll need Node 22.13 or later and a signed-in GitHub Copilot runtime. The Microsoft 365 connector runs
`npx @microsoft/workiq` and signs you in on first use. MSX uses the `msx-mcp` Copilot plugin when it's installed.
Open **http://localhost:4343**. There is no frontend build step. See the
[deployment guide](docs/DEPLOYMENT.md) for Copilot installation/sign-in, connector setup,
connector-free startup, updates, backups and troubleshooting.

### Pages

- **Chat** (`/`): talk to Michael. Quick-prompt chips are available, the **Connectors** panel shows which data sources are live, and you can choose Plan, Interactive or Autopilot mode. There's no repository or Azure target picker: runs use this repository, and agents never change Azure resources from HQ.
- **Org chart** (`/team.html`): shows the full hierarchy with each agent's model, data sources and responsibilities.
- **Office** (`/office.html`): a Sims-style isometric view of the Scranton office floor (reception, bullpen, accounting, Michael's office, conference room with an ideas board, copy corner, annex), the **Dunder Mifflin Infinity warehouse lab**, **Café Disco**, and a separate **Break Room** off the front of the floor (kitchenette, fridge, snack and drink machines, dining tables, couch, bean bag and a ping-pong table for pairs). Every desk has its owner's personal touches (Michael's trophy, Dwight's bobblehead and beet, Jim's stapler in gelatin, Pam's candy dish and sketchbook, Kevin's candy jar and chili pot, and so on). Agents who are working walk to their desks to type, take calls or join huddles. Idle agents take breaks, chat with each other and build friendships (an affinity model). Agents who aren't working get up to show-style antics: Jim pranks Dwight, Michael drops by desks, Kevin talks chili, Creed is Creed, and there are "to camera" talking-head asides (dark bubbles). The bits are original text in `public/office-antics.js`, and real work always interrupts them. `?demo` plays a scripted scene.

The warehouse also has a **basketball shooting corner** between the design board and stacked boxes, with a marked court, backboard, orange rim, woven net and
animated shots. Idle characters reserve one shooting spot at a time; real work interrupts the break immediately.
Sometimes a second free character joins courtside for friendly, persona-flavored trash talk and replies.
These are original local animations and dialogue, not LLM calls or copied show dialogue.
Decorative motion pauses in hidden tabs and respects reduced-motion settings.

**Office seating:** Oscar and Andy sit in the front Scranton office with accounting; Toby and Kelly sit in the
back warehouse office. Their personalized desk props follow them. Seating does not change their specialist roles or team membership.

## Character study (downtime)

Once a day (from 15:00 by default) and **only when nobody is working**, a few agents read public pages about their own
character from *The Office*. The rotation goes never-studied first, so all 15 characters get covered, about 3 per day by default.
Michael returns short notes in his own words: a summary, traits, **original** in-character one-liners and source links.

- **Org chart** has the 📖 Character study panel: turn it on or off, set the time and agents per study, **Study now**, see
  progress ("3 of 15") and who's next. Each card shows what that character learned, plus a per-card **📖 Study now** button.
- **Office**: students sit in the Break Room reading a book while Michael supervises. Their new lines join their banter.
- **Chat**: study runs are background conversations, hidden unless you tick **📖 study runs** under Conversations.
- **Safety**: study runs are unattended, read-only Plan runs. They can fetch **public web pages only**: no connectors (mail,
  Teams, files, MSX, Power BI), no shell, no writes, and no private or localhost URLs. Notes are display-only and never
  added to work prompts. Each study uses a few premium requests. The playbook is in `.github/prompts/character-study.prompt.md`.
- API: `GET /api/personas/notes`, `PUT /api/personas/settings` `{ enabled, hour, minute, perRun }`,
  `POST /api/personas/study` `{ agents? }`. Stored in `~/.dunder-mifflin-hq/personas/`.

## Rewards and the Dundies

Every completed reply in Chat has **👍**, **👎** and **📋 Used as written** buttons. When Toby (compliance) reviews work or ideas, he
ends with `TOBY VERDICT: APPROVED` or `REJECTED`, which shows as a badge on the reply. These signals credit the agents who worked on
the reply (points and rules are in `AGENTS.md`), decay with a 30-day half-life, and roll up into a per-agent scorecard.

- The **Office** page shows **The Dundies** board (MVP, Ctrl+C Ctrl+V, Toby's Seal of Approval, Fan Favorite, Hottest Streak,
  Back to the Drawing Board), a leaderboard, and trophies on winners' name tags. Agents react in the Office when you rate a reply.
- Michael gets a compact `[SCORECARD]` and uses it only as a routing tie-breaker. Approvals, reviews and sources are never skipped.
- API: `GET /api/rewards`, `POST /api/feedback` `{ hqSessionId, runId, rating?: "up"|"down"|null, usedAsWritten?: boolean }`.
  Stored in `~/.dunder-mifflin-hq/rewards/ledger.json` (ids and flags only, no message text).

## Meetings and brainstorms

**Ryan is the team's creative lead.** Ask for a brainstorm, ideas, a creative angle, a team meeting or a kickoff, or use the
**💡 Brainstorm in the conference room** chip. Michael calls 3–6 relevant people into the conference room: Ryan leads, and Pam,
Kelly, Andy, Oscar, Dwight or Jim bring visuals, catchy names, story, technical reality or the customer view. He runs them in parallel,
then merges everything into one summary of top ideas, decisions and action items. In the Office view those attendees walk to the
conference table with Michael at the head. The `Meeting:` prefix on delegated tasks is what triggers this (see `AGENTS.md`).

## MSX: opportunities, milestones and tasks

Ask Michael things like *"show my open milestones for Contoso"*, *"which opportunities have stale milestones?"* or
*"add an Architecture Design Session task to the Contoso migration milestone, due Friday"*. Dwight (`sales-lead`)
reads opportunities and milestones with the MSX tools, then creates or closes tasks following the plugin's `msx-write` skill
(milestone binding, task category, completing past-dated tasks). The skill loads automatically when the MSX connector is available.
Before writing he shows you a preview table. MSX then shows its own **confirmation card** in the chat with the exact change, and
nothing is written unless you tick the box and press **Confirm change**. Plan mode never writes. MSX needs your corporate sign-in
(`az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47`, or ask Dwight to run `msx_login`).

## ACR, MSXi Snap and Power BI

### Use Power BI filters in Edge (no DAX)

Give Michael a report link and ask: **"Have Angela open this report in Edge, select my territory
and last month using its slicers, and summarize the visible ACR cards. Do not run queries."**
The `powerbi-browser` connector opens installed Microsoft Edge with a dedicated HQ profile.
Complete corporate sign-in/MFA manually in that window on first use; subsequent runs reuse that profile.
This is separate from your everyday Edge profile and from the Fabric connector's Azure CLI sign-in.
Your normal report permissions and row-level security still apply; no Build permission is needed just
to interact with report controls. Unreadable visuals are reported as unknown, not guessed.

Install dependencies with `npm ci` in the app directory and restart HQ after updating.
Navigation and filter clicks prompt in Interactive, but run without repeated HQ prompts after the
conversation's Autopilot approval. Run one browser task at a time across
conversations; other sessions share this profile. No DAX, API extraction, sharing, editing or exports
are part of a browser-only request. The connector exposes no JavaScript evaluation or arbitrary code tool.
Its availability card checks installation, not whether Power BI is signed in.

Optional overrides: `DM_EDGE_EXE` selects an Edge executable and `DM_EDGE_PROFILE_DIR` selects a
dedicated profile directory (default `~/.dunder-mifflin-hq/browser/edge-powerbi`).
Keep profile cookies local and out of source control. Do not point it at your everyday Edge profile.

Ask about ACR, consumption, MACC or movers, and Michael routes it to Angela (`finance-analyst`):

- **MSXi Snap** (`msxi-snap`): HQ finds the MSXi Snap desktop exe automatically (`Downloads\msxi-snap-desktop-windows-*.exe`,
  or set `DM_MSXI_SNAP_EXE`) and serves your local snapshot (94 read-only `msxi_*` tools). It's only as fresh as the last
  sync in the MSXi Snap app, and every answer states the freshness date.
- **Power BI** (`powerbi-remote`, Fabric MCP): live MSA/MSXi semantic models via DAX. It uses your **corporate** Azure CLI
  sign-in, so if the card says *sign-in needed*, press **Sign in** (it runs
  `az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 --scope https://api.fabric.microsoft.com/.default` in your browser) and
  sign in with your @microsoft.com account. The MSX plugin's `acr` skill holds the dataset IDs and DAX queries.
- **MSX** `get_azure_consumption`: a cross-check. It needs the MSX plugin's Customer360 sign-in.

## Safety model (outbound actions)

- Read-only tools do not require HQ approval clicks; model/service usage may still incur charges.
  Allowlisted read-only connector tools (`readOnlyTools` in
  `apps/dunder-mifflin-hq/mcp-servers.json`) also run in Plan mode.
- MSX's `dataverse_write` shows its own preview-and-confirm card (MCP elicitation, relayed by HQ, never auto-accepted). It fails closed without your confirmation, so HQ doesn't add a second click for it.
- **Approve Autopilot once per conversation/window:** routine tool calls, Edge clicks/filters, file changes and
  connector writes needed for your requests then run without additional HQ approval cards. No environment switch
  is needed. Interactive still prompts for side-effecting tools; Plan remains read-only.
- Managed approvals, service-owned confirmations and manual sign-in/MFA remain explicit. Autopilot does not
  grant unrelated actions or override Azure restrictions. **Stop** cancels current work; **Revoke** requires
  confirmation again before future Autopilot requests. Switching conversations/windows does not transfer consent.
- Agents draft first. Toby (compliance) reviews customer-facing content.
- The server binds to `127.0.0.1`, checks the Host header, and requires a per-start page token.

## Layout

```
AGENTS.md                      routing table, model policy, global rules (appended to Michael's system prompt)
.github/agents/*.agent.md      one file per agent: persona, data sources, expertise, rules, default model
docs/learnings/                per-agent memory (learning loop)
docs/adr/                      architecture decisions
apps/dunder-mifflin-hq/        local web app (Node, @github/copilot-sdk, vanilla JS, no build step)
  server.mjs                   HTTP API, SDK sessions, MCP connectors, approvals, live NDJSON stream
  mcp-servers.json             connectors: workiq (M365), msx (D365), msxi-snap (optional), ms-learn
  personas.json                roster for the UI (names, titles, colours, models, avatars)
  public/                      Chat, Org chart, Office (isometric scene, lounge, social dynamics)
  test/                        node:test suites (npm test)
docs/DEPLOYMENT.md             installation, connector setup, updates, backups and troubleshooting
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DM_PORT` | `4343` | Port. When busy it tries 4344-4353 unless `DM_PORT` is set. This range is deliberately separate from Soccer's Pied Piper HQ (4242-4252) and MatchLens (3000), so both can run side by side. |
| `DM_DATA_DIR` | `~/.dunder-mifflin-hq` | Private local conversation history |
| `DM_MCP_CONFIG` | `apps/dunder-mifflin-hq/mcp-servers.json` | Alternative connector file |
| `DM_DISABLE_MCP` | unset | `1` = run without connectors |
| `DM_MSX_MCP_DIR` | `~/.copilot/installed-plugins/msx-mcp/msx-mcp` | Location of the MSX MCP server |
| `DM_MSXI_SNAP_EXE` / `DM_MSXI_SNAP_DATA_DIR` | auto-discovered | Override where MSXi Snap and its data live |
| `DM_EDGE_EXE` / `DM_EDGE_PROFILE_DIR` | discovered / private HQ profile | Installed Edge executable and dedicated browser profile |
| `DM_STUDY_SCHEDULER` | on | Set to `0` to turn off the daily character study for this server (it's always off under `node --test`) |
| `DM_AZ_TOKEN_TIMEOUT_MS` / `DM_CONNECTOR_AUTH_WAIT_MS` | `20000` / `3000` | Azure CLI token timeout / how long a run waits for it |
| `DM_AUTOPILOT_MCP_WRITES` | unset | Legacy MCP approval bypass; no longer needed for Autopilot. Leave unset to retain Interactive approval prompts. |

## Avatars

The avatars in `public/avatars/*.svg` are **original cartoon illustrations**. They aren't photos or stills from the show,
which are copyrighted by NBCUniversal and show real actors. To use your own picture, put
`public/avatars/custom/<agent-id>.png` (or `.jpg`, `.webp`, `.svg`) in place. It overrides the default everywhere and is
git-ignored. Only use images you have the right to use.

## Tests

```powershell
cd apps\dunder-mifflin-hq; npm test
```

*This is a fan-made theme. The characters belong to NBC's* The Office *and are used only for conversational flavour. The project isn't affiliated
with NBCUniversal. Dialogue in the Office scene is original.*

Adapted from the Pied Piper HQ architecture; that source repository is not a runtime dependency.
See [ADR 0001](docs/adr/0001-architecture.md).
