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
- The plugin has no client-side telemetry, advertising, or self-update mechanism.
- The plugin is desktop-only and declares that limitation in `manifest.json`.
