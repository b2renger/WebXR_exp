// Browser smoke + regression tests. Node 22+ and installed Chrome; no npm install.
// CHROME_PATH can override the executable. This test loads the app's CDN modules.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../serve.mjs';
import { testLogServer } from './log-server.mjs';

const serverChecks = await testLogServer();
serverChecks.forEach(result => console.log('PASS ' + result));
const testLogDirectory = await mkdtemp(path.join(tmpdir(), 'spatial-browser-logs-'));
const server = createServer({ logDirectory: testLogDirectory, quiet: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = await mkdtemp(path.join(tmpdir(), 'spatial-mapping-test-'));
const browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,1000',
  '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 20000);
    let stderr = '';
    browser.on('error', reject);
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const debugPort = new URL(endpoint).port;
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const task = pending.get(data.id); pending.delete(data.id);
      if (data.error) task.reject(new Error(JSON.stringify(data.error))); else task.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(data.params.exceptionDetails));
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') errors.push(JSON.stringify(data.params.args));
    if (data.method === 'Fetch.requestPaused') void send('Fetch.failRequest', { requestId: data.params.requestId, errorReason: 'Failed' });
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?test` });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    ready = await evaluate('document.body?.dataset.ready === "true"');
    if (ready || errors.length) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('App did not start: ' + await evaluate('document.getElementById("status")?.textContent') + '\n' + errors.join('\n'));
  console.log('App loaded with real CDN dependencies. Running geometry, physics, and UI regressions…');
  const results = await evaluate('import("./tests/regression.js").then(m => m.run(window.__placer))');
  results.forEach(result => console.log('PASS ' + result));
  await new Promise(resolve => setTimeout(resolve, 500));
  if (errors.some(e => !e.includes('SPATIAL_LOG_TEST_'))) throw new Error(errors.join('\n'));
  const loggingChecks = await evaluate('import("./tests/logging.js").then(m => m.testLogging())');
  loggingChecks.forEach(result => console.log('PASS ' + result));
  const unexpected = errors.filter(error => !error.includes('SPATIAL_LOG_TEST_'));
  if (unexpected.length) throw new Error(unexpected.join('\n'));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const outputDirectory = fileURLToPath(new URL('../.test-output/', import.meta.url));
  await mkdir(outputDirectory, { recursive: true });
  const screenshotPath = path.join(outputDirectory, 'desktop.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot: ' + screenshotPath);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  const fits = await evaluate('document.documentElement.scrollWidth <= innerWidth && document.getElementById("ui").getBoundingClientRect().right <= innerWidth');
  if (!fits) throw new Error('Mobile layout overflows viewport');
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outputDirectory, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  console.log('PASS Mobile layout fits viewport');
  const previousSid = await evaluate('SpatialLog.status.sid');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?test&logging=browser` });
  async function waitForNewPage(oldSid) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`document.body?.dataset.ready === 'true' && window.SpatialLog?.status.sid !== ${JSON.stringify(oldSid)}`)) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Reload did not initialize');
  }
  await waitForNewPage(previousSid);
  const archived = await evaluate(`SpatialLog.entries(${JSON.stringify(previousSid)}).then(events => events.some(e => e.event === 'user.marker' && e.data.text === 'SPATIAL_RECORDING_MARKER'))`);
  if (!archived) throw new Error('Archived session disappeared after reload');
  console.log('PASS Browser storage preserves recordings across reload');
  await evaluate('SpatialLog.marker("OFFLINE_RECOVERY_MARKER"); SpatialLog.flush()');
  const offlineSid = await evaluate('SpatialLog.status.sid');
  const recordedSessions = await fetch(`http://127.0.0.1:${port}/__logs/sessions.json`).then(r => r.json());
  if (recordedSessions.some(session => session.sid === offlineSid)) throw new Error('Browser-only mode uploaded a recording');
  console.log('PASS Browser-only mode records without a logging server');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?test` }); await waitForNewPage(offlineSid);
  await evaluate('SpatialLog.flush()');
  const recovered = await fetch(`http://127.0.0.1:${port}/__logs/download/${offlineSid}.ndjson`).then(r => r.text());
  if (!recovered.includes('OFFLINE_RECOVERY_MARKER')) throw new Error('Unsent previous-session events were not recovered');
  console.log('PASS Unsent events from a previous page are uploaded when server logging resumes');
  await evaluate('localStorage.setItem("splat-placer-v2:" + location.pathname, "INVALID_LAYOUT_FIXTURE")');
  // Reload without pagehide autosaving over the fixture: CDP assigns on the next document.
  const fixture = await send('Page.addScriptToEvaluateOnNewDocument', {source:'localStorage.setItem("splat-placer-v2:" + location.pathname, "INVALID_LAYOUT_FIXTURE");'});
  const oldSid = await evaluate('SpatialLog.status.sid');
  await send('Page.navigate', {url:`http://127.0.0.1:${port}/?test`});await waitForNewPage(oldSid);
  await send('Page.removeScriptToEvaluateOnNewDocument', {identifier:fixture.identifier});
  const keptInvalid=await evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide")); localStorage.getItem("splat-placer-v2:" + location.pathname) === "INVALID_LAYOUT_FIXTURE"');
  if (!keptInvalid) throw new Error('Invalid saved layout was overwritten on pagehide');
  await evaluate('__placer.importLayout(JSON.stringify({version:2,anchorUUID:null,items:[]}))');
  console.log('PASS Invalid saved layout survives pagehide until a valid import replaces it');
  const unexpectedFinal = errors.filter(error => !error.includes('SPATIAL_LOG_TEST_'));
  if (unexpectedFinal.length) throw new Error(unexpectedFinal.join('\n'));
  const beforeFailure = await evaluate('SpatialLog.status.sid');
  const failureErrorOffset = errors.length;
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.clearBrowserCache');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*cdn.jsdelivr.net/*', requestStage: 'Request' }] });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?test&cdn-failure-fixture` });
  let failureCaptured = false;
  for (let i = 0; i < 100; i++) {
    failureCaptured = await evaluate(`window.SpatialLog?.status.sid !== ${JSON.stringify(beforeFailure)} && document.getElementById('status')?.textContent.startsWith('Startup failed:')`);
    if (failureCaptured) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!failureCaptured) throw new Error('Dependency failure fixture did not reach the startup error handler: ' + await evaluate('JSON.stringify({status: document.getElementById("status")?.textContent, ready: document.body?.dataset.ready, tail: window.SpatialLog?.tail().slice(-6)})'));
  const startupLog = await evaluate('SpatialLog.entries().then(events => events.some(e => e.event === "app.startup_failed") && events.some(e => e.event === "page.start") && !events.some(e => e.event === "splat.ready"))');
  if (!startupLog) throw new Error('Recorder did not capture startup failure before app initialization');
  if (errors.slice(failureErrorOffset).some(error => !/Failed to fetch|dynamically imported module/.test(error))) throw new Error('Unexpected error in startup-failure fixture');
  await evaluate('SpatialLog.flush()');
  console.log('PASS Recorder captures a real CDN import failure before the app initializes');
  await send('Fetch.disable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/logs.html` });
  let viewerReady = false;
  for (let i = 0; i < 100; i++) {
    viewerReady = await evaluate('Boolean(document.getElementById("events")?.children.length && document.getElementById("download")?.getAttribute("href"))');
    if (viewerReady) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!viewerReady) throw new Error('Log viewer did not display saved session events');
  const viewerScreenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outputDirectory, 'logs.png'), Buffer.from(viewerScreenshot.data, 'base64'));
  console.log('PASS PC log viewer displays saved events and a full-session download');
  console.log(`Completed ${results.length + loggingChecks.length + serverChecks.length + 7} checks without unexpected browser errors.`);
} finally {
  socket?.close(); browser.kill(); await server.logsSettled(); server.closeAllConnections(); server.close();
  // Retain isolated temp profile; no recursive filesystem deletion in the harness.
}
