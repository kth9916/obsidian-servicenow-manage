# ServiceNow Manage

ServiceNow tickets, work notes, document links, status updates, work logs, and To-Do dashboards inside Obsidian.

This is an independent community project. It is not affiliated with, endorsed by, or provided by ServiceNow or Obsidian.

Maintainer: **thkim9916** · `thkim9916@cyberlogitec.com`

## What's new in 2.17.0

- Optional AI Wiki under the configured work root, with standardized work records, ticket-summary links, metadata checks and a five-step connection helper.
- Compact cards or a saved spreadsheet-style table, shared search/filter/pagination, and a read-only detail popup before opening a Wiki note.
- Export-only editing for Jira tables, cell text and JSON, synchronized across formats without changing source notes.
- Keep every ticketless To-Do separate even when grouping ticket-based work; fill missing Ticket No. and Description only for this export.
- Clear pending/applied Wiki settings, visible confirmation actions, read-check status and approval boundaries.

See the [full 2.17.0 release notes](releases/2.17.0.md) for changes, upgrade steps, and limitations.

## Optional AI Wiki

AI Wiki is **off by default**, independent of organization packs and ServiceNow/Google sign-in. Skip its optional initial-setup step or enable it later in plugin settings. The Wiki lives under the configured work root, not a hard-coded project: `<root>/LLM WIKI` by default. Its folder name is configurable; changing that preference does not move existing records. Disabling the feature hides navigation and preserves files. It does not revoke permissions or data already shared with another AI.

- Open AI Wiki from the dashboard, ribbon, command palette, or a ticket. Browse recent, ticket-specific, topic-specific, and needs-review records. Lists use cached metadata, pagination and local file-change refresh, not repeated whole-Vault content reads.
- Choose compact summary cards or a six-column spreadsheet-style read-only table; the layout choice is saved. Table headings sort by title or date while search, filters and pagination remain shared. Review warnings use compact badges with full detail in the popup. Selecting a record opens a read-only detail popup first; closing it keeps the list, and opening the original note is an explicit action. Ticket-changing actions live in a separate expandable section.
- The detail popup shows the note body, summary, next action, review warnings, and whether its summary is already in each linked ticket's work log. Adding a summary requires confirmation and appends the standard entry plus the Wiki link to the ticket note. It does not move the Wiki note, change ticket state or To-Dos, duplicate an existing record ID, or automatically update an older work-log snapshot when the Wiki changes.
- Keep detailed work records in `작업기록`, reusable verified knowledge in `지식`, and attachments in `첨부`. Human-facing guides remain separate. Multiple tickets can share one record; ticketless work is supported. Existing notes are never automatically reclassified or moved.
- The AI start guide offers Codex, Claude, ChatGPT and other providers, copyable folder-preparation and starter requests, and a user-mediated file-read challenge. Step 2 copies a complete request to send to the AI; copying only the folder path is for a folder picker. After the AI confirms read access, step 3 sends the Wiki recording rules in the same chat.
- Local folder permissions and sign-in must be configured in the selected AI. Ordinary web chat cannot read a local path by itself; use an approved connector or explicitly attach selected files. App paths and CLI commands are not needed for the basic workflow. The optional local app launcher lives separately in advanced plugin settings. Opening an app is **not** an authenticated connection. No prompts or notes are automatically sent to an AI, no agent is run in the background, and no AI API key is stored.
- Recording defaults to asking before saving. A separate setting can tell the AI it may maintain request-related files inside the Wiki only. This is prompt guidance, not an OS permission boundary, and does not authorize ticket-body changes, code/DB changes, external messages, or ServiceNow/Jira/Confluence updates.
- A portable `ai-wiki-recorder/SKILL.md` is supplied inside the Wiki, **not automatically installed**. No existing AGENTS.md, CLAUDE.md, AI configuration, or global skills are overwritten. Unknown chat/task IDs remain unknown; the plugin cannot audit missing work from inaccessible conversations.
- The record format includes IDs, dates, tickets, topic, summary, verification and sources. Duplicate IDs and incomplete evidence appear under needs-review. This checks record metadata, not the truth of an AI conclusion. AI recording instructions require read-back verification and preservation of manual content.

The generated `AI 시작 안내.md` explains the start workflow and links to official AI connection documentation. No version number, tag or release is created by enabling this feature.

Wiki settings distinguish unsaved folder edits, applying, applied and failed states. The usage/recording switches save immediately; only folder-name edits need the Apply button. Slow saves show progress and automatically unlock dependent controls when complete, without discarding a folder draft.

The five-step connection helper guides AI selection, folder or attachment preparation, the starter prompt, a read-response check, and the result. The last successful check (provider, Wiki location, non-secret challenge code, access method and time) is stored locally and shown after reopening. Local read checks and attachment-only delivery checks have different labels. Changing the Wiki location, losing/changing the check file or an unsuccessful save cannot show a valid local connection. This is historical read-check evidence, not live AI authentication or write authorization.

Preparation and prompt-delivery confirmations are explicit buttons in the pinned footer, not separate checkboxes: confirm folder-read/attachment preparation and continue, then confirm prompt delivery and continue. These are user acknowledgements only; the later file-read challenge remains required before a connection check can be saved.

## Previous release: 2.16.0

- Separate active work from archived/dormant history, with shared lifecycle settings, on-demand history loading, and automatic reactivation when opening a ticket's root note.
- Import weekly/common meetings without a ticket, then link, relink, or unlink tickets later. File and Drive imports share searchable multi-select chips and an explicit ticketless option.
- Refresh the DS before selecting Schedule or PROD Schedule activities to create To-Dos. Choose Start or End as the due-date basis, preserve the creation time for date-only rows, and optionally add review preparation.
- Create related-note indexes and child notes directly from a ticket or its index, with navigation back to both the original ticket and the parent index.
- Filter Jira Export by multiple To-Do states; confirm temporary memos and preserve multiline paragraph/list spacing in cell-text output.
- Use shared To-Do sorting, current-time buttons, configurable popup width (75% default), compact toolbars, readable date fields, and a pinned To-Do action footer.
- Improve Drive document matching for separator whitespace and paginated results, and fix excessive date-control spacing and clipped responsive Export panels.

See the [full 2.16.0 release notes](releases/2.16.0.md) for changes, upgrade steps, and limitations.

### Previous release: 2.15.0

- Not started, In progress, **Pending (waiting)**, and Done are separate states. Existing unchecked tasks remain Not started.
- Pending supports an optional waiting reason and follow-up date, separate from the completion due date. Cards show the waiting start date and highlight follow-ups due today or earlier; states never resume automatically.
- Use the Pending / follow-up-needed filters, drag cards between columns, and edit the same task from the ticket note or dashboard. Calendar date filtering and Jira table/JSON export include the new waiting fields.
- Configure state names, enabled states, and their order from either board or plugin settings. The configuration is shared across ticket notes and the dashboard; creation only offers enabled states. Existing tasks in disabled states remain available in the inactive-state viewer.
- Work guide pack and Google OAuth JSON import/replacement open visible dialogs with file selection, pasted JSON, validation, and retry, including after initial setup.


## Requirements and disclosures

Meeting-to-ticket links are optional. File import and Google Drive import both offer a "Save without a ticket (weekly/common meeting)" choice, including when started from a ticket note. Unlinked notes and optional PDFs are stored under the configured root's `회의록` folder and appear in the dashboard's weekly/common meeting group. Drive's general automatic search finds Gemini meeting documents without requiring a ticket number; direct title search also supports other meeting names. No-ticket Drive imports are checked for duplicate source IDs in the unlinked history.

Existing source meeting notes can be linked, relinked, or unlinked later from their note or meeting cards. This updates `ticket`, `tickets`, `Parent`, `Parents`, and the generated ticket-summary row in one note write; unrelated metadata and meeting content are preserved. Files/PDFs are not moved or copied. All linked ticket lists share the same note, and clearing links returns it to the weekly/common group regardless of its original folder. Ticket-specific AI analysis documents are not reassigned; change links on the source meeting instead.

Active/history management keeps completed-state tickets out of scheduled refreshes and the default dashboard, without moving or deleting notes. Dormancy defaults to both three calendar months without opening the root note and six months without meaningful changes; first-time observation starts now rather than inventing older visit history. The default completed states are Implemented, Closed, Resolved, and Cancelled, with seven days of change grace. Recent root-note visits and unfinished To-Dos keep a ticket active. Lifecycle settings apply globally rather than requiring per-ticket configuration. Opening a root note records a visit and reactivates it. Background reads, search results, and unchanged synchronizations do not count as visits. Archived remote changes are not polled automatically; open the root note or run a manual inclusive refresh to check them.

The dashboard offers Active, All, Archived, and Dormant scopes. Exact ticket-number lookup can find archived/dormant notes even with table filters; ordinary history search is available in the inclusive scope. Root-note details are loaded on demand and reused until modified. Activity timestamps, hashes, and a bounded text/reference index are stored only in the Vault plugin folder's private `ticket-activity.json`; Vault backup/sync settings still apply. Existing ticket contents and ServiceNow states are not rewritten by classification. Configurable periods and completed states are shared between ticket notes and the dashboard.

- Obsidian Desktop 1.11.5 or later. Mobile is not supported because the plugin uses desktop OAuth callback and Electron/Node APIs.
- A ServiceNow account and an approved API token are required only for ServiceNow synchronization. Local note and To-Do features remain available without a connection.
- Google Drive integration is optional and requires a user-supplied Google Desktop OAuth JSON file and a Google account with access to the target files.
- Organization-specific status guides, SLA rules, and AI templates are not bundled. They appear only after the user imports a separately supplied ServiceNow Manage work guide pack and enables work guide features.
- The plugin connects only to the ServiceNow instance configured by the user, Google OAuth/Drive when enabled, Nager.Date for optional public-holiday lookup, and a translation provider selected through an optional translation plugin.
- The plugin has no developer-operated backend, client telemetry, analytics, advertising, or automatic self-update mechanism.
- Tokens and client secrets are stored with Obsidian Secret Storage. Do not put tokens, OAuth JSON, `data.json`, or organization packs in a public repository or GitHub Release.
- Ticket details and downloaded documents are written to the user's Vault. Users are responsible for Vault access, backup, and sync permissions.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Main features

- Create CR/SR ticket notes and related work-note views.
- Refresh ticket metadata and work notes from ServiceNow.
- Search, sort, filter, translate, copy, and date-filter work notes.
- Create work logs and To-Dos from ticket notes or a dashboard.
- Import Gemini meeting minutes from Markdown, optionally preserve the source PDF, and browse chronologically linked meeting notes from either the ticket note or dashboard.
- View To-Dos as a configurable four-state board with due dates, completion dates, search, details, and pagination.
- Maintain a configurable ticket dashboard with persistent columns, sorting, filters, widths, and field order.
- Optionally discover BS links from a description and FS/DS/UT files from Google Drive naming conventions.
- Optionally generate organization-specific AI prompts when an organization pack is installed.
- Optionally browse AI Wiki records as cards or a table and preview the original Markdown in a detail popup.
- Edit a shared Jira Export draft across table, cell-text and JSON formats without writing back to source notes.
- Schedule daily status refresh and optional work-note refresh.
- Configure the CR, SR, and Incident ServiceNow table names for different instances.

## First setup

The first time the plugin starts, it opens a setup wizard. The wizard checks these items without bundling any organization credentials:

1. Choose the Vault root folder. New installations use `ServiceNow`.
2. Enter the full ServiceNow instance URL and, when applicable, a Bearer Token issued for the user or organization.
3. Optionally import a Google Desktop OAuth JSON file or paste the JSON content.
4. Optionally import a separately supplied work guide pack.
5. Optionally enable AI Wiki and review its access and recording guidance. Skip this step to leave it disabled; it can be enabled later.
6. Review the summary and finish.

Selecting **Set up later** dismisses the automatic wizard without disabling the plugin. Open it again from **Settings → ServiceNow Manage → Initial setup wizard** or from the command palette. All individual options remain available in the normal settings page.

After the wizard, change the CR/SR API table names under advanced settings if the instance uses custom tables. Optionally connect the Google account, enable document automation, translation, scheduled refresh, and public-holiday lookup.

Never use a browser session cookie or another person's token as an API token.

## Work guide packs

A work guide pack is a local JSON file supplied separately by an organization. It can contain:

- CR/SR status guides;
- organization SLA/due-date rules;
- an AI prompt template;
- CR/SR AI analysis templates;
- optional feature flags.

Import it from **Settings → ServiceNow Manage → Work guide pack → Import JSON**. Uploading a newer pack replaces the active guide, rules, and feature configuration. The plugin copies the validated pack to its local plugin directory as `organization-pack.json`. This file is intentionally excluded from the public source repository.

Without a pack, status-guide and organization AI-prompt controls are hidden. Removing or disabling the pack hides those controls but does not delete user-authored Vault notes.

Google OAuth JSON is not a work-guide-pack license or access-control mechanism. Desktop OAuth client IDs can be copied and are not a secure way to authorize private workflow content.

See [ORGANIZATION_PACK.md](ORGANIZATION_PACK.md) for the schema, a credential-free example, and safe distribution guidance.

Work guide packs may be revised and distributed independently of plugin releases. Keep the same `packId`, increment the optional `version`, and import the newer JSON with **Replace pack**. Runtime guides and rules use the replacement immediately. Existing user-edited Vault templates are preserved rather than overwritten.

## Google Drive

Google Drive integration is optional. Import a Google Desktop OAuth JSON file, connect a Google account, and grant read-only Drive access. The client secret and account tokens use Obsidian Secret Storage; the client ID and non-secret connection metadata use normal plugin settings.

The built-in document rules are conventions, not universal ServiceNow behavior. Disable document automation if an organization uses different BS/FS/DS/UT locations or naming rules.

## Translation

Translation is optional and uses a compatible Obsidian translation plugin/provider configured by the user. Provider limits, billing, privacy, and retention are controlled by that provider.

## Data and removal

Disabling or uninstalling ServiceNow Manage does not delete ticket Markdown files, downloaded documents, work logs, or To-Dos. Disconnect ServiceNow and Google first if the stored credentials must be removed from Secret Storage.

## Community release

Before a public release:

1. Run `npm test`.
2. Run `npm run security:audit`.
3. Run `npm run release:check`.
4. Confirm that `manifest.json`, `package.json`, `versions.json`, and the GitHub tag use the same version.
5. Attach `main.js`, `manifest.json`, and `styles.css` as individual GitHub Release assets.
6. Never publish `data.json`, OAuth JSON, `organization-pack.json`, private work guide packs, Vault contents, credentials, or company documents.

See [COMMUNITY_RELEASE_CHECKLIST.md](COMMUNITY_RELEASE_CHECKLIST.md) for the complete release checklist.

## Updating and releasing later versions

The maintainer can continue using and modifying the development copy after the first Community Plugin release. Publish a new GitHub Release whenever a tested plugin update is ready:

- patch (`2.0.1`) for compatible fixes;
- minor (`2.1.0`) for compatible features;
- major (`3.0.0`) for breaking changes or migrations.

Update `manifest.json`, `package.json`, and `versions.json` together, run all release checks, create a GitHub tag exactly matching the version, and attach `main.js`, `manifest.json`, and `styles.css`. Obsidian can then offer the new release to existing users through the Community Plugin update flow. A work-guide-pack-only content update does not require a plugin version change while its schema remains compatible.
