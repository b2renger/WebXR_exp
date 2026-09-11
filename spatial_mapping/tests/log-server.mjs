import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../serve.mjs';

export async function testLogServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-server-regression-'));
  const results = [];
  let server, base;
  async function start(logDirectory = directory) {
    server = createServer({ logDirectory, quiet: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function stop() { await server.logsSettled(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const event = seq => ({ schema: 1, sid: 'server-test-session', seq, time: new Date().toISOString(), elapsedMs: seq * 10, level: 'info', event: 'test.event', data: { text: 'roundtrip', seq } });
  const post = (events, headers = {}) => fetch(base + '/__logs/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ events }) });
  await start();
  try {
    assert.equal((await fetch(base + '/__logs/config.json').then(r => r.json())).protocol, 'spatial-log-v1');
    results.push('Log protocol discovery');
    const response = await post([event(1), event(2)]);
    assert.equal(response.status, 200); assert.equal((await response.json()).acknowledged, 2);
    const filename = path.join(directory, 'session-server-test-session.ndjson');
    const lines = (await readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(line => line.seq), [1, 2]); assert.ok(lines.every(line => line.serverReceivedAt));
    results.push('Server acknowledges events only after writing them to disk');
    await Promise.all([post([event(2), event(3)]), post([event(3)])]);
    assert.equal((await readFile(filename, 'utf8')).trim().split('\n').length, 3);
    results.push('Concurrent retries do not duplicate session events');
    await stop(); await start();
    await post([event(2), event(3), event(4)]);
    assert.equal((await readFile(filename, 'utf8')).trim().split('\n').length, 4);
    results.push('Deduplication survives server restart');
    assert.equal((await post([{ ...event(5), sid: '../escape' }])).status, 400);
    assert.equal((await post([event(5)], { Origin: 'https://unrelated.example' })).status, 403);
    results.push('Invalid session paths and cross-origin injection are rejected');
    const sessions = await fetch(base + '/__logs/sessions.json').then(r => r.json());
    assert.equal(sessions[0].sid, 'server-test-session');
    const tail = await fetch(base + '/__logs/tail?session=server-test-session').then(r => r.json());
    assert.equal(tail.events.length, 4);
    assert.equal((await fetch(base + '/__logs/download/server-test-session.ndjson').then(r => r.text())).trim().split('\n').length, 4);
    results.push('Session listing, tail preview, and full download preserve saved events');
    assert.equal((await fetch(base + '/.git/config')).status, 403);
    assert.equal((await fetch(base + '/logs/session-server-test-session.ndjson')).status, 403);
    assert.equal((await fetch(base + '/key.pem')).status, 403);
    assert.equal((await fetch(base + '/certs/secret.key')).status, 403);
    assert.equal((await fetch(base + '/logs/clear')).status, 403);
    const source = await readFile(new URL('../index.html', import.meta.url));
    const range = await fetch(base + '/index.html', { headers: { Range: 'bytes=10-29' } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), source.subarray(10, 30));
    const suffix = await fetch(base + '/index.html', { headers: { Range: 'bytes=-12' } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), source.subarray(-12));
    assert.equal((await fetch(base + '/index.html', { headers: { Range: 'bytes=99999999-' } })).status, 416);
    const head = await fetch(base + '/index.html', { method: 'HEAD' });
    assert.equal(Number(head.headers.get('Content-Length')), source.length); assert.equal((await head.text()).length, 0);
    results.push('Byte ranges, suffix ranges, invalid ranges, and HEAD support streaming');
    results.push('Private files and raw log directories are excluded from static serving');
    await stop();
    const blocked = path.join(directory, 'not-a-directory'); await writeFile(blocked, 'fixture'); await start(blocked);
    assert.equal((await post([event(9)])).status, 500);
    results.push('Disk write failure does not acknowledge the batch');
  } finally { await stop(); }
  return results;
}
