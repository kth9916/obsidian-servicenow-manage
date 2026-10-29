# Privacy and data handling

## Optional AI Wiki

AI Wiki is disabled by default. When explicitly enabled, its Markdown records and guides are stored below the user-configured work root. The plugin lists local record metadata and does not collect external chat histories. Chat/task IDs, summaries and evidence links supplied by users or their AI are ordinary Vault data, subject to the user's backup/sync choices.

The plugin does not store AI API keys, run AI agents, install external skills automatically, alter AI permission settings, or send prompts/notes to AI services. Copying a prompt affects only the clipboard. Opening an AI website sends a normal browser request without the prompt or note content. The optional local launcher opens only an explicitly specified supported app path, without arguments or note data. A local read-check note contains a random non-secret code; users manually compare the AI's response. This is not a persistent connection or permission guarantee.

After a successful user-mediated check, ordinary plugin settings retain its provider, Wiki path, non-secret challenge code, local/attachment method and confirmation time to display the last check. No AI login session or authentication token is collected. The helper distinguishes attachment delivery from direct local access, and a changed/missing proof or Wiki location requires rechecking.

Sharing records with an AI, granting its local-file permissions, installing its skills, or uploading attachments is a separate user action governed by that service and organization policy. Disabling AI Wiki preserves existing files and does not recall shared data or revoke external AI permissions. The Wiki's recording preference is guidance for prompts, not a technical sandbox or authority to change external systems.

ServiceNow Manage is a local-first Obsidian desktop plugin. It does not operate a developer-controlled backend and does not include client-side telemetry, analytics, advertising, or usage tracking.

## Data stored locally

The plugin stores ordinary preferences and synchronization metadata through Obsidian's plugin data API. Examples include the root folder, synchronization schedule, UI preferences, connected account display name, and last synchronization time.

An optional organization pack is copied to `organization-pack.json` inside the local plugin directory. It may contain private workflow guides and templates supplied by the user's organization.

ServiceNow access tokens, Google access and refresh tokens, and the imported Google OAuth client secret are stored through Obsidian SecretStorage. They are not written to Markdown notes or the plugin's `data.json`. The imported OAuth JSON itself is not copied to the plugin directory. Obsidian 1.11.5 or later is required so SecretStorage benefits from the operating system's encryption support.

The optional Atlassian connection also keeps its public-client registration and access/refresh tokens in SecretStorage. Ordinary settings contain only the account display label, discovered site labels/URLs/IDs, selected site, optional test issue/page identifiers, and per-service test state/timestamps. Login codes, PKCE verifiers, OAuth state, tokens, issue titles/bodies and page contents are not serialized to ordinary settings, logs or Markdown by this connection feature. Service content is read temporarily to verify access, not sent to an AI model or stored as Wiki records.

Ticket content, work notes, translated text, To-Do items, work logs, downloaded documents, and generated prompts are stored in the user's vault. The user controls the vault, its backup policy, and any synchronization service connected to it.

## Network connections

The plugin can connect to:

- The ServiceNow instance configured by the user, to read ticket details, work notes, state, and attachments and to complete OAuth operations when enabled.
- `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, and `drive.google.com`, when the optional Google Drive connection is used.
- `mcp.atlassian.com` and `auth.atlassian.com`, when the optional Atlassian connection is enabled and the user starts login or connection testing. The browser may use the user's organization identity provider during company sign-in. Authentication uses official metadata discovery, dynamic public-client registration, PKCE and a temporary `127.0.0.1:42816` callback listener. No developer backend or pasted personal API token is involved. Only identity, offline access and Jira/Confluence read/search scopes are requested; no write/delete/manage tools are callable through the plugin integration.
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
- Disconnect Atlassian to remove its local authentication secrets and attempt server-side token revocation. If revocation cannot be confirmed, the UI explains how to review the connected app in the Atlassian account. Disabling the optional feature stops requests and cancels pending login, but preserves credentials and site/test preferences for later reconnection; it does not revoke server-side consent.
- Delete ticket notes or downloaded documents using normal Obsidian file operations when they are no longer needed.
- Uninstalling the plugin removes the plugin code but does not automatically delete notes or documents created in the vault.
- Removing an organization pack deletes the local plugin copy but intentionally does not delete templates or notes already present in the vault.

## Credential handling

Never place credentials in Markdown notes, screenshots, issue reports, GitHub commits, release assets, or public documentation. If a credential may have been exposed, revoke or rotate it immediately and review access logs according to the owning organization's procedure.
