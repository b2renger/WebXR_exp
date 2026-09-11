export async function testLogging() {
  const log = window.SpatialLog;
  const results = [];
  function assert(condition, message) { if (!condition) throw new Error(message); results.push(message); }
  await log.ready;
  const cycle = { value: 'circular object' }; cycle.self = cycle;
  log.record('test.cycle', cycle);
  log.marker('SPATIAL_RECORDING_MARKER');
  document.getElementById('logs-flush').click();
  window.dispatchEvent(new ErrorEvent('error', { message: 'SPATIAL_LOG_TEST_RUNTIME', error: new Error('SPATIAL_LOG_TEST_RUNTIME'), filename: 'logging-fixture.js', lineno: 42, colno: 7 }));
  window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error('SPATIAL_LOG_TEST_PROMISE') }));
  console.error(new Error('SPATIAL_LOG_TEST_CONSOLE'));
  const image = document.createElement('img'); document.body.append(image); image.dispatchEvent(new Event('error')); image.remove();
  await log.settled();
  const events = await log.entries();
  assert(events.some(event => event.event === 'page.start') && events.some(event => event.event === 'splat.ready'), 'Recorder captures bootstrap through app readiness');
  assert(events.some(event => event.event === 'ui.click' && event.data.id === 'logs-flush'), 'DOM interactions are recorded');
  assert(events.some(event => event.event === 'test.cycle' && event.data.self === '[circular]'), 'Circular console payloads cannot break the recorder');
  assert(events.some(event => event.event === 'runtime.error' && event.data.line === 42 && event.data.error.stack), 'Runtime errors preserve stack and source location');
  assert(events.some(event => event.event === 'promise.unhandled' && event.data.error.message === 'SPATIAL_LOG_TEST_PROMISE'), 'Unhandled rejection reasons are captured');
  assert(events.some(event => event.event === 'console.error' && event.data.args[0].message === 'SPATIAL_LOG_TEST_CONSOLE'), 'Console errors preserve structured Error details');
  assert(events.some(event => event.event === 'resource.error' && event.data.tag === 'IMG'), 'Resource load failures are captured');
  assert(events.some(event => event.event === 'user.marker' && event.data.text === 'SPATIAL_RECORDING_MARKER'), 'Manual markers are recorded');
  assert(events.every((event, index) => event.sid === log.status.sid && (!index || event.seq > events[index - 1].seq)), 'Session event sequence is monotonic');
  const cjk = log.record('test.cjk', { a: '漢'.repeat(8500), b: '漢'.repeat(8500) });
  assert(new TextEncoder().encode(JSON.stringify(cjk)).length <= 20000 && cjk.data.truncated, 'Unicode events are bounded by serialized UTF-8 bytes');
  const bytes = new Uint8Array(1000000); bytes.subarray = () => new Uint8Array([17, 18]);
  assert(log.record('test.typed', bytes).data.preview.join() === '17,18', 'Typed-array normalization slices before copying');
  assert(log.record('test.dataview', new DataView(new Uint8Array([23]).buffer)).data.preview[0] === 23, 'DataView previews preserve bytes');
  // Emulate an oversized event left by the old recorder, then prove later events upload.
  await log.settled();
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('gsplat-quest3-logs', 1);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').add({ synced: 0, event: { ...cjk, seq: 1000000, event: 'test.legacy_cjk', data: { a: '漢'.repeat(8500), b: '漢'.repeat(8500) } } });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    }; request.onerror = () => reject(request.error);
  });
  log.marker('AFTER_OVERSIZED_RECORD');
  await log.flush();
  const response = await fetch('./__logs/download/' + log.status.sid + '.ndjson');
  const saved = (await response.text()).trim().split('\n').map(JSON.parse);
  assert(saved.some(event => event.event === 'user.marker' && event.data.text === 'SPATIAL_RECORDING_MARKER'), 'Browser events reach the durable server log');
  assert(saved.some(e => e.event === 'test.legacy_cjk' && e.data.truncated) && saved.some(e => e.data.text === 'AFTER_OVERSIZED_RECORD'), 'Legacy oversized outbox rows cannot block subsequent uploads');
  await log.flush();
  const again = (await fetch('./__logs/download/' + log.status.sid + '.ndjson').then(r => r.text())).trim().split('\n').map(JSON.parse);
  assert(new Set(again.map(event => event.seq)).size === again.length, 'Repeated browser flush does not duplicate events');
  document.getElementById('logs-flush').click();
  return results;
}
