# Work guide packs

ServiceNow Manage is intentionally generic. A work guide pack is an optional local JSON file that adds private workflow content without publishing it in the Community Plugin repository.

A work guide pack can provide:

- CR and SR state lists;
- state-specific work guides;
- SLA and target-date rules;
- organization-specific AI prompt instructions;
- CR and SR analysis templates;
- feature switches for guides, prompts, SLA rules, and document automation.

It must not contain ServiceNow tokens, Google OAuth credentials, cookies, passwords, email addresses, customer data, or private keys.

## Import and storage

Import the JSON from **Settings → ServiceNow Manage → Organization resources**. The plugin validates it and writes a local copy to:

```text
.obsidian/plugins/servicenow-manage/organization-pack.json
```

The file is ignored by this repository. Removing or disabling the pack hides its guide and AI-prompt controls. It does not delete ticket notes or user-authored content.

## Schema

The current schema version is `1`. See [examples/organization-pack.example.json](examples/organization-pack.example.json).

Required top-level fields:

- `schemaVersion`: `1`
- `packId`: stable organization-defined identifier
- `name`: display name
- one or more of `statusGuides`, `analysisTemplates`, or `promptTemplate`

Recommended version field:

- `version`: pack publisher's independent version such as `1.1.0`

Recommended feature flags:

```json
{
  "statusGuides": true,
  "aiPrompt": true,
  "slaRules": true,
  "documentAutomation": false
}
```

`states.CR` and `states.SR` are top-level arrays. `statusGuides.CR` and `statusGuides.SR` are top-level objects keyed by the exact ServiceNow state value. A guide may contain `meaning`, `next`, `owner`, `target`, `actions`, `alert`, and `workNoteTemplates`. `workNoteTemplates` is an optional array whose items contain `title`, `content`, and an optional `note`; the status guide displays each template with its own copy button.

## Distribution

Distribute work guide packs separately from the public plugin. Use a restricted internal knowledge-base attachment or another approved document channel. Treat the pack as internal business material even though it must contain no authentication secrets.

Google Desktop OAuth JSON is not a license key and must not be used to unlock the pack. A Desktop client identifier can be copied and does not prove that the user is authorized to view an organization's process content.

## Independent pack updates

The pack publisher may update and redistribute the JSON without publishing a new plugin release when the current schema remains compatible.

1. Keep `packId` stable so users can identify the same pack.
2. Increase `version` for each approved distribution.
3. Publish the new file through the organization's restricted documentation channel.
4. Users select **Replace pack** in plugin settings and choose the new JSON.
5. Confirm the displayed pack name and version after import.

Status guides, state lists, SLA rules, feature flags, and in-pack prompt data become active from the replacement pack. The plugin deliberately does not overwrite existing `CR_TEMPLATE.md`, `SR_TEMPLATE.md`, or AI template files in the Vault because users may have customized them. If the organization requires a template-content update, distribute the revised template separately or instruct users to back up and replace the relevant Vault template deliberately.

Changing or removing the pack never deletes ticket notes, work logs, To-Dos, downloaded documents, or user-authored templates.
