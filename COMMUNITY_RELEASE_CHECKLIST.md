# Community release checklist

## Legal and company approval

- [ ] Confirm that organization packs, credentials, internal workflow guides, templates, and screenshots are excluded from the public repository.
- [ ] Confirm who owns and maintains the public repository: an approved GitHub organization is preferable to a personal account.
- [ ] Choose an approved open-source or source-available license and add it as `LICENSE` at the repository root.
- [ ] Confirm that the plugin name, ServiceNow references, and screenshots follow company and trademark policy.

## Repository isolation

- [ ] Create a separate public repository whose root is this plugin directory. Never publish the parent workspace.
- [ ] Keep `README.md`, `PRIVACY.md`, `SECURITY.md`, `LICENSE`, `manifest.json`, `versions.json`, and source files in the repository root.
- [ ] Do not commit a Vault, `.obsidian` configuration, `data.json`, OAuth JSON, ticket note, business document, screenshot containing customer data, or backup folder.
- [ ] Enable GitHub secret scanning, Dependabot alerts, and private vulnerability reporting when available.

## Source and generated assets

- [ ] Keep the editable dashboard source in `resources/업무현황.md`.
- [ ] After editing it, run `node scripts/embed-dashboard.mjs`.
- [ ] Keep the editable AI guides in `resources/CR_TEMPLATE.md` and `resources/SR_TEMPLATE.md`.
- [ ] After editing them, run `node scripts/embed-analysis-templates.mjs`.
- [ ] Explain generated and compressed resources in the README so reviewers can trace them to their editable source.

## Security and quality gate

- [ ] Run `node scripts/community-security-audit.mjs`.
- [ ] Run `node scripts/run-tests.mjs`.
- [ ] Run `node scripts/community-release-check.mjs`.
- [ ] Confirm there is no ServiceNow token, Google OAuth client ID or secret, OAuth JSON, account email, customer URL, real ticket number, or company document in the repository or Git history.
- [ ] Confirm `manifest.json`, `package.json`, and `versions.json` use the same release version and correct minimum Obsidian version.
- [ ] Test installation and first-run behavior in a clean Obsidian Desktop 1.11.5+ vault.
- [ ] Test with no ServiceNow or Google connection, ServiceNow only, and ServiceNow plus Google Drive.

## GitHub release

- [ ] Commit and push the final source to the default branch.
- [ ] Create a GitHub release whose tag exactly matches `manifest.json` version, without a `v` prefix. Example: `2.0.0`.
- [ ] Upload `main.js`, `manifest.json`, and `styles.css` as individual release assets.
- [ ] Download the assets from the published release and compare their hashes with the locally tested files.
- [ ] Confirm the release is public and not a draft or prerelease for the initial directory submission.

## Community directory submission

- [ ] Sign in at `https://community.obsidian.md` with an Obsidian account.
- [ ] Connect the GitHub account that owns the public repository.
- [ ] Select **Plugins → New plugin** and enter the public repository URL.
- [ ] Review and accept the developer policies and maintenance commitment.
- [ ] Resolve automated review findings by publishing a new patch version and matching release assets.

## Internal rollout

- [ ] Publish the internal Confluence guide without embedding a raw token or OAuth secret.
- [ ] Provide credentials through an approved secret-sharing channel, with owner, scope, expiration, and rotation information.
- [ ] Define support ownership, incident reporting, release notes, and rollback procedure.
- [ ] Pilot with a small internal group before broad rollout.
