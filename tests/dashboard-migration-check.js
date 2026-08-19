const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const start = main.indexOf("function upgradeDashboardPopupFieldGrid(");
const end = main.indexOf("\nfunction ", start + 1);
if (start < 0) throw new Error("Dashboard popup migration was not found");
eval(main.slice(start, end));

const todoStart = main.indexOf("function upgradeDashboardTodoCreation(");
const todoEnd = main.indexOf("\nfunction ", todoStart + 1);
if (todoStart < 0) throw new Error("Dashboard To-Do migration was not found");
eval(main.slice(todoStart, todoEnd));

const visibilityStart = main.indexOf("function upgradeDashboardControlVisibility(");
const visibilityEnd = main.indexOf("\nfunction ", visibilityStart + 1);
if (visibilityStart < 0) throw new Error("Dashboard control visibility migration was not found");
eval(main.slice(visibilityStart, visibilityEnd));

const detailsStart = main.indexOf("function upgradeDashboardTodoDetails(");
const detailsEnd = main.indexOf("\nfunction ", detailsStart + 1);
if (detailsStart < 0) throw new Error("Dashboard To-Do details migration was not found");
eval(main.slice(detailsStart, detailsEnd));

const summaryStart = main.indexOf("function upgradeDashboardTodoSummaryColumn(");
const summaryEnd = main.indexOf("\nfunction ", summaryStart + 1);
if (summaryStart < 0) throw new Error("Dashboard To-Do summary migration was not found");
eval(main.slice(summaryStart, summaryEnd));

const sharedModalStart = main.indexOf("function upgradeDashboardSharedTodoModal(");
const sharedModalEnd = main.indexOf("\nfunction ", sharedModalStart + 1);
if (sharedModalStart < 0) throw new Error("Dashboard shared To-Do modal migration was not found");
eval(main.slice(sharedModalStart, sharedModalEnd));

const fieldOrderingStart = main.indexOf("function upgradeDashboardFieldOrdering(");
const fieldOrderingEnd = main.indexOf("\nfunction ", fieldOrderingStart + 1);
if (fieldOrderingStart < 0) throw new Error("Dashboard field ordering migration was not found");
eval(main.slice(fieldOrderingStart, fieldOrderingEnd));

const paginationStart = main.indexOf("function upgradeDashboardTodoPagination(");
const paginationEnd = main.indexOf("\nfunction ", paginationStart + 1);
if (paginationStart < 0) throw new Error("Dashboard To-Do pagination migration was not found");
eval(main.slice(paginationStart, paginationEnd));

const oldDashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");
const upgraded = upgradeDashboardPopupFieldGrid(oldDashboard);
if (!upgraded.includes("repeat(4, minmax(0, 1fr))")) throw new Error("Four-column grid was not added");
if (!upgraded.includes("grid.appendChild(button)")) throw new Error("Field buttons were not moved into the grid");
if (!upgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("Manual root setting was changed");
if (upgradeDashboardPopupFieldGrid(upgraded) !== upgraded) throw new Error("Migration is not idempotent");

const bundledDashboard = oldDashboard;
const todoUpgraded = upgradeDashboardTodoCreation(upgraded, bundledDashboard);
if (!todoUpgraded.includes("function openTodoCreateModal(")) throw new Error("To-Do create modal was not added");
if (!todoUpgraded.includes("clt-todo-due:")) throw new Error("To-Do due date support was not added");
if (!todoUpgraded.includes("function openTodoCreateModal(")) throw new Error("To-Do creation UI was not added");
if (!todoUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("To-Do migration changed the manual root setting");
if (upgradeDashboardTodoCreation(todoUpgraded, bundledDashboard) !== todoUpgraded) throw new Error("To-Do migration is not idempotent");
const visibilityUpgraded = upgradeDashboardControlVisibility(todoUpgraded, bundledDashboard);
if (!visibilityUpgraded.includes("showAppliedControls")) throw new Error("Control visibility setting was not added");
if (!visibilityUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("Visibility migration changed the manual root setting");
if (upgradeDashboardControlVisibility(visibilityUpgraded, bundledDashboard) !== visibilityUpgraded) throw new Error("Visibility migration is not idempotent");
const detailsUpgraded = upgradeDashboardTodoDetails(visibilityUpgraded, bundledDashboard);
if (!detailsUpgraded.includes("function openTodoDetailModal(")) throw new Error("To-Do detail modal was not added");
if (!detailsUpgraded.includes("clt-todo-completed:")) throw new Error("To-Do completion date was not added");
if (!detailsUpgraded.includes("todoSearchKeyword:")) throw new Error("To-Do search settings were not added");
if (!detailsUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("To-Do details migration changed the manual root setting");
if (upgradeDashboardTodoDetails(detailsUpgraded, bundledDashboard) !== detailsUpgraded) throw new Error("To-Do details migration is not idempotent");
const summaryUpgraded = upgradeDashboardTodoSummaryColumn(detailsUpgraded, bundledDashboard);
if (!summaryUpgraded.includes('key: "todoSummary"')) throw new Error("To-Do summary column was not added");
if (!summaryUpgraded.includes("opus-todo-summary-counts")) throw new Error("To-Do summary UI was not added");
if (summaryUpgraded.includes("opus-file-todo-add")) throw new Error("Legacy File-cell To-Do button remains after migration");
if (!summaryUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("To-Do summary migration changed the manual root setting");
if (upgradeDashboardTodoSummaryColumn(summaryUpgraded, bundledDashboard) !== summaryUpgraded) throw new Error("To-Do summary migration is not idempotent");
const sharedModalUpgraded = upgradeDashboardSharedTodoModal(summaryUpgraded, bundledDashboard);
if (!sharedModalUpgraded.includes('app.plugins.getPlugin("servicenow-manage")')) throw new Error("Shared To-Do modal delegation was not added");
if (!sharedModalUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("Shared modal migration changed the manual root setting");
if (upgradeDashboardSharedTodoModal(sharedModalUpgraded, bundledDashboard) !== sharedModalUpgraded) throw new Error("Shared modal migration is not idempotent");
const fieldOrderingUpgraded = upgradeDashboardFieldOrdering(sharedModalUpgraded, bundledDashboard);
if (!fieldOrderingUpgraded.includes("columnOrder:")) throw new Error("Persistent column order setting was not added");
if (!fieldOrderingUpgraded.includes("opus-field-drag-handle")) throw new Error("Column drag handle was not added");
if (!fieldOrderingUpgraded.includes("function bindColumnReorder(")) throw new Error("Direct table header ordering was not added");
if (fieldOrderingUpgraded.includes("const controlVisibilityButton =")) throw new Error("Empty toolbar condition button remains");
if (fieldOrderingUpgraded.includes("opus-header-drag-handle")) throw new Error("Redundant table header drag icon remains");
if (!fieldOrderingUpgraded.includes("opus-filter-display-toggle")) throw new Error("Condition visibility option was not moved into filter menu");
if (!fieldOrderingUpgraded.includes("showAppliedFilters:") || !fieldOrderingUpgraded.includes("showAppliedSorts:")) throw new Error("Filter/sort visibility settings were not separated");
if (!fieldOrderingUpgraded.includes("적용된 필터 조건을 표 위에 표시")) throw new Error("Filter visibility option is missing");
if (!fieldOrderingUpgraded.includes("적용된 정렬 조건을 표 위에 표시")) throw new Error("Sort visibility option is missing");
if (!fieldOrderingUpgraded.includes("openTodoDetailEntryModal")) throw new Error("Shared To-Do detail modal delegation was not migrated");
if (!fieldOrderingUpgraded.includes("function openTicketTodoListModal(")) throw new Error("Ticket-specific To-Do list modal was not migrated");
if (!fieldOrderingUpgraded.includes("data-todo-list-ticket-id=")) throw new Error("Ticket-specific To-Do list button was not migrated");
if (!fieldOrderingUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("Field ordering migration changed the manual root setting");
if (upgradeDashboardFieldOrdering(fieldOrderingUpgraded, bundledDashboard) !== fieldOrderingUpgraded) throw new Error("Field ordering migration is not idempotent");
const paginationUpgraded = upgradeDashboardTodoPagination(fieldOrderingUpgraded, bundledDashboard);
if (!paginationUpgraded.includes("const TODO_PAGE_SIZE = 10;")) throw new Error("To-Do pagination was not added");
if (!paginationUpgraded.includes(".opus-todo-load-more {")) throw new Error("To-Do load-more styling was not added");
if (!paginationUpgraded.includes("const searchActive = needle.length > 0;")) throw new Error("Search does not bypass To-Do pagination");
if (!paginationUpgraded.includes('const ROOT_FOLDER = "__SERVICENOW_ROOT_FOLDER__";')) throw new Error("Pagination migration changed the manual root setting");
if (upgradeDashboardTodoPagination(paginationUpgraded, bundledDashboard) !== paginationUpgraded) throw new Error("Pagination migration is not idempotent");
console.log("Dashboard popup migration checks passed");
