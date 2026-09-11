// Dependency-free preview + durable local logs. GitHub Pages needs only static files.
import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { readFile, readdir, stat, realpath, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sessionPattern = /^[a-zA-Z0-9-]{8,90}$/;
const protocol = 'spatial-log-v1';
export function createServer({ logDirectory = path.join(root, 'logs'), quiet = false, tls = null } = {}) {
  const seenSessions = new Map();
  let writes = Promise.resolve();
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const filename = sid => path.join(logDirectory, `session-${sid}.ndjson`);
  async function save(events) {
    await mkdir(logDirectory, { recursive: true });
    const groups = new Map();
    for (const event of events) { if (!groups.has(event.sid)) groups.set(event.sid, []); groups.get(event.sid).push(event); }
    for (const [sid, entries] of groups) {
      let seen = seenSessions.get(sid);
      if (!seen) {
        seen = new Set();
        try {
          const old = await readFile(filename(sid), 'utf8');
          for (const line of old.split('\n')) { if (line) { try { seen.add(JSON.parse(line).seq); } catch { /* Preserve an interrupted trailing write for inspection. */ } } }
          if (old && !old.endsWith('\n')) {
            const handle = await open(filename(sid), 'a');
            try { await handle.writeFile('\n'); await handle.sync(); } finally { await handle.close(); }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        seenSessions.set(sid, seen);
      }
      const unique = [], batchSeen = new Set();
      for (const event of entries) if (!seen.has(event.seq) && !batchSeen.has(event.seq)) {
        batchSeen.add(event.seq); unique.push({ ...event, serverReceivedAt: new Date().toISOString() });
      }
      if (!unique.length) continue;
      const handle = await open(filename(sid), 'a');
      try { await handle.writeFile(unique.map(event => JSON.stringify(event)).join('\n') + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      for (const event of unique) {
        seen.add(event.seq);
        if (!quiet && !['xr.pose_sample', 'hand.pose_sample', 'app.heartbeat'].includes(event.event)) console.log(`[${sid.slice(0, 8)} #${event.seq}] ${event.level} ${event.event} ${JSON.stringify(event.data ?? null).slice(0, 220)}`);
      }
    }
  }
  async function body(req) {
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) { const error = new Error('Log batch exceeds 1 MiB'); error.status = 413; throw error; } chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const error = new Error('Invalid JSON'); error.status = 400; throw error; }
  }
  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/__logs/')) {
        // No CORS: an unrelated page must not inject log entries into this server.
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
          json(res, 403, { error: 'Same-origin requests only' }); return;
        }
        if (pathname === '/__logs/config.json' && req.method === 'GET') { json(res, 200, { protocol }); return; }
        if (pathname === '/__logs/events' && req.method === 'POST') {
          if (!(req.headers['content-type'] || '').startsWith('application/json')) { json(res, 415, { error: 'Use application/json' }); return; }
          const { events } = await body(req);
          if (!Array.isArray(events) || !events.length || events.length > 200 || events.some(event =>
            !event || event.schema !== 1 || !sessionPattern.test(event.sid) || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
            typeof event.time !== 'string' || !Number.isFinite(event.elapsedMs) || typeof event.event !== 'string' || event.event.length > 120 ||
            !['info', 'warn', 'error', 'debug'].includes(event.level) || JSON.stringify(event).length > 24000)) {
            json(res, 400, { error: 'Invalid log event schema or batch size' }); return;
          }
          const operation = writes.then(() => save(events)); writes = operation.catch(() => {});
          await operation;
          json(res, 200, { protocol, acknowledged: events.length }); return;
        }
        if (pathname === '/__logs/sessions.json' && req.method === 'GET') {
          let names = []; try { names = await readdir(logDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const sessions = [];
          for (const name of names) {
            const sid = name.replace(/^session-/, '').replace(/\.ndjson$/, '');
            if (name !== `session-${sid}.ndjson` || !sessionPattern.test(sid)) continue;
            const info = await stat(filename(sid));
            sessions.push({ sid, bytes: info.size, modified: info.mtime.toISOString() });
          }
          json(res, 200, sessions.sort((a, b) => b.modified.localeCompare(a.modified))); return;
        }
        if ((pathname === '/__logs/tail' || pathname.startsWith('/__logs/download/')) && req.method === 'GET') {
          const sid = pathname === '/__logs/tail' ? url.searchParams.get('session') : pathname.slice('/__logs/download/'.length).replace(/\.ndjson$/, '');
          if (!sid || !sessionPattern.test(sid)) { json(res, 400, { error: 'Invalid session ID' }); return; }
          await writes;
          if (pathname === '/__logs/tail') {
            const handle = await open(filename(sid), 'r');
            try {
              const info = await handle.stat(); const start = Math.max(0, info.size - 256 * 1024);
              const buffer = Buffer.alloc(info.size - start); await handle.read(buffer, 0, buffer.length, start);
              const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
              const events = lines.filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
              json(res, 200, { events: events.slice(-300), truncated: start > 0 || events.length > 300 });
            } finally { await handle.close(); }
          } else {
            const bytes = await readFile(filename(sid));
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="session-${sid}.ndjson"`, 'Cache-Control': 'no-store' }); res.end(bytes);
          }
          return;
        }
        json(res, 404, { error: 'Unknown logging endpoint' }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const parts = pathname.split(/[\\/]/);
      if (parts.some(part => part.startsWith('.') || part === 'logs' || part === 'certs' || /\.(pem|key|pfx|p12|ndjson|old)$/i.test(part))) { res.writeHead(403).end(); return; }
      const target = await realpath(path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname)));
      const resolvedRoot = await realpath(root);
      if (!target.startsWith(resolvedRoot + path.sep)) { res.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.md': 'text/plain', '.png': 'image/png' };
      const info = await stat(target);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      const type = types[path.extname(target)] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      let start = 0, end = info.size - 1, code = 200;
      const match = req.method === 'GET' && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (match && (match[1] || Number(match[2]) > 0)) {
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end(); return;
        }
        code = 206; headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + info.size;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      res.writeHead(code, headers);
      if (req.method === 'HEAD' || !info.size) { res.end(); return; }
      const stream = createReadStream(target, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      const code = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (code === 500 && !quiet) console.error('[server]', error);
      if (!res.headersSent) json(res, code, { error: code === 500 ? 'Server error; see terminal' : error.message }); else res.end();
    }
  }
  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.requestTimeout = 15000;
  server.logsSettled = () => writes;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8443), host = process.env.HOST || '127.0.0.1';
  const logDirectory = path.resolve(process.env.LOG_DIR || path.join(root, 'logs'));
  const tls = process.env.HTTPS_KEY && process.env.HTTPS_CERT ? {
    key: await readFile(process.env.HTTPS_KEY), cert: await readFile(process.env.HTTPS_CERT),
  } : null;
  const server = createServer({ logDirectory, tls });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the previous server or choose another PORT.` : error); process.exitCode = 1; });
  server.listen(port, host, () => {
    const scheme = tls ? 'https' : 'http';
    console.log(`Splat Placer: ${scheme}://localhost:${port}`);
    console.log(`Log viewer:      ${scheme}://localhost:${port}/logs.html`);
    console.log(`Logs on disk:    ${logDirectory}`);
    console.log(`Quest USB:       adb reverse tcp:${port} tcp:${port}`);
    console.log('Ctrl+C stops the server. Files are append-only; restart preserves existing logs.');
  });
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) return; stopping = true;
    server.close(); await server.logsSettled(); server.closeAllConnections();
  });
}
