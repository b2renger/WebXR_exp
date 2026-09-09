// Browser smoke + regression tests. Node 22+ and installed Chrome; no npm install.
// CHROME_PATH can override the executable. This test loads the app's CDN modules.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../serve.mjs';

const server = createServer();
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
  const results = await evaluate('import("./tests/regression.js").then(m => m.run(window.spatialLab))');
  results.forEach(result => console.log('PASS ' + result));
  await new Promise(resolve => setTimeout(resolve, 500));
  if (errors.length) throw new Error(errors.join('\n'));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const outputDirectory = fileURLToPath(new URL('../.test-output/', import.meta.url));
  await mkdir(outputDirectory, { recursive: true });
  const screenshotPath = path.join(outputDirectory, 'desktop.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot: ' + screenshotPath);
  await evaluate('spatialLab.state.mode = "tear"; spatialLab.syncStyle(); spatialLab.tear.toggle(spatialLab.camera); spatialLab.tear.animation = null; spatialLab.tear.uniforms.tearProgress.value = 0.2;');
  await new Promise(resolve => setTimeout(resolve, 300));
  const tearPreview = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outputDirectory, 'tear.png'), Buffer.from(tearPreview.data, 'base64'));
  await evaluate('spatialLab.tear.uniforms.tearProgress.value = 0; spatialLab.tear.uniforms.tearBase.value = 1;');
  await new Promise(resolve => setTimeout(resolve, 300));
  const meshPreview = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outputDirectory, 'mesh.png'), Buffer.from(meshPreview.data, 'base64'));
  await evaluate('spatialLab.state.mode = "relight"; spatialLab.syncStyle();');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  const fits = await evaluate('document.documentElement.scrollWidth <= innerWidth');
  if (!fits) throw new Error('Mobile layout overflows viewport');
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outputDirectory, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  console.log('PASS Mobile layout fits viewport');
  console.log(`Completed ${results.length + 1} checks without browser errors.`);
} finally {
  socket?.close(); browser.kill(); server.closeAllConnections(); server.close();
  // Retain isolated temp profile; no recursive filesystem deletion in the harness.
}
