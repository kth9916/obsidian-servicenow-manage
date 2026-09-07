# Design QA

- source visual truth paths:
  - `C:\Users\2026020\AppData\Local\Temp\codex-clipboard-5ae05094-9228-4bf0-91c0-529c82d786b5.png`
  - `C:\Users\2026020\AppData\Local\Temp\codex-clipboard-f462b0a8-f87a-43f1-8a47-b37def26ed2b.png`
  - `C:\Users\2026020\AppData\Local\Temp\codex-clipboard-7103d459-963a-4c04-b84f-2f286b68a3d7.png`
- implementation screenshot path: unavailable
- viewport: Obsidian native window, unavailable through the current Computer Use connection
- state: Jira Export table/cell-text modes and To-Do calendar month/week/day modes
- full-view comparison evidence: blocked because the current Windows automation connection exposes browser tabs but no native Obsidian app surface
- focused region comparison evidence: source screenshots were inspected; implementation could not be captured from Obsidian

## Findings

- No code-level P0/P1 issue remains in the automated checks.
- Native visual comparison remains blocked. The installed dashboard must be opened after reloading the plugin to confirm final spacing and text wrapping in the user's active Obsidian theme.

## Comparison history

- Original Jira Export screenshot showed grouped detail values such as `• - item`. The formatter now produces a numbered To-Do heading with normalized `- item` children.
- Original preview only exposed an HTML table. A selectable plain-text preview and plain-text clipboard path were added for pasting into one existing Jira table cell.
- The original To-Do board had no calendar state. Month, week, and day views using due dates and the existing search/status/date filters were added.

## Required fidelity surfaces

- Fonts and typography: existing Obsidian theme fonts and dashboard sizes are reused; native rendering not captured.
- Spacing and layout rhythm: existing toolbar, panel, border, radius, and spacing tokens are reused; native rendering not captured.
- Colors and visual tokens: only existing Obsidian semantic variables are used.
- Image quality and asset fidelity: no image assets are introduced.
- Copy and content: Korean labels cover board/calendar, month/week/day, status filters, table mode, and one-cell text mode.

## Implementation checklist

- Reload ServiceNow Manage in Obsidian.
- Open 업무현황 and switch To-Do board to calendar.
- Verify month/week/day navigation and 진행 전/진행 중 filters.
- Open Jira Export for CR0021518 and verify both preview modes.
- Drag-select preview text and paste the one-cell mode into an existing Jira table cell.

final result: blocked
