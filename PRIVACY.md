# Privacy and data handling

ServiceNow Manage is a local-first Obsidian desktop plugin. It does not operate a developer-controlled backend and does not include client-side telemetry, analytics, advertising, or usage tracking.

## Data stored locally

The plugin stores ordinary preferences and synchronization metadata through Obsidian's plugin data API. Examples include the root folder, synchronization schedule, UI preferences, connected account display name, and last synchronization time.

An optional organization pack is copied to `organization-pack.json` inside the local plugin directory. It may contain private workflow guides and templates supplied by the user's organization.

ServiceNow access tokens, Google access and refresh tokens, and the imported Google OAuth client secret are stored through Obsidian SecretStorage. They are not written to Markdown notes or the plugin's `data.json`. The imported OAuth JSON itself is not copied to the plugin directory. Obsidian 1.11.5 or later is required so SecretStorage benefits from the operating system's encryption support.

Ticket content, work notes, translated text, To-Do items, work logs, downloaded documents, and generated prompts are stored in the user's vault. The user controls the vault, its backup policy, and any synchronization service connected to it.

## Network connections

The plugin can connect to:

- The ServiceNow instance configured by the user, to read ticket details, work notes, state, and attachments and to complete OAuth operations when enabled.
- `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, and `drive.google.com`, when the optional Google Drive connection is used.
- `date.nager.at`, to retrieve the Republic of Korea public holiday calendar when automatic holiday synchronization is enabled.
- A translation provider selected in the separate Translate community plugin, when the user requests translation.

The plugin does not send data to a ServiceNow Manage developer-operated server.

## Local file access

The plugin reads and writes files in the active Obsidian vault. It uses the vault base path only when generating an AI prompt intended for a local CLI agent. It can open user-selected ServiceNow, Google Drive, Jira, or other document links in the system browser. It does not scan arbitrary folders outside the active vault.

## Accounts and permissions

ServiceNow permissions are determined by the credential supplied by the user. Google Drive uses the read-only Drive scope. Users should connect only accounts and credentials that they are authorized to use.

## Retention and deletion

- Disconnect ServiceNow to remove the ServiceNow secrets from Obsidian SecretStorage.
- Disconnect Google Drive to revoke the Google token when possible and remove the Google secrets from SecretStorage.
- Delete ticket notes or downloaded documents using normal Obsidian file operations when they are no longer needed.
- Uninstalling the plugin removes the plugin code but does not automatically delete notes or documents created in the vault.
- Removing an organization pack deletes the local plugin copy but intentionally does not delete templates or notes already present in the vault.

## Credential handling

Never place credentials in Markdown notes, screenshots, issue reports, GitHub commits, release assets, or public documentation. If a credential may have been exposed, revoke or rotate it immediately and review access logs according to the owning organization's procedure.
