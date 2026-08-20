const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(path.resolve(__dirname, "..", "resources", "업무현황.md"), "utf8");
const section = (startMarker, endMarker) => {
  const start = dashboard.indexOf(startMarker);
  const end = dashboard.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Missing section: ${startMarker}`);
  return dashboard.slice(start, end);
};

const headerFactory = Function(
  "activeSorts",
  "escapeAttribute",
  "escapeHtml",
  `${section("function createHeaderHtml(", "function bindColumnResize(")}; return createHeaderHtml;`
)([], String, String);
const headerHtml = headerFactory({ key: "status", label: "상태", type: "text" });
if (!headerHtml.includes('draggable="true"')) throw new Error("Rendered header is not draggable");
if (headerHtml.includes("opus-header-drag-handle") || headerHtml.includes("⠿")) throw new Error("Redundant header drag icon remains");
if (dashboard.includes("const controlVisibilityButton =")) throw new Error("Empty toolbar condition button remains");
if (!dashboard.includes("opus-filter-display-toggle")) throw new Error("Applied-condition visibility option was not moved into the filter menu");
if (!dashboard.includes("margin-top: 14px")) throw new Error("Filter toggle separation spacing is missing");
if (!dashboard.includes("showAppliedFilters:") || !dashboard.includes("showAppliedSorts:")) throw new Error("Filter and sort visibility settings are not separated");
if (!dashboard.includes("적용된 필터 조건을 표 위에 표시")) throw new Error("Filter visibility label is missing");
if (!dashboard.includes("적용된 정렬 조건을 표 위에 표시")) throw new Error("Sort visibility label is missing");
if (!dashboard.includes("if (settings.showAppliedFilters !== false)")) throw new Error("Filter chips are not visibility-gated");
if (!dashboard.includes("if (settings.showAppliedSorts !== false)")) throw new Error("Sort chips are not visibility-gated");
if (!dashboard.includes('data-todo-ticket-id="${escapeAttribute(page.id || page.file.name)}"')) throw new Error("To-Do quick-add is not ticket-ID based");
if (!dashboard.includes('data-todo-list-ticket-id="${escapeAttribute(page.id || page.file.name)}"')) throw new Error("Ticket-specific To-Do list button is missing");
if (!dashboard.includes("function handleTodoQuickAddClick(")) throw new Error("Delegated To-Do quick-add click handler is missing");
if (dashboard.includes("data-todo-add-index=")) throw new Error("Legacy row-index To-Do quick-add remains");
if (!dashboard.includes("const TODO_PAGE_SIZE = 10;")) throw new Error("To-Do page size is missing");
if (!dashboard.includes("todoVisibleLimits[status.key]")) throw new Error("Independent To-Do column limits are missing");
if (!dashboard.includes("tasks.slice(0, visibleLimit)")) throw new Error("To-Do cards are not rendered in bounded batches");
if (!dashboard.includes("searchActive ? tasks")) throw new Error("Search results do not bypass pagination");
if (!dashboard.includes("}, 140);")) throw new Error("To-Do search rendering is not debounced");
if (!dashboard.includes(".opus-todo-load-more {")) throw new Error("To-Do load-more UI is missing");
if (!dashboard.includes(".markdown-preview-sizer:has(.opus-dashboard)")) throw new Error("Dashboard readable-line-length override is missing");
if (!dashboard.includes('summaryCard.className = "opus-worklog-ticket-summary"')) throw new Error("Work-log ticket summary is missing");
if (!dashboard.includes('item.page["마지막확인"] = dateTime.slice(0, 10)')) throw new Error("Work-log last-checked live refresh is missing");
if (!dashboard.includes("async function deleteTodo(task)")) throw new Error("Dashboard To-Do delete fallback is missing");

console.log("Dashboard rendered UI checks passed");
