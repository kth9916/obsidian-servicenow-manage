# ServiceNow Manage

ServiceNow tickets, work notes, document links, status updates, work logs, and To-Do dashboards inside Obsidian.

This is an independent community project. It is not affiliated with, endorsed by, or provided by ServiceNow or Obsidian.

Maintainer: **thkim9916** · `thkim9916@cyberlogitec.com`

## Requirements and disclosures

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
- View To-Dos as a three-state board with due dates, completion dates, search, details, and pagination.
- Maintain a configurable ticket dashboard with persistent columns, sorting, filters, widths, and field order.
- Optionally discover BS links from a description and FS/DS/UT files from Google Drive naming conventions.
- Optionally generate organization-specific AI prompts when an organization pack is installed.
- Schedule daily status refresh and optional work-note refresh.
- Configure the CR, SR, and Incident ServiceNow table names for different instances.

## First setup

The first time the plugin starts, it opens a setup wizard. The wizard checks these items without bundling any organization credentials:

1. Choose the Vault root folder. New installations use `ServiceNow`.
2. Enter the full ServiceNow instance URL and, when applicable, a Bearer Token issued for the user or organization.
3. Optionally import a Google Desktop OAuth JSON file or paste the JSON content.
4. Optionally import a separately supplied work guide pack.
5. Review the summary and finish.

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
