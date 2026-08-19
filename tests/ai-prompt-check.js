const fs = require("fs");
const path = require("path");

const pluginRoot = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(pluginRoot, "main.js"), "utf8");
const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");

function loadFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = main.indexOf("\nfunction ", start + 1);
  return main.slice(start, next < 0 ? main.length : next);
}

eval(loadFunction("escapeRegExp"));
eval(loadFunction("replacePromptField"));
eval(loadFunction("selectAiPromptTemplate"));
eval(loadFunction("replacePromptWorkingNotes"));
eval(loadFunction("buildAiEnvironmentInstructions"));
eval(loadFunction("googleDriveFileId"));
eval(loadFunction("googleDownloadFormat"));
eval(loadFunction("safeFileName"));
eval(loadFunction("normalizeTicketId"));
eval(loadFunction("documentTypeFromFileName"));
eval(loadFunction("isStandardBsFileName"));
eval(loadFunction("standardBsBaseName"));
eval(loadFunction("wikiLinkTarget"));
eval(loadFunction("isLocalBsWikiLink"));
eval(loadFunction("isImageAttachment"));
eval(loadFunction("serviceNowAttachmentId"));
eval(loadFunction("adaptPromptToAvailableDocuments"));

const sample = [
  "CR_TEMPLATE.md 기준으로 진행해줘.",
  "",
  "CR No:",
  "OLD",
  "Short Description:",
  "OLD TITLE",
  "Long Description:",
  "OLD DESCRIPTION",
  "My Position:",
  "OLD ROLE",
  "Current Service now Status :",
  "OLD STATUS",
  "Service now Working note(시간순):",
  "OLD NOTES",
  "",
  "첨부한 문서를 분석해줘.",
  "",
  "----",
  "",
  "SR_TEMPLATE.md 기준으로 진행해줘.",
  "",
  "SR No:",
  "OLD",
  "Short Description:",
  "OLD TITLE",
  "Long Description:",
  "OLD DESCRIPTION",
  "My Position:",
  "OLD ROLE",
  "Current Service now Status :",
  "OLD STATUS",
  "Service now Working note(시간순):"
].join("\n");

let cr = selectAiPromptTemplate(sample, "CR");
const sr = selectAiPromptTemplate(sample, "SR");
cr = replacePromptField(cr, "CR No", "Short Description", "CR0000000");
cr = replacePromptField(cr, "Short Description", "Long Description", "Adding Reefer");
cr = replacePromptField(cr, "Long Description", "My Position", "Line 1\nCost is $& and $1\nLine 3");

if (!cr.includes("CR0000000") || !cr.includes("Adding Reefer") || !cr.includes("Cost is $& and $1")) throw new Error("CR fields were not replaced");
if (cr.includes("SR_TEMPLATE.md")) throw new Error("CR template includes SR section");
if (!sr.startsWith("SR_TEMPLATE.md") || !sr.includes("SR No:")) throw new Error("SR section was not selected");
const srWithNotes = replacePromptWorkingNotes(sr.trimEnd(), "2026-08-12 20:49:51 - Example User (Work notes)\nSR0000000 note with $& and $1");
if (!srWithNotes.includes("SR0000000 note with $& and $1")) throw new Error("SR work notes were not inserted at EOF");
const crWithNotes = replacePromptWorkingNotes(cr, "CR work note");
if (!crWithNotes.includes("CR work note") || !crWithNotes.includes("첨부한 문서를 분석해줘.")) throw new Error("CR work notes damaged following instructions");
if (googleDriveFileId("https://docs.google.com/document/d/abc_123/edit") !== "abc_123") throw new Error("Path Drive ID was not parsed");
if (googleDriveFileId("https://drive.google.com/open?id=xyz-789") !== "xyz-789") throw new Error("Query Drive ID was not parsed");
if (googleDownloadFormat("application/vnd.google-apps.spreadsheet", "sample").extension !== ".xlsx") throw new Error("Google Sheet export format is wrong");
if (safeFileName('a:b/c') !== "a_b_c") throw new Error("Filename was not sanitized");
if (documentTypeFromFileName("CR0020000_FS_20260812.xlsx") !== "FS") throw new Error("FS filename was not classified");
if (documentTypeFromFileName("BS for Example Change.pdf") !== "BS") throw new Error("Business-titled BS filename was not classified");
if (standardBsBaseName("CR0000000", "BS for Example Change") !== "CR0000000_BS - BS for Example Change") throw new Error("BS filename was not normalized");
if (standardBsBaseName("CR0000000", "CR0000000_BS - Proposal") !== "CR0000000_BS - Proposal") throw new Error("Standard BS filename was changed");
if (standardBsBaseName("CR0000000", "CR0000000 BS - Proposal") !== "CR0000000 BS - Proposal") throw new Error("Legacy standard BS filename was changed");
if (documentTypeFromFileName("Example change proposal") !== "") throw new Error("Business title was misclassified");
if (!isLocalBsWikiLink("[[ServiceNow/티켓/CR0000000/assets/CR0000000 BS - Proposal.pdf]]", "ServiceNow/티켓/CR0000000/assets")) throw new Error("Local BS wiki link was not recognized");
if (isLocalBsWikiLink("[[ServiceNow/티켓/CR0000000/assets/CR0000000 BS-한글 - Proposal.docx]]", "ServiceNow/티켓/CR0000000/assets")) throw new Error("Translated BS was mistaken for the source BS");
if (isLocalBsWikiLink("https://docs.google.com/document/d/abc/edit", "ServiceNow/티켓/CR0000000/assets")) throw new Error("Remote BS URL was mistaken for a local link");
if (!isImageAttachment("screen.PNG", "") || !isImageAttachment("unknown", "image/jpeg") || isImageAttachment("report.pdf", "application/pdf")) throw new Error("Image attachment classification failed");
if (serviceNowAttachmentId({ url: "https://your-instance.service-now.com/sys_attachment.do?sys_id=abc123&view=true" }) !== "abc123") throw new Error("Cached attachment ID was not recovered");
const bsOnly = adaptPromptToAvailableDocuments("첨부한 BS, FS, DS, UT를 분석해줘. 추가로 BS를 한글로 번역해서 문서로 만들고 링크해줘.", ["BS"]);
if (!bsOnly.includes("BS 문서를 분석해 주세요") || !bsOnly.includes("‘BS-한글’ 필드") || !bsOnly.includes("현재 상태 한 줄 요약")) throw new Error("BS-only prompt was not adapted");
const utOnly = adaptPromptToAvailableDocuments("첨부한 BS, FS, DS, UT를 분석해줘. 추가로 BS를 한글로 번역해서 문서로 만들고 링크해줘.", ["UT"]);
if (!utOnly.includes("UT 문서를 분석해 주세요") || utOnly.includes("‘BS-한글’ 필드")) throw new Error("Non-BS prompt retained BS instruction");
const noDocs = adaptPromptToAvailableDocuments("SR_TEMPLATE.md 기준으로 진행해줘.", []);
if (!noDocs.includes("Working Notes를 중점적으로") || !noDocs.includes("현재 상태 한 줄 요약")) throw new Error("No-document instructions are missing");
const translatedBs = adaptPromptToAvailableDocuments("CR_TEMPLATE.md 기준으로 진행해줘.", ["BS"], true);
if (!translatedBs.includes("기존 BS-한글 번역본") || translatedBs.includes("파일명을 ‘<티켓번호>")) throw new Error("Existing BS translation was not respected");
const environment = buildAiEnvironmentInstructions("SR", {
  templatePath: "C:\\Vault\\ServiceNow\\지침\\SR_TEMPLATE.md",
  ticketPath: "C:\\Vault\\ServiceNow\\티켓\\SR0000000\\SR0000000.md",
  assetsPath: "C:\\Vault\\ServiceNow\\티켓\\SR0000000\\assets"
});
if (!environment.includes("Obsidian Vault") || !environment.includes("SR_TEMPLATE.md") || !environment.includes("일반 ChatGPT/Claude 웹 채팅")) {
  throw new Error("AI environment instructions are incomplete");
}
if (main.includes("EMBEDDED_ANALYSIS_TEMPLATE_GZIP_BASE64")) throw new Error("Organization analysis templates are still bundled");
if (!main.includes("importOrganizationPack(onDone)") || !main.includes("organizationFeatureEnabled(\"aiPrompt\")")) {
  throw new Error("Organization-pack AI feature gate is missing");
}
if (!main.includes("defaultAiPromptTemplate()") || !main.includes("analysisTemplatePath(category)")) {
  throw new Error("AI guide scaffold is missing");
}
if (!main.includes("onTicketAssetChanged(file)") || !main.includes("linkLocalBsDocument(ticketId, path)")) {
  throw new Error("Automatic local BS linking is missing");
}
if (!main.includes("class TodoEntryModal extends Modal") || !main.includes("openTodoEntryModal(preselectedTicketId") || !main.includes("clt-todo-ticket-search")) {
  throw new Error("Shared searchable To-Do entry modal is missing");
}
if (main.includes("SECONDARY_GOOGLE_REFRESH_TOKEN_KEY") || main.includes("42815")) {
  throw new Error("Removed secondary Google OAuth flow still exists");
}

console.log("AI prompt template checks passed");
