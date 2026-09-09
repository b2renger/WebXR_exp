// Optional local preview, no dependencies or build step. Production is static files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const target = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.md': 'text/plain', '.png': 'image/png' };
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': (types[path.extname(target)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8450);
  createServer().listen(port, '127.0.0.1', () => console.log(`Spatial Mapping: http://localhost:${port}`));
}
