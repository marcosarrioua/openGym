// Durable mirror for the JSON data files behind a PostgREST-compatible REST table
// (Supabase free tier). Zero new dependencies: Node's global fetch against the REST API.
//
// When REMOTE_URL + REMOTE_KEY are set this module is active:
//  - hydrate() fills a Map from the table at boot; server.js rewrites local files from
//    it so that every existing reader (readStateCached, coach, admin, MCP) is unaffected.
//  - put(key, value) is fire-and-forget from the caller: it stores the latest value
//    in a synchronous in-memory Map AND queues an upsert that is retried in FIFO order
//    until it lands (a transient network blip cannot silently lose a write).
//  - When REMOTE_URL/REMOTE_KEY are absent the module is inert — the file backend is
//    the whole of the story, exactly as before.
//
// Table DDL (run once in the SQL editor):
//   create table if not exists app_data (
//     key       text primary key,
//     val       jsonb not null,
//     updated_at timestamptz not null default now()
//   );
// A service_role key bypasses RLS; the table does not need any policies.

const cfg = () => ({ url: (process.env.REMOTE_URL || '').replace(/\/+$/, ''), key: process.env.REMOTE_KEY || '' });
export const enabled = () => Boolean(cfg().url && cfg().key);

const mem = new Map();   // key → current value (synchronous reads for the rest of server.js)
const pending = [];       // upserts not yet acknowledged, FIFO

/* ---- internal helpers ---------------------------------------------------- */

function tableUrl() { return cfg().url + '/rest/v1/app_data'; }

function headers() {
  return {
    'apikey': cfg().key,
    'Authorization': 'Bearer ' + cfg().key,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal'
  };
}

let flushing = false;
let retryTimer = null;
const RETRY_DELAY_MS = 1000;

async function flush() {
  flushing = true;
  while (pending.length) {
    // Take a snapshot of everything in the queue right now. If a put() races in
    // while we are mid-flush the new entry lands behind the snapshot and will be
    // picked up by a subsequent while pass — no data lost, no double-send.
    const batch = pending.splice(0, pending.length);
    try {
      const res = await fetch(tableUrl(), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(batch.map(({ key, value }) => ({ key, val: value })))
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`POST ${res.status} ${msg}`);
      }
    } catch (e) {
      // Re-enqueue the failed batch at the head of the queue, then schedule a
      // delayed retry. flushing stays true while the timer is pending so a
      // concurrent put() does not double-flush; the timer owns the next pass.
      pending.unshift(...batch);
      console.error('[remote-store] flush failed (will retry):', e.message);
      retryTimer = setTimeout(() => { retryTimer = null; flushing = false; flush(); }, RETRY_DELAY_MS);
      return;
    }
  }
  flushing = false;
}

function schedule() {
  if (flushing || retryTimer) return;
  flush();
}

/* ---- public API ---------------------------------------------------------- */

/** Hydrate the in-memory map from the remote table. Returns the map so the caller
 *  can use it synchronously (ESM top-level await). */
export async function hydrate() {
  if (!enabled()) return mem;
  const res = await fetch(`${tableUrl()}?select=key,val`, { headers: headers() });
  if (!res.ok) throw new Error(`hydrate GET ${res.status}`);
  const rows = await res.json();
  mem.clear();
  for (const { key, val } of rows) mem.set(key, val);
  return mem;
}

/** Read the latest value for a key from the in-memory mirror. */
export function memory() { return mem; }

/** Mirror a value. It is stored immediately in the memory map (so the rest of
 *  server.js sees it without waiting on the network), and a PostgREST upsert
 *  is fired in the background. A failed upsert is retried until it succeeds. */
export function put(key, value) {
  if (!enabled()) return;
  mem.set(key, value === undefined ? null : JSON.parse(JSON.stringify(value)));
  pending.push({ key, value });
  schedule();
}
