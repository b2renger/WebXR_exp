/* Classic script loaded before CSS, imports, Three.js, and app initialization. */
(() => {
  'use strict';
  const sid = crypto.randomUUID ? crypto.randomUUID() : 'page-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const started = performance.now();
  const tail = [], fallback = [];
  let seq = 0, queue = Promise.resolve(), db = null, transmitting = null, lastProbe = 0;
  const params = new URLSearchParams(location.search);
  const serverWanted = params.get('logging') !== 'browser' &&
    (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || params.get('logging') === 'server');
  const configURL = new URL('./__logs/config.json', location.href);
  const ingestURL = new URL('./__logs/events', location.href);
  const status = { sid, storage: 'opening', transport: serverWanted ? 'connecting' : 'browser only',
    recorded: 0, pending: 0, saved: 0, dropped: 0, lastError: null, lastAcknowledged: null };
  const originals = {};
  const encoder = new TextEncoder();
  // Limit the serialized event, including JSON escaping, by UTF-8 bytes.
  function bounded(entry) {
    if (encoder.encode(JSON.stringify(entry)).length <= 20000) return entry;
    const preview = JSON.stringify(entry.data);
    const result = { ...entry, data: { truncated: true, originalBytes: encoder.encode(JSON.stringify(entry)).length, preview: '' } };
    let lo = 0, hi = preview.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      result.data.preview = preview.slice(0, mid);
      if (encoder.encode(JSON.stringify(result)).length <= 20000) lo = mid; else hi = mid - 1;
    }
    result.data.preview = preview.slice(0, lo);
    return result;
  }
  function safe(value, seen = new WeakSet(), depth = 0) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value === 'string' && value.length > 12000 ? value.slice(0, 12000) + '[truncated]' : value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    if (depth > 6) return '[depth limit]';
    seen.add(value);
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack, cause: safe(value.cause, seen, depth + 1) };
    if (ArrayBuffer.isView(value)) return { type: value.constructor.name, length: value.length, preview: value instanceof DataView ? Array.from(new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, 32))) : Array.from(value.subarray(0, 32), v => typeof v === 'bigint' ? String(v) : v) };
    if (value instanceof Element) return { tag: value.tagName, id: value.id };
    if (Array.isArray(value)) return value.slice(0, 100).map(v => safe(v, seen, depth + 1)).concat(value.length > 100 ? ['[array truncated]'] : []);
    const result = {};
    for (const key of Object.keys(value).slice(0, 80)) {
      try { result[key] = safe(value[key], seen, depth + 1); } catch { result[key] = '[unreadable]'; }
    }
    return result;
  }
  const ready = new Promise(resolve => {
    try {
      const request = indexedDB.open('gsplat-quest3-logs', 1);
      const timer = setTimeout(() => { status.storage = 'memory only'; status.lastError = 'IndexedDB open timed out'; resolve(null); }, 5000);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('pending', 'synced'); store.createIndex('session', 'event.sid');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (status.storage === 'memory only') { request.result.close(); return; }
        db = request.result; status.storage = 'IndexedDB'; resolve(db);
        db.onversionchange = () => { db.close(); db = null; status.storage = 'memory only'; };
      };
      request.onerror = () => { clearTimeout(timer); status.storage = 'memory only'; status.lastError = request.error?.message; resolve(null); };
    } catch (error) { status.storage = 'memory only'; status.lastError = error.message; resolve(null); }
  });
  function transaction(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', mode);
      let result;
      work(tx.objectStore('events'), value => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Log transaction aborted'));
    });
  }
  function rememberFallback(event) {
    if (fallback.length >= 10000) { fallback.shift(); status.dropped++; }
    fallback.push({ event, synced: 0 });
  }
  function record(event, data = {}, level = 'info') {
    let normalized;
    try { normalized = safe(data); } catch { normalized = '[serialization failed]'; }
    const entry = bounded({ schema: 1, sid, seq: ++seq, time: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, level: ['info', 'warn', 'error', 'debug'].includes(level) ? level : 'info', event: String(event).slice(0, 120), data: normalized });
    tail.push(entry); if (tail.length > 300) tail.shift();
    status.recorded++;
    queue = queue.then(async () => {
      await ready;
      if (!db) { rememberFallback(entry); return; }
      try {
        await transaction('readwrite', store => store.add({ event: entry, synced: 0 }));
        status.saved++;
      } catch (error) {
        status.storage = 'IndexedDB + unsaved memory'; status.lastError = error.message;
        rememberFallback(entry);
      }
    }).catch(error => { status.lastError = error.message; rememberFallback(entry); });
    return entry;
  }
  async function pendingRows() {
    const rows = db ? await transaction('readonly', (store, done) => {
      const request = store.index('pending').getAll(0, 32); request.onsuccess = () => done(request.result);
    }) : [];
    return rows.concat(fallback.filter(row => row.synced === 0).slice(0, 32));
  }
  async function flush() {
    if (transmitting) return transmitting;
    transmitting = (async () => {
      await queue;
      if (!serverWanted) return;
      try {
        if (status.transport !== 'server connected') {
          if (Date.now() - lastProbe < 5000) return;
          lastProbe = Date.now();
          const response = await fetch(configURL, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
          if (!response.ok || (await response.json()).protocol !== 'spatial-log-v1') throw new Error('Local log server not available');
          status.transport = 'server connected';
        }
        // Bound each burst so an old offline backlog cannot monopolize this page.
        for (let batch = 0; batch < 8; batch++) {
          const rows = await pendingRows();
          if (!rows.length) { status.pending = 0; break; }
          const selected = [];
          for (const row of rows) {
            // Repair older oversized outbox entries on upload; retain full local data.
            const candidate = [...selected, row];
            if (new TextEncoder().encode(JSON.stringify({ events: candidate.map(r => bounded(r.event)) })).length > 48000) break;
            selected.push(row);
          }
          if (!selected.length) throw new Error('An event exceeds the upload batch limit');
          const response = await fetch(ingestURL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: selected.map(row => bounded(row.event)) }), keepalive: true, signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error('Log upload HTTP ' + response.status);
          const ack = await response.json();
          if (ack.protocol !== 'spatial-log-v1' || ack.acknowledged !== selected.length) throw new Error('Invalid log acknowledgement');
          const persisted = selected.filter(row => row.id !== undefined);
          if (persisted.length) await transaction('readwrite', store => { for (const row of persisted) { row.synced = 1; store.put(row); } });
          for (const row of selected) row.synced = 1;
          status.lastAcknowledged = new Date().toISOString(); status.lastError = null;
        }
        status.pending = db ? await transaction('readonly', (store, done) => {
          const count = store.index('pending').count(0); count.onsuccess = () => done(count.result);
        }) : 0;
        status.pending += fallback.filter(row => !row.synced).length;
      } catch (error) {
        if (status.lastError !== error.message) record('logging.transport_error', { error: error.message }, 'warn');
        status.transport = 'retrying'; status.lastError = error.message;
      }
    })().finally(() => { transmitting = null; });
    return transmitting;
  }
  async function entries(session = sid) {
    await queue;
    const records = db ? await transaction('readonly', (store, done) => {
      const request = session ? store.index('session').getAll(session) : store.getAll();
      request.onsuccess = () => done(request.result);
    }) : [];
    const events = records.map(row => row.event).concat(fallback.filter(row => !session || row.event.sid === session).map(row => row.event));
    // Sequence order remains correct even if the device wall clock changes.
    return events.sort((a, b) => a.sid.localeCompare(b.sid) || a.seq - b.seq);
  }
  async function download(all = false) {
    record('logs.export', { scope: all ? 'all sessions' : 'this page', dropped: status.dropped, storage: status.storage });
    const data = await entries(all ? null : sid);
    const url = URL.createObjectURL(new Blob([data.map(entry => JSON.stringify(entry)).join('\n') + '\n'], { type: 'application/x-ndjson' }));
    const link = document.createElement('a'); link.href = url;
    link.download = all ? 'gsplat-all-sessions.ndjson' : `gsplat-${sid}.ndjson`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const api = window.SpatialLog = { record, flush, entries, download, status, ready,
    tail: () => tail.slice(), settled: () => queue,
    error: (event, error, data = {}) => record(event, { ...data, error }, 'error'),
    marker: text => record('user.marker', { text }),
    motion: params.get('poses') !== '0',
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level].bind(console);
    console[level] = (...args) => { record('console.' + level, { args }, level === 'log' ? 'info' : level); originals[level](...args); };
  }
  const originalAssert = console.assert.bind(console);
  console.assert = (condition, ...args) => { if (!condition) record('console.assert', { args }, 'error'); originalAssert(condition, ...args); };
  addEventListener('error', event => {
    if (event.target !== window) {
      record('resource.error', { tag: event.target?.tagName, url: event.target?.src || event.target?.href }, 'error');
    } else api.error('runtime.error', event.error || new Error(event.message), { filename: event.filename, line: event.lineno, column: event.colno });
  }, true);
  addEventListener('unhandledrejection', event => api.error('promise.unhandled', event.reason));
  addEventListener('rejectionhandled', () => record('promise.handled_late'));
  for (const name of ['online', 'offline', 'pageshow', 'pagehide']) addEventListener(name, event => {
    record('page.' + name, { persisted: event.persisted }); void flush();
  });
  document.addEventListener('visibilitychange', () => { record('page.visibility', { state: document.visibilityState }); void flush(); });
  for (const name of ['focus', 'blur']) addEventListener(name, () => record('page.' + name));
  for (const name of ['click', 'input', 'change']) document.addEventListener(name, event => {
    const target = event.target.closest?.('button,input,select,summary,a');
    if (!target) return;
    record('ui.' + name, { id: target.id || null, tag: target.tagName, label: target.getAttribute('aria-label') || target.textContent?.trim().slice(0, 100),
      value: target.type === 'checkbox' ? target.checked : target.type === 'text' ? '[text recorded only when marker is submitted]' : target.value,
      color: target.dataset.color, trusted: event.isTrusted });
  }, true);
  for (const name of ['pointerdown', 'pointerup', 'pointercancel']) document.addEventListener(name, event => {
    if (event.target.tagName === 'CANVAS') record('viewport.' + name, { x: event.clientX, y: event.clientY, button: event.button, pointerType: event.pointerType });
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    record('page.dom_ready');
    const bind = (id, action) => document.getElementById(id)?.addEventListener('click', () => Promise.resolve(action()).catch(error => api.error('logs.action_error', error)));
    bind('logs-download', () => download()); bind('logs-download-all', () => download(true));
    bind('logs-flush', () => flush());
    bind('logs-mark', () => { const input = document.getElementById('logs-note'); api.marker(input.value || 'Manual marker'); input.value = ''; });
    document.getElementById('logs-poses')?.addEventListener('change', event => { api.motion = event.target.checked; record('logging.pose_sampling', { enabled: api.motion, hz: 5 }); });
    if (document.getElementById('logs-poses')) document.getElementById('logs-poses').checked = api.motion;
    const paint = () => {
      const label = document.getElementById('logs-status');
      if (label) label.textContent = `${sid}\n${status.storage} · ${status.transport}\n${status.recorded} events this page · ${status.pending} pending at last sync · ${status.dropped} dropped` + (status.lastError ? '\n' + status.lastError : '');
      const panel = document.getElementById('logs-panel');
      if (panel?.open) document.getElementById('logs-tail').textContent = tail.slice(-50).map(e => `${e.seq} ${e.elapsedMs.toFixed(0)}ms [${e.level}] ${e.event} ${JSON.stringify(e.data)}`).join('\n');
    };
    paint(); setInterval(paint, 1000);
  });
  record('page.start', { url: location.origin + location.pathname, userAgent: navigator.userAgent,
    secureContext: isSecureContext, online: navigator.onLine, viewport: [innerWidth, innerHeight],
    pixelRatio: devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    motionSamples: api.motion, transportRequested: serverWanted });
  setInterval(() => void flush(), 1000);
  void flush();
})();
