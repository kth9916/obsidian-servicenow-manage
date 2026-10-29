const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const block = source.slice(source.indexOf("// BEGIN ATLASSIAN CONNECTION"), source.indexOf("// END ATLASSIAN CONNECTION"));
const context = vm.createContext({ PLUGIN_ID: "test-plugin", crypto, URL, URLSearchParams, Buffer, setTimeout, clearTimeout, http: {}, https: {}, shell: {} });
vm.runInContext(block + ";globalThis.Connection = AtlassianRovoConnection;globalThis.constants={token:ATLASSIAN_TOKEN_KEY,client:ATLASSIAN_CLIENT_KEY,resource:ATLASSIAN_MCP_URL,redirect:ATLASSIAN_REDIRECT};", context);
const { constants } = context;
const plain = value => JSON.parse(JSON.stringify(value));
let assertions = 0;
function check(condition, message) { assertions++; assert(condition, message); }
function fixture(saved = {}) {
  const secrets = new Map(), requests = [], opened = [], servers = []; let now = 1900000000000;
  const state = { failJira: false, failConfluence: false, emptyJira: false, emptyConfluence: false, expire: false, failRefresh: false, invalidRead: false, failSave: false, scope: "", refreshes: 0 };
  const plugin = { settings: { atlassian: saved, other: "preserve" }, app: { secretStorage: { setSecret() {} } },
    getSecret: key => secrets.get(key) || "", setSecret: (key, value) => secrets.set(key, value), deleteSecret: key => secrets.delete(key),
    savePluginData: async () => { if (state.failSave) throw Error("test storage failure"); }
  };
  const http = { createServer(callback) { const server = { callback, on(name, fn) { this[name] = fn; return this; }, listen(port, host, fn) { this.port = port; this.host = host; fn(); }, close() { this.closed = true; } }; servers.push(server); return server; } };
  const connection = new context.Connection(plugin, { http, https: {}, openExternal: async url => opened.push(url), now: () => now });
  const reply = value => ({ status: 200, headers: {}, text: JSON.stringify(value) });
  connection.request = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url.includes("oauth-protected-resource")) return reply({ resource: constants.resource, authorization_servers: ["https://auth.atlassian.com/example"] });
    if (url.includes("oauth-authorization-server")) return reply({ issuer: "https://auth.atlassian.com/example", authorization_endpoint: "https://auth.atlassian.com/authorize", token_endpoint: "https://auth.atlassian.com/oauth/token", registration_endpoint: "https://auth.atlassian.com/example/dcr/register", revocation_endpoint: "https://auth.atlassian.com/oauth/revoke", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.endsWith("/dcr/register")) {
      const body = JSON.parse(options.body); state.scope = body.scope; check(body.token_endpoint_auth_method === "none", "public OAuth client");
      return reply({ client_id: "test-public-client", token_endpoint_auth_method: "none", redirect_uris: [constants.redirect] });
    }
    if (url.endsWith("/oauth/token")) {
      const params = new URLSearchParams(options.body);
      if (params.get("grant_type") === "refresh_token") { state.refreshes++; if (state.failRefresh) return { status: 400, text: '{"error":"invalid_grant"}' }; }
      return reply({ access_token: "test-access-value", refresh_token: "test-rotated-refresh", token_type: "Bearer", expires_in: 3600, scope: state.scope });
    }
    if (url.endsWith("/oauth/revoke")) return reply({});
    if (url === constants.resource) {
      const rpc = JSON.parse(options.body);
      check(!options.headers.Authorization.includes("undefined"), "no undefined credential");
      if (rpc.method === "notifications/initialized") return { status: 202, headers: {}, text: "" };
      let result;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: {} };
      else {
        const { name, arguments: args } = rpc.params;
        if (name === "getAccessibleAtlassianResources") result = { resources: [{ cloudId: "test-site-a", url: "https://example.atlassian.net" }] };
        if (name === "atlassianUserInfo") result = { displayName: "Example User" };
        if (name === "searchJiraIssuesUsingJql") result = { issues: state.emptyJira ? [] : [{ id: "100", key: "EXAMPLE-1" }] };
        if (name === "searchConfluence") result = { results: state.emptyConfluence ? [] : [{ content: { id: "200" } }] };
        if (name === "getJiraIssue") result = state.invalidRead ? {} : { id: "100", key: args.issueIdOrKey, fields: { summary: "Private test content never saved" } };
        if (name === "getConfluenceContent") result = { id: "200", title: "Private document never saved" };
        if ((state.failJira && name === "getJiraIssue") || (state.failConfluence && name === "getConfluenceContent")) return reply({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "403 permission denied with private server detail" }] } });
      }
      const response = { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ data: result }) }] } };
      if (rpc.method === "initialize") response.result = result;
      return { status: 200, headers: { "mcp-session-id": "test-session" }, text: `event: message\ndata: ${JSON.stringify(response)}\n\n` };
    }
    throw Error("Unexpected test request");
  };
  const callback = async query => {
    let status, text;
    await connection.callback({ method: "GET", headers: { host: "127.0.0.1:42816" }, url: "/atlassian/callback?" + query }, { writeHead(code) { status = code; }, end(value) { text = value; } });
    return { status, text };
  };
  const login = async () => { await connection.setEnabled(true); await connection.connect(); const url = new URL(opened.at(-1)); await callback(new URLSearchParams({ code: "test-code", state: url.searchParams.get("state") })); };
  return { connection, plugin, secrets, requests, opened, servers, state, callback, login, advance: ms => now += ms };
}

(async () => {
  const f = fixture();
  await assert.rejects(() => f.connection.connect(), /먼저/); check(f.requests.length === 0, "off by default means no network");
  await f.connection.setEnabled(true); await f.connection.connect();
  const url = new URL(f.opened[0]);
  check(url.hostname === "auth.atlassian.com", "official browser login");
  check(url.searchParams.get("code_challenge_method") === "S256", "PKCE");
  check(!/write:|delete:|manage:/.test(url.searchParams.get("scope")), "read-only requested scopes");
  check(f.servers[0].host === "127.0.0.1" && f.servers[0].port === 42816, "loopback only");
  check(f.connection.status("jira").label !== "연결됨", "browser opened is not connection proof");
  for (const state of ["wrong", "가".repeat(43), "a".repeat(43)]) {
    check((await f.callback(new URLSearchParams({ code: "test-code", state }))).status === 403, "invalid state ignored");
    check(f.connection.phase === "waiting" && !f.servers[0].closed, "invalid callback cannot consume login");
  }
  const state = url.searchParams.get("state");
  check((await f.callback(`state=${state}&state=${state}&code=test-code`)).status === 403, "duplicate state rejected");
  check((await f.callback(new URLSearchParams({ code: "test-code", state }))).status === 200, "callback received");
  check(f.connection.status("jira").label === "연결됨" && f.connection.status("confluence").label === "연결됨", "both actual reads required");
  check(f.servers[0].closed && !f.connection.busy, "listener cleaned up after login");
  check(!JSON.stringify(f.plugin.settings).includes("test-access-value"), "tokens not in data.json");
  check(!JSON.stringify(f.plugin.settings).includes("Private test content"), "test contents not persisted");
  check(f.secrets.has(constants.token) && f.secrets.has(constants.client), "secrets stored only in SecretStorage");
  check(f.plugin.settings.other === "preserve", "existing preferences preserved");
  for (const tool of ["editJiraIssue", "updateConfluenceContent", "executeWrite", "executeRead", "deleteJiraIssue"]) await assert.rejects(() => f.connection.readTool(tool, {}), /제공하지/);
  await assert.rejects(() => f.connection.mcp("test", "tools/call", { name: "editJiraIssue" }), /제공하지/);
  f.state.failJira = true; await f.connection.test();
  check(f.connection.status("jira").label === "접근 권한 필요", "product-specific permission failure");
  check(f.connection.status("confluence").label === "연결됨", "one failure never skips the other");
  check(!f.connection.message.includes("private server detail"), "redacted errors only");
  f.state.failJira = false; f.state.emptyJira = true; f.state.emptyConfluence = true; await f.connection.test();
  check(f.connection.status("jira").label === "테스트 자료 필요" && f.connection.status("confluence").label === "테스트 자료 필요", "empty search is not successful content read");
  await f.connection.setTarget("jira", "https://example.atlassian.net/browse/EXAMPLE-2?tracking=remove");
  await f.connection.setTarget("confluence", "https://example.atlassian.net/wiki/spaces/DEMO/pages/200/Example");
  check(f.connection.prefs.targets.jira === "EXAMPLE-2" && f.connection.prefs.targets.confluence === "200", "normalized targets without tracking");
  for (const target of ["https://other.atlassian.net/browse/EXAMPLE-1", "https://example.atlassian.net.evil.test/browse/EXAMPLE-1", "file:///private", "javascript:alert(1)"]) await assert.rejects(() => f.connection.setTarget("jira", target), /올바른/);
  await f.connection.test(); check(f.connection.verified.size === 2, "explicit targets work without global search results");
  f.advance(3601000); check(f.connection.status("jira").label !== "연결됨", "expired login is not green");
  await f.connection.test(); check(f.state.refreshes === 1, "single refresh with rotation");
  check(JSON.parse(f.secrets.get(constants.token)).refreshToken === "test-rotated-refresh", "rotated refresh retained");
  const restored = fixture(plain(f.connection.prefs));
  for (const [key, value] of f.secrets) restored.secrets.set(key, value);
  check(restored.connection.status("jira").label === "다시 확인", "restart shows historical result, not live connection");
  await f.connection.setEnabled(false); check(f.connection.status("jira").label === "사용 안 함", "disable cancels and does not auto-test");
  await f.connection.setEnabled(true); check(f.connection.status("jira").label !== "연결됨", "re-enable needs new proof");
  const auth = fixture(); await auth.login(); auth.advance(3601000); auth.state.failRefresh = true;
  await assert.rejects(() => auth.connection.test(), /만료/);
  check(auth.connection.status("jira").label === "재로그인 필요", "invalid grant means reauth");
  await auth.connection.disconnect(); check(auth.secrets.size === 0, "disconnect clears secrets");
  const cancel = fixture(); await cancel.connection.setEnabled(true); await cancel.connection.connect(); const cancellationState = new URL(cancel.opened[0]).searchParams.get("state");
  await cancel.callback(new URLSearchParams({ error: "access_denied", state: cancellationState }));
  check(cancel.servers[0].closed && !cancel.connection.hasLogin() && !cancel.connection.busy, "user denial cleans listener without fake login");
  const noStorage = fixture(); noStorage.plugin.app.secretStorage = {}; await noStorage.connection.setEnabled(true);
  await assert.rejects(() => noStorage.connection.connect(), /저장/); check(noStorage.opened.length === 0 && noStorage.requests.length === 0, "no secure storage means no login launch");
  const slow = fixture(); await slow.connection.setEnabled(true); let release;
  slow.connection.metadata = () => new Promise(resolve => release = resolve);
  const pending = slow.connection.connect(); slow.connection.cancel(); release({}); await assert.rejects(() => pending);
  check(slow.opened.length === 0 && slow.secrets.size === 0, "cancel prevents late launch or secret resurrection");
  const storage = fixture(); storage.state.failSave = true;
  await assert.rejects(() => storage.connection.setEnabled(true), /저장/);
  check(storage.connection.prefs.enabled === false, "unsaved enable is rolled back");
  const sites = fixture(); await sites.login();
  sites.connection.prefs.sites.push({id:"test-site-b",url:"https://other.atlassian.net",name:"Other"});
  await sites.connection.selectSite("test-site-b");
  check(sites.connection.prefs.site === "https://other.atlassian.net" && sites.connection.verified.size === 0, "site switch clears prior proof");
  check(!sites.connection.prefs.targets.jira && !sites.connection.prefs.targets.confluence, "site-specific targets do not cross sites");
  await assert.rejects(() => sites.connection.selectSite("unknown"), /사이트/);
  for (const invalid of ["https://evil.test/token", "http://auth.atlassian.com/token", "https://auth.atlassian.com" + "@" + "evil.test/token", "https://auth.atlassian.com:444/token", "https://auth.atlassian.com/token?secret=value"]) assert.throws(() => context.atlassianTrustedUrl(invalid));
  assert.throws(() => context.atlassianRpcResponse('{"jsonrpc":"2.0","id":2,"result":{}}', 1));
  check(context.atlassianRpcResponse('data: {"jsonrpc":"2.0","method":"notice"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', 1).ok, "SSE matches request ID and ignores notifications");
  for (const current of [f, restored, auth, cancel, noStorage, slow, storage, sites]) current.connection.dispose();
  console.log(`PASS Atlassian connection: ${assertions} assertions; optional/no background calls, official discovery and public PKCE flow, loopback/state/duplicate/unicode rejection, read-only allowlist, separate product verification, no-data/targets, refresh/restart/expiry, cancellation/storage/disconnect and redacted errors.`);
})().catch(error => { console.error(error); process.exit(1); });
