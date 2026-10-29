# Security policy

## Supported version

Security fixes are provided for the latest published version of ServiceNow Manage. Users should update Obsidian and this plugin before reporting a problem.

## Reporting a vulnerability

Do not include ServiceNow tokens, OAuth JSON files, client secrets, account email addresses, ticket content, or business documents in a public GitHub issue.

Use GitHub private vulnerability reporting when it is enabled for the public repository. Organization users should also follow the approved company security incident channel. Include the plugin version, Obsidian version, operating system, reproduction steps, and a redacted screenshot or log.

If private vulnerability reporting is not available, contact the maintainer at `thkim9916@cyberlogitec.com`. Never send live credentials or unredacted customer data by email.

## Credential exposure response

If a ServiceNow or Google credential may have been exposed:

1. Disconnect the account in the plugin when possible.
2. Revoke or rotate the credential at the identity provider.
3. Remove the credential from notes, screenshots, issue trackers, Git history, and release assets.
4. Review relevant access logs and follow the owning organization's incident process.
5. Reconnect only with a newly issued credential.

## Security design

- Sensitive credentials use Obsidian SecretStorage and are not stored in plugin `data.json`.
- OAuth callbacks bind only to `127.0.0.1` or `localhost` and use state validation; ServiceNow OAuth uses PKCE.
- Google Drive requests use the read-only Drive scope.
- Optional Atlassian login discovers official OAuth metadata, registers a public client, uses PKCE S256 and a random state, and binds only to `127.0.0.1:42816`. Invalid callbacks do not consume the login; valid callbacks, denial, cancellation, timeout and unload clean up the listener. No token is sent through an untrusted URL or followed redirect. Secrets are held in SecretStorage; UI/errors expose only sanitized state.
- Atlassian defaults to read/search scopes. Separate opt-in Jira editing requests the official Jira write scope, never delete/manage or Confluence write scopes. Canceled consent upgrades preserve existing read credentials. Each product must pass an actual content read; historical results and expired tokens cannot masquerade as current success.
- MCP dispatch has fixed primary/deferred-read allowlists. Jira mutations accept only new comments, workflow transition IDs, and the due-date field. Each requires a short-lived, payload/site/epoch-bound single-use approval created by the confirmation flow; no generic write/execute operation is exposed. Automatic refresh never creates write approval. Mutation requests are never automatically retried. Source conflicts are rejected before dispatch; missing acknowledgement/read-back locks further changes until the user checks Jira.
- Jira HTML/ADF is converted to inert Markdown; arbitrary local embeds and remote images are blocked. Attachment downloads use an exact media origin/path allowlist, no bearer header or redirects, image magic checks, timeouts and size limits. API-supplied shell commands are never executed. Internal/restricted comments remain labeled and excluded from default external-AI prompt export. Local comment archives/caches remain ordinary business data, not encrypted secrets.
- The plugin has no client-side telemetry, advertising, or self-update mechanism.
- The plugin is desktop-only and declares that limitation in `manifest.json`.
