# Deployment and operations

## Supported deployment model

Run HQ on a trusted **Windows workstation or an interactive Windows VM**, under your own user account.
Node.js serves the UI and talks to GitHub Copilot; optional MCP servers connect to your authorized services.
The browser-based Power BI and Customer360 workflows open **Microsoft Edge on the same machine**.

The server binds to `127.0.0.1`, validates the Host header and uses a per-start token for its APIs.
That token is an anti-cross-origin/local API control, **not multi-user authentication**.
Do not publish this server through a public tunnel, public reverse proxy or open firewall port.
GitHub Pages cannot run its Node server, SDK, persistent history or local browser.
There is no supported headless container, App Service or Kubernetes deployment in this repository.
For a remote Windows VM, use your organization's approved desktop access rather than exposing port 4343.

Other platforms may run the core server, but the complete connector/Edge workflow is verified on Windows.

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Git | Clone and update the repository |
| Node.js **22.13+** with npm; Node 24 recommended | Server, SDK and local document extraction |
| PowerShell 7 | Commands in this guide |
| GitHub Copilot access and CLI sign-in | Live agent requests and model access |
| Microsoft Edge, for browser workflows | Visible report filters and Customer360 records |
| Optional, separately authorized connectors | Microsoft 365, MSX, MSXi Snap, Fabric and Microsoft Learn |

Check installed tools:

```powershell
git --version
node --version
npm --version
```

Install GitHub Copilot CLI using one of the
[official installation methods](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli),
for example:

```powershell
npm install -g @github/copilot
copilot
```

Complete `/login` when prompted, then exit the CLI. Use the same Windows user when starting HQ.
A GitHub CLI (`gh`) login alone does not establish Copilot entitlement or Microsoft service permissions.
Organization policies and the models enabled for your Copilot account still apply.

## 2. Clone and install

```powershell
git clone https://github.com/pshah208/dunder-mifflin-hq.git
Set-Location .\dunder-mifflin-hq\apps\dunder-mifflin-hq
npm ci
```

Use the committed lockfile. There is no bundler, compile step or separate database to provision.
No secrets, browser profiles, customer files, MSXi snapshots or private connector implementations are included.

If your network requires an npm mirror, proxy or corporate CA, use your organization's approved
**user-level** npm configuration. Never commit authentication-bearing `.npmrc` files or disable TLS verification.

## 3. First launch

For a minimal start without Microsoft service connections:

```powershell
$env:DM_PORT = "4343"
$env:DM_STUDY_SCHEDULER = "0"
$env:DM_DISABLE_MCP = "1"
npm start
```

Keep the terminal open. Visit:

- Chat: <http://localhost:4343/>
- Org chart: <http://localhost:4343/team.html>
- Office: <http://localhost:4343/office.html>
- Scripted Office preview, without agent requests: <http://localhost:4343/office.html?demo>

Live chat still requires Copilot sign-in when MCP connectors are disabled.
Select an available model in the UI if your account does not support the persona's configured default.
Start with **Plan** mode and a simple request before enabling connector workflows or Autopilot.
`DM_STUDY_SCHEDULER=0` avoids automatic model-backed character studies; decorative Office animations
do not make LLM requests. Manual study requests can still incur usage.

Environment variables apply to the current terminal and its child processes. HQ does **not**
automatically load `.env` files. Repeat settings in each new terminal or a private launch script.

## 4. Enable the connectors you have access to

Stop HQ with Ctrl+C when no run is active, then remove the connector-free setting:

```powershell
Remove-Item Env:DM_DISABLE_MCP -ErrorAction SilentlyContinue
npm start
```

The Connectors panel reports discovery/authentication status, but an available connector does not
prove access to a specific mailbox, report, dataset or CRM record.

| Connector | Setup and scope |
|---|---|
| `workiq` | Uses `npx @microsoft/workiq@latest`. Complete the service's own sign-in/consent and any required terms. Microsoft 365 permissions are enforced by the service. |
| `msx` | Requires a separately installed, authorized MSX MCP plugin. Set `DM_MSX_MCP_DIR` if it is not at the default plugin path. The folder must contain `scripts\bootstrap.mjs` and any referenced skills. Use its supported authentication flow. It is not a generic public Dynamics connector. |
| `msxi-snap` | Optional Windows desktop snapshot tool, installed and synced separately. Set `DM_MSXI_SNAP_EXE` and, if needed, `DM_MSXI_SNAP_DATA_DIR`. Reports are only as fresh as the local snapshot. |
| `powerbi-remote` | Optional Fabric MCP configuration for an authorized organizational identity. Requires Azure CLI and the correct tenant/resource permissions. Use the panel's Sign in action where appropriate. Model-query permissions differ from report-view permissions. |
| `powerbi-browser` | Install Edge, then ask Angela to open your own Power BI report URL or Dwight to open your own Customer360 view URL. Complete sign-in/MFA manually in the dedicated HQ Edge window. |
| `ms-learn` | Documentation MCP endpoint. Network access is required. |

MSX/MSXi and some Fabric configurations are organization-specific and may not be available to external users.
Missing optional tools do not require installing proprietary packages from untrusted sources.
The default Fabric tenant targets Microsoft's corporate environment; use a private connector override
for a different environment instead of assuming the default grants access.

For private configuration, copy and edit the connector JSON **outside the checkout**:

```powershell
$privateConfig = Join-Path $HOME ".dunder-mifflin-hq\config"
New-Item -ItemType Directory -Path $privateConfig -Force | Out-Null
# On first setup only; do not overwrite an existing customized file.
$configFile = Join-Path $privateConfig "mcp-servers.local.json"
if (-not (Test-Path -LiteralPath $configFile)) {
    Copy-Item .\mcp-servers.json $configFile
}
$env:DM_MCP_CONFIG = $configFile
```

Remove connectors you do not need from that copy. Follow the schema already used in
[`mcp-servers.json`](../apps/dunder-mifflin-hq/mcp-servers.json).
Restart HQ after modifying connector configuration or persona files.
Keep tokens out of source files; prefer the connector's own login or environment-based credentials.

The Edge profile is shared by HQ conversations. Run one browser task at a time.
Never point `DM_EDGE_PROFILE_DIR` at your everyday browser profile, copy another user's cookies,
or automate credentials/MFA. Report-only browsing does not silently switch to DAX queries.

## 5. Persistence and day-to-day operation

By default, private state lives at `%USERPROFILE%\.dunder-mifflin-hq`, outside Git:

| Location | Contents |
|---|---|
| `history\sessions` | Conversation metadata and messages |
| `history\attachments` | Uploaded originals and locally extracted reference text |
| `history\queues` | Pending messages and execution settings |
| `history\locks` | Runtime/edit coordination files; not data to migrate |
| `rewards` | Feedback and scorecards |
| `personas` | Study settings, notes and run records |
| `automations` | Saved workflow definitions, revision/test state, schedules and run snapshots |
| `config` | Private repository/configuration data |
| `browser` | Browser output and the default dedicated Edge profile |

`DM_DATA_DIR` changes HQ state storage. **The Edge profile has a separate override**:
set `DM_EDGE_PROFILE_DIR` explicitly if relocating it. Copilot and service login data may also
live in their own user-profile locations, outside `DM_DATA_DIR`.
Data is not encrypted by this app; protect the Windows account, disk and backups accordingly.

Queued requests run serially within each conversation. Stop or a failed run pauses its queue.
After restart, review pending messages and use Resume explicitly. Check history before removing
an uncertain admission and resubmitting it; never blindly replay an action that may have completed.

### Scheduled automations

Use the **Automations** tab to build with Ryan or edit a template. Review and save the workflow,
run **Test read-only**, then explicitly **Enable schedule**. Tests/builds/runs consume model usage.
The scheduler checks every 15 seconds while HQ is running and launches at most one automation at a time,
waiting while other HQ work is active. Daily/weekly times include an explicit IANA timezone.
An open browser is not required; the process must remain running and the machine awake.

Scheduled jobs cannot write or operate browser controls. Use an Interactive, on-demand workflow for
operations needing approval. Authentication/MFA remains manual. Missing inputs, denied actions, failed
tools or missing completion status fail the run rather than unlocking a schedule with a partial result.
Definitions are versioned: edits pause scheduling and invalidate the prior successful test.
An error pauses that workflow; review the run before testing/enabling it again. No automatic action retries.

On restart, interrupted jobs are marked interrupted and paused, never replayed. Other enabled schedules
skip missed slots and continue at their next future occurrence. Back up the `automations` folder along
with history; never run a second HQ process using the same `DM_DATA_DIR`.
Set `$env:DM_AUTOMATION_SCHEDULER = "0"` before startup to disable automatic scheduling.
If the portal reports a scheduler storage error, resolve the underlying file/permission problem and
restart HQ. Do not delete state files or restart to replay an uncertain action.

For an always-available desktop setup, keep the process running in a dedicated user terminal.
If you configure Task Scheduler, choose **Run only when the user is logged on**, launch under the
same authorized user, set the working directory to the app folder, and use a private PowerShell
launcher containing the desired environment settings and `npm start`.
Do not run as SYSTEM: its identity, profile and browser session are different.

### Port handling

Use explicit `DM_PORT=4343` to fail rather than silently move when the port is occupied.
Without `DM_PORT`, the app tries 4343 through 4353 and prints the selected address.
These defaults avoid the original Soccer/Pied Piper port range.
If a port is occupied, identify its owner; do not kill unrelated processes:

```powershell
Get-NetTCPConnection -LocalPort 4343 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

## 6. Update or roll back

1. Let work finish, or explicitly Stop it. Review/pause queued work.
2. Stop the server using Ctrl+C in its terminal.
3. Back up private state, excluding transient locks. Keep backups private and outside Git.
4. From the checkout, run:

```powershell
git status --short          # Preserve any local changes before updating
git pull --ff-only
Set-Location .\apps\dunder-mifflin-hq
npm ci
npm test
npm start
```

The example assumes the update starts at the repository root. Reapply private environment settings
in a new terminal. Refresh open browser tabs after restart because the per-start API token changes.
Do not run multiple HQ instances against the same private data directory.

To roll back, stop HQ and use a **separate checkout** of the known-good commit, install its lockfile,
and restore a compatible private-state backup if necessary. Do not discard uncommitted work or
assume older versions can interpret newer state formats.

## Validation and troubleshooting

From the app directory:

```powershell
npm test
# Optional real-Edge integration checks; isolated test profiles, no customer data:
$env:DM_TEST_EDGE = "1"
npm test
Remove-Item Env:DM_TEST_EDGE
```

| Symptom | Action |
|---|---|
| No response / model unavailable | Confirm Copilot sign-in and entitlement, select an enabled model, and read the visible error/activity. A failed or empty reply must not be treated as success. |
| Unauthorized after restart | Refresh the page to obtain the new API token. |
| Connector unavailable | Check its installation path and private configuration, then restart. |
| Report or CRM access denied | Sign in manually and verify that identity's permissions. HQ cannot grant them. |
| Document upload rejected | Check supported format and size; use text-based PDF/modern Office files. For scans or visual content, attach screenshots. |
| npm TLS or registry error | Use your organization's approved CA/proxy/registry configuration. Never disable certificate verification. |
| Browser busy / profile locked | Finish other HQ browser work; avoid parallel sessions using the same Edge profile. |
| Queue does not advance | Review the prior failure or uncertain admission, then explicitly resume if safe. |

Do not put customer screenshots, tokens, browser profiles, uploaded documents or private logs in issues.
Use synthetic reproductions and redact any sensitive information before sharing diagnostics.
