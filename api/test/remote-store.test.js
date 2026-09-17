/* The durable mirror (remote-store.js) against a fake PostgREST table, so it can be
   exercised without a Supabase account. Covers: hydration, upsert, FIFO retry after a
   transient 5xx, and the fully-disabled case (no env vars = the file backend owns all). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function startMock() {
  const rows = new Map();
  let failing = 0; // POSTs left to answer with 503
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/rest/v1/app_data') {
      res.writeHead(200);
      return res.end(JSON.stringify([...rows.entries()].map(([key, val]) => ({ key, val }))));
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/app_data') {
      if (failing > 0) { failing--; res.writeHead(503); return res.end('{"message":"db busy"}'); }
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => {
        for (const { key, val } of JSON.parse(body)) rows.set(key, val);
        res.writeHead(201);
        res.end('[]');
      });
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, rows, url: `http://127.0.0.1:${server.address().port}`, failNextPost: n => { failing = n; } })));
}

const waitFor = async (cond, ms = 1500) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('condition not met in time');
};

test('hydrate fills the memory map from the table', async () => {
  const mock = await startMock();
  mock.rows.set('db', { users: [{ id: 'u1' }], creds: [] });
  process.env.REMOTE_URL = mock.url;
  process.env.REMOTE_KEY = 'test-key';
  const remote = await import('../remote-store.js');
  try {
    await remote.hydrate();
    assert.deepEqual(remote.memory().get('db'), { users: [{ id: 'u1' }], creds: [] });
  } finally {
    mock.server.close();
    delete process.env.REMOTE_URL;
    delete process.env.REMOTE_KEY;
  }
});

test('put mirrors synchronously to memory and reliably to the table (upsert)', async () => {
  const mock = await startMock();
  process.env.REMOTE_URL = mock.url;
  process.env.REMOTE_KEY = 'test-key';
  const remote = await import('../remote-store.js');
  try {
    remote.put('db', { users: [{ id: 'u1' }], subs: [] });
    remote.put('state:u1', { _rev: 3, workouts: [] });
    await waitFor(() => mock.rows.size === 2);
    assert.deepEqual(mock.rows.get('db'), { users: [{ id: 'u1' }], subs: [] });
    assert.deepEqual(mock.rows.get('state:u1'), { _rev: 3, workouts: [] });
    // a later write to the same key replaces it in order
    remote.put('db', { users: [{ id: 'u1' }], subs: [], invites: [] });
    await waitFor(() => mock.rows.get('db')?.invites !== undefined);
    assert.equal(mock.rows.size, 2);
  } finally {
    mock.server.close();
    delete process.env.REMOTE_URL;
    delete process.env.REMOTE_KEY;
  }
});

test('a failed flush is retried (FIFO) by the next write', async () => {
  const mock = await startMock();
  process.env.REMOTE_URL = mock.url;
  process.env.REMOTE_KEY = 'test-key';
  const remote = await import('../remote-store.js');
  try {
    mock.failNextPost(1);
    remote.put('first', { n: 1 });          // flush #1 → 503, re-enqueued at the head
    remote.put('second', { n: 2 });          // flush #2 retries first, then sends second
    await waitFor(() => mock.rows.has('first') && mock.rows.has('second'));
    assert.deepEqual(mock.rows.get('first'), { n: 1 });
    assert.deepEqual(mock.rows.get('second'), { n: 2 });
  } finally {
    mock.server.close();
    delete process.env.REMOTE_URL;
    delete process.env.REMOTE_KEY;
  }
});

test('without REMOTE_URL/REMOTE_KEY the module is inert', async () => {
  const mock = await startMock();
  const remote = await import('../remote-store.js');
  try {
    assert.equal(remote.enabled(), false);
    remote.put('x', 1);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(mock.rows.size, 0, 'nothing may reach the table when the mirror is off');
  } finally {
    mock.server.close();
  }
});