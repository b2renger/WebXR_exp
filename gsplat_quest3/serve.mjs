// Dev server for the Quest 3 splat placer, zero dependencies.
//
//   node serve.mjs            → http://localhost:8443  (+ https on 8444 if certs exist)
//
// Getting a SECURE CONTEXT on the Quest (WebXR requires one):
//   Option A (recommended, no certificates):
//       adb reverse tcp:8443 tcp:8443
//     then open http://localhost:8443 in the Quest browser — localhost is a
//     secure context, and adb tunnels it to this machine.
//   Option B (LAN + HTTPS): create key.pem/cert.pem next to this file:
//       openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=dev"
//     then open https://<pc-ip>:8444 on the Quest and accept the warning.
//
// Remote logging: the page POSTs batches of log lines to /log. They are
// appended to quest-logs.ndjson here and echoed to this console.
//   GET /logs        → last 300 log lines as plain text
//   GET /logs/clear  → truncate the log file

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, 'quest-logs.ndjson');
const PORT = Number(process.env.PORT || 8443);

// rotate an oversized log at startup so it never grows without bound
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    console.log('rotated oversized log to quest-logs.ndjson.old');
  }
} catch (e) { console.warn('log rotation failed:', e.message); }

// one persistent append stream — sync appends would stall .sog/.rad streaming
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', (e) => console.warn('log write failed:', e.message));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.sog': 'application/octet-stream', '.rad': 'application/octet-stream',
  '.spz': 'application/octet-stream', '.ply': 'application/octet-stream', '.png': 'image/png',
};

const stamp = () => new Date().toISOString().slice(11, 19);
const fmtLine = (e) => e.raw !== undefined
  ? `${e.recv || ''} [raw] ${e.raw}`
  : `${e.recv || ''} ${e.t}s [${e.level}] ${e.msg}`;

function handleLogPost(req, res) {
  let body = '';
  req.on('error', () => {});   // aborted beacons/keepalive posts must not crash the server
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e6) { res.writeHead(413).end(); req.destroy(); }
  });
  req.on('end', () => {
    const out = [];
    for (const line of body.split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        out.push(JSON.stringify({ recv: new Date().toISOString(), ...e }));
        const color = e.level === 'error' ? '\x1b[31m' : e.level === 'warn' ? '\x1b[33m' : e.level === 'xr' ? '\x1b[36m' : '';
        console.log(`${color}[quest ${stamp()}] ${e.t}s [${e.level}] ${e.msg}\x1b[0m`);
      } catch { out.push(JSON.stringify({ recv: new Date().toISOString(), raw: line })); }
    }
    if (out.length) logStream.write(out.join('\n') + '\n');
    res.writeHead(204).end();
  });
}

// read only the tail of the log file (it can grow large during a long session)
function readLogTail() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (!st.size) return '';
    const want = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, st.size - want);
    fs.closeSync(fd);
    return buf.toString('utf8').trim().split('\n').slice(-300).map((l) => {
      try { return fmtLine(JSON.parse(l)); } catch { return l; }
    }).join('\n');
  } catch { return ''; }
}

function serveStatic(req, res, urlPath) {
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Spark's paged .rad streaming fetches byte ranges — support single ranges.
    // 'bytes=-' (both sides empty) is invalid per RFC 9110: ignore it, serve 200.
    const m = st.size > 0 && req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const valid = m && (m[1] !== '' || (m[2] !== '' && Number(m[2]) > 0));
    if (valid) {
      const [, s, e] = m;
      const start = s === '' ? Math.max(0, st.size - Number(e)) : Number(s);
      const end = s !== '' && e !== '' ? Math.min(Number(e), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function handler(req, res) {
  try {
    req.on('error', () => {});
    res.on('error', () => {});
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
    catch { res.writeHead(400).end('bad url'); return; }
    if (req.method === 'POST' && urlPath === '/log') return handleLogPost(req, res);
    if (urlPath === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(readLogTail() || '(no logs yet)');
      return;
    }
    if (urlPath === '/logs/clear') {
      try { fs.truncateSync(LOG_FILE, 0); res.writeHead(200).end('cleared'); }
      catch (e) { res.writeHead(500).end('clear failed: ' + e.message); }
      return;
    }
    serveStatic(req, res, urlPath === '/' ? '/index.html' : urlPath);
  } catch (e) {
    console.warn('handler error:', e.message);
    try { res.writeHead(500).end(); } catch (e2) {}
  }
}

http.createServer(handler).listen(PORT, () => {
  console.log(`http  : http://localhost:${PORT}   (Quest: adb reverse tcp:${PORT} tcp:${PORT} → http://localhost:${PORT})`);
  console.log(`logs  : ${LOG_FILE}  |  tail: GET /logs`);
});

const key = path.join(ROOT, 'key.pem'), cert = path.join(ROOT, 'cert.pem');
if (fs.existsSync(key) && fs.existsSync(cert)) {
  https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler)
    .listen(PORT + 1, () => console.log(`https : https://<this-pc-ip>:${PORT + 1}  (accept the cert warning on the Quest)`));
} else {
  console.log('https : off (create key.pem/cert.pem to enable — see header comment)');
}
