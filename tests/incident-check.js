const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, '../resources/업무현황.md'), 'utf8');
const context = vm.createContext({ console, TFile: class {}, normalizePath: x => x });
for (const name of ['TABLE_BY_PREFIX', 'INC_STATES', 'INCIDENT_FIELDS']) {
  vm.runInContext(source.match(new RegExp('const '+name+' = [^]*?;'))[0], context);
}
for (const name of ['normalizeTicketId', 'ticketCategory', 'fieldValue', 'rawFieldValue', 'incidentMetadata', 'prepareIncidentTemplate', 'tableForTicket', 'normalizeMeetingTicketIds', 'cleanChoiceValue', 'normalizedServiceNowFieldName', 'serviceNowField', 'extractTicketMetadata', 'selectAiPromptTemplate', 'defaultTicketTemplate', 'fillTemplate']) {
  const match = source.match(new RegExp(name === 'ticketCategory' ? 'function '+name+'[^\\n]+' : 'function '+name+'\\([^]*?\\n\\}'));
  assert(match, name); vm.runInContext(match[0], context);
}
const method = name => {
  const start = source.search(new RegExp('^  (?:async )?'+name+'\\(', 'm'));
  assert(start >= 0, name);
  const rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end+1).trim();
};
vm.runInContext('api = {'+['fetchTicketMetadata', 'updateTicketMetadata', 'rootTicketIdFromPathStructure', 'analysisTemplatePath'].map(method).join(',')+'}', context);
const run = expression => vm.runInContext(expression, context);
(async () => {
  assert.equal(run('normalizeTicketId(" inc0000000 ")'), 'INC0000000');
  assert.equal(run('ticketCategory("INC0000000")'), 'INC');
  assert.equal(run('normalizeTicketId("INCbad")'), '');
  assert.equal(run('tableForTicket("INC0000000")'), 'incident');
  assert.equal(run('tableForTicket("INC0000000", {IN:"custom_incident"})'), 'custom_incident');
  assert.equal(run('tableForTicket("CR0000000")'), 'change_request');
  assert.equal(run('tableForTicket("SR0000000")'), 'u_service_call');
  assert.equal(run('normalizeMeetingTicketIds(["INC0000000", "INC0000000", "CR0000000"]).length'), 2);
  const template = run('prepareIncidentTemplate(defaultTicketTemplate())');
  assert(template.includes('incident_impact:') && template.includes('incident_resolution_notes:'));
  assert(!/^target_qa_completion_date:/m.test(template));
  assert(template.includes('작업 일지') && template.includes('To-Do'));
  assert.equal(run('prepareIncidentTemplate("---\\npurpose: Manual\\nBS: [[Manual]]\\n---\\nKeep body")').includes('BS: [[Manual]]'), true);
  const prompt = run('selectAiPromptTemplate("CR_TEMPLATE.md 기준\\nCR No:\\nSR_TEMPLATE.md 기준\\nSR No:", "INC")');
  assert(prompt.includes('INC No:') && !prompt.includes('CR_TEMPLATE.md'));
  assert(run('INC_STATES.includes("On Hold") && INC_STATES.includes("Resolved")'));
  const api = context.api;
  api.rootFolder = () => 'Work';
  api.ticketsFolder = () => 'Work/티켓';
  assert.equal(api.analysisTemplatePath('INC'), 'Work/지침/INC_TEMPLATE.md');
  const File = run('TFile'), file = new File(); file.path = 'Work/티켓/INC0000000/INC0000000.md'; file.extension = 'md';
  assert.equal(api.rootTicketIdFromPathStructure(file), 'INC0000000');
  const requests = [];
  api.serviceNowTableForTicket = id => run(`tableForTicket(${JSON.stringify(id)})`);
  api.apiGet = async (url, query) => { requests.push({url, query}); return {result:[{sys_id:'example', state:{value:'2',display_value:'In Progress'}, short_description:'Example incident', impact:{value:'1',display_value:'1 - High'}, urgency:{value:'2',display_value:'2 - Medium'}, caller_id:{value:'example-user',display_value:'Example Caller'}, close_notes:'Restored'}]}; };
  const metadata = await api.fetchTicketMetadata('INC0000000');
  assert.equal(requests[0].url, '/api/now/table/incident');
  assert.equal(requests[0].query.sysparm_query, 'number=INC0000000');
  assert.equal(metadata.incidentFields.incident_impact, '1 - High');
  assert.equal(metadata.incidentFields.incident_caller, 'Example Caller');
  assert.equal(metadata.incidentFields.incident_resolution_notes, 'Restored');
  assert(!Object.hasOwn(metadata.incidentFields, 'incident_hold_reason'));
  const fm = {purpose:'Manual', target_qa_completion_date:'Keep', incident_hold_reason:'Existing', manual:'Keep'};
  api.rootTicketFile = () => file;
  api.app = {fileManager:{processFrontMatter:async (_file, fn) => fn(fm)}};
  await api.updateTicketMetadata('INC0000000', metadata, file);
  assert.equal(fm.incident_urgency, '2 - Medium');
  assert.equal(fm.incident_hold_reason, 'Existing');
  assert.equal(fm.purpose, 'Manual'); assert.equal(fm.target_qa_completion_date, 'Keep'); assert.equal(fm.manual, 'Keep');
  assert(dashboard.includes('["CR", "SR", "INC"]'));
  assert(dashboard.includes('["incident_impact", "영향도"]'));
  assert(method('initializeNewTicket').includes('ticketCategory(normalized) !== "INC"'));
  assert(method('createTicketNote').includes('prepareIncidentTemplate(template)'));
  console.log('PASS incidents: validation, incident/custom table routing, metadata display values, absent-field preservation, root identity, meeting links, dedicated template/prompt/state, dashboard and CR/SR preservation. ServiceNow mocked.');
})().catch(error => {console.error(error);process.exit(1)});
