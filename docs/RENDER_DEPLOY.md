# Deploying openGym on Render (single service, single origin)

The classic self-hosted install ships as two containers behind one nginx (see
`SELF_HOSTING.md`). This guide is the Render equivalent: **one** Render web service that runs
both — nginx serving the app and the Node API on a second, internal port. Everything lives on
one HTTPS origin, which is what the passkey/WebAuthn flow and the signed session cookie require.

It's the cheapest way to put openGym on Render (one instance, no second service to proxy
between — `/api` goes straight to `127.0.0.1` inside the container): instances can sleep, so
with the optional durable mirror below even the **free** plan keeps your data between
spin-downs (see §3).

> Costs (Hobby workspace, as of 2026): one Starter web service ~$7/mo + one 1 GB persistent
> disk ~$0.25/mo. The **free** plan costs $0 but has an ephemeral filesystem — local files
> are wiped on every spin-down (15 min without traffic) — and only 750 wake-hours/month, so
> it is a good fit **only** with the remote JSON mirror configured (and you accept the
> ~1-minute cold start).

## What this deployment is

```
Browser ──► https://<you>.onrender.com  (nginx, port 10000)
                 │  static app  (frontend/dist)
                 │  /api/*  ────► 127.0.0.1:3000  (node server.js)
                 │                                   └── /data  (files — keep, don't lose)
                 │                                   └── remote table (PostgREST, optional)
                 │                                      → survives free-plan spin-downs
                 │  images/GIFs ─────────────────► jsDelivr CDN (not from Render)
```

Deployment-relevant files:

- `render/Dockerfile` — multi-stage build: compiles `frontend/` (media pointed at the
  jsDelivr exercises dataset via `VITE_IMG_BASE`/`VITE_GIF_BASE`, passed by Render as
  Docker build args), then a final image with `nginx` + the API's prod deps and `dist/`.
- `render/run.sh` — entrypoint: renders `web/nginx.conf.template` (with
  `BACKEND=127.0.0.1`, so no DNS resolution is needed), starts nginx, then runs
  `node server.js` on port 3000 as PID 1.

Application code changes are limited to two small additions, both harmless when unconfigured:
`BOOTSTRAP_ADMIN` in `api/server.js` (first registered user becomes admin — the no-shell
bootstrap in §4) and `api/remote-store.js`, the optional durable JSON mirror (§3 → Free plan).

## 1. Prerequisites

- The repo pushed to GitHub (Render deploys from it, or from a private repo you connect).
  This repo's canonical remotes are GitLab + GitHub; either works.
- A Render account with a Hobby workspace.

## 2. Create the web service

1. Render dashboard → **New** → **Web Service** → connect the repository.
2. Configure:
   - **Root Directory**: `.`
   - **Environment**: `Docker`
   - **Dockerfile Path**: `render/Dockerfile`
   - **Region**: any (pick the one closest to you; internal traffic is irrelevant here).
   - **Plan**: **Starter** if you want the persistent disk, or **Free** if you instead use
     the remote JSON mirror from §3 (a free instance spins down after 15 idle minutes and
     takes ~1 minute to wake; two caveats in §4).
3. **Disk persistence** → **Add Disk**: mount path `/data`, size `1 GB` — *Starter only*, and
   only if you are not using the remote mirror.
   (A disk disables zero-downtime redeploys — a deploy restarts the instance for a few
   seconds. Fine for a single user. Disk size can be increased later but never decreased.)
4. **Health Check Path**: `/api/health`.

Render will build the image. Watch the logs: the container is up when you see
`gym-api on :3000 (rpID=…, origin=…)`. The service is then live at
`https://<you>.onrender.com` — use exactly that URL in the env vars below.

## 3. Environment variables

| Variable | Value |
|---|---|
| `RP_ID` | `<you>.onrender.com` — must equal the hostname in the address bar exactly |
| `ORIGIN` | `https://<you>.onrender.com` |
| `DATA_DIR` | `/data` (the disk mount, if you have one) |
| `ALLOW_GUEST` | `0` — no "Continue without account" entrance |
| `VAPID_SUBJECT` | `mailto:you@example.com` — a real address so Web Push is accepted |
| `VITE_IMG_BASE` | the images CDN URL (see below, optional — the Dockerfile has a default) |
| `VITE_GIF_BASE` | the GIFs CDN URL (see below, optional) |
| `REMOTE_URL` | **Free plan only** — your PostgREST table base URL (see below) |
| `REMOTE_KEY` | **Free plan only** — the *service_role* secret for that table |

### Free plan — the durable mirror

A free instance's filesystem is wiped every time it spins down, so `/data` on its own is not
enough. `api/remote-store.js` mirrors the JSON documents (users, credentials, invites, push
subscriptions, session secret, VAPID keys and every profile's state) into a PostgREST table;
at boot the API re-hydrates `/data` from it before serving, so a spin-down followed by a cold
start is invisible to the data.

Setup (any Postgres with PostgREST works; Supabase's free tier is the low-friction option):

1. [supabase.com](https://supabase.com) → **New project** (free). Skip the starter SQL.
2. **SQL Editor → New query** and run:
   ```sql
   create table if not exists app_data (
     key         text primary key,
     val         jsonb not null,
     updated_at  timestamptz not null default now()
   );
   ```
   (The service_role key bypasses row-level security, so no policies are needed.)
3. **Project Settings → API** and copy the **Project URL** and the **`service_role` secret.**
4. On Render set `REMOTE_URL=https://<ref>.supabase.co` and `REMOTE_KEY=<service_role>`,
   then **Save, rebuild, and deploy**.

Boot, writes and data all round-trip through this table; the rows are literally the same JSON
files, so a future migration back to files is a copy/paste. Without these two variables the
mirror stays completely off and everything behaves exactly as the file-only self-host.

A ready-to-import template with these values commented lives at `render/.env.example`
(Settings → Environment → "Add from .env").

Defaults baked into the Dockerfile that you normally don't touch: `BACKEND=127.0.0.1`,
`PORT=3000` (node's port), `NGINX_PORT=10000` (Render's public port), `RESOLVER=127.0.0.11`,
`CF_CONNECTING_IP=""`.

**Media.** Exercise images/GIFs are not shipped in the image — `render/Dockerfile` points the
build at the jsDelivr copy used by the demo:

```
ARG VITE_IMG_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/
ARG VITE_GIF_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/
```

To use different mirrors, set `VITE_IMG_BASE`/`VITE_GIF_BASE` as service env vars with
**Save & rebuild** — Render injects them as Docker build args of the same name and the new
bundle points at them.

Add/change env vars with **Save, rebuild, and deploy** so a value you need at build time
(`VITE_*`) actually reaches the image. **Disable auto-deploy** or not — it only triggers on
pushes to the watched branch; both setups are fine.

## 4. First account + click "invite only"

The instance starts with registrations open (`INVITE_ONLY` unset) so the **first** account can
be created — there is no admin yet to mint an invite code. `BOOTSTRAP_ADMIN=1` makes that first
account an admin (sets `user.admin`) automatically, so you never need Render shell access or
your uid:

1. Set `BOOTSTRAP_ADMIN=1` in the service's **Environment** (it's in `render/.env.example`).
2. Visit `https://<you>.onrender.com` and **create your profile** with a passkey. Because the
   database is empty, your account is born as admin.
3. In the service's **Environment**, add `INVITE_ONLY=1` (you can keep or drop
   `BOOTSTRAP_ADMIN` — it only ever affects the very first user), then **Save, rebuild, and
   deploy**.
4. Verify: `https://<you>.onrender.com/api/config` returns `{"invite_only":true,
   "allow_guest":false,…}`. The login screen no longer offers "Continue without account".
5. Future accounts: from the Admin screen (`#/admin`) mint invite codes and hand them out.
   Existing accounts are unaffected when the toggle is flipped.

> **Free-plan realities** (skip on paid): the instance spins down after 15 idle minutes — the
> first visit after idle shows a ~1-minute Render loading page while it wakes; and an account's
> *passkey* works on the cold start only if you use the same browser/device that created it
> (nothing is cached server-side). Also, a workspace shares 750 wake-hours/month across all its
> free services — if the app is pinged 24/7 it runs out partway through the month and pauses
> until the 1st. Data is safe between sleep/wake rounds as long as the durable mirror is on
> (each write is mirrored within a second).

## 5. Notifications (rest-timer & reminders)

The API generates VAPID keys into `/data/vapid.json` on first boot — the disk keeps them, so
they survive redeploys. The browser asks `/api/push/public-key` at runtime, no server env
needed. If you set `VAPID_SUBJECT`, use `mailto:you@example.com` (or your `https://` origin);
push services reject `mailto:admin@localhost`.

## 6. Backups

`/data` holds everything that matters (`db.json`, per-user state, `secret`, `vapid.json`,
`audit.log`):

- With the durable mirror on, the **remote table is your backup**: it already contains every
  document, so back it up too (Supabase dashboard → Database → table viewer is enough for a
  quick look).
- On Starter: Render snapshots the disk once a day and keeps 7 days — usable to restore after
  corruption.
- In-app: Settings → export/backup downloads your state; keep a copy somewhere of your own.
- Human backup: everything is JSON, so a nightly copy of that folder (or of the remote table's
  rows) to your own storage is all that's needed (see `SELF_HOSTING.md` §6 for the same
  `tar czf` ritual). Note that `audit.log` is the only file NOT mirrored remotely.

## 7. Updating

Push to the repo (or hit **Manual Deploy → Deploy latest commit**) — Render rebuilds and
redeploys. A few seconds of downtime because of the disk; your data is untouched.

## 8. Costs and limits

| Item | Cost |
|---|---|
| Workspace (Hobby) | $0 |
| **Free web service** (needs the remote mirror) | $0 |
| Starter web service | ~$7/mo |
| 1 GB persistent disk | ~$0.25/mo |
| Supabase free (Project + PostgREST table) | $0 |

- Exercise images are served from the CDN, so outbound bandwidth stays trivial.
- The AI Coach is not included (its runtime dependency is skipped in this image) and its UI
  stays hidden until a server advertises it — nothing to configure.
- Changing hostnames later (e.g. adding your own domain) also changes `RP_ID`: existing
  passkeys stop matching and you re-register your passkey on the new address. Sessions/signed
  values still verify because `secret` lives on the disk.

## Troubleshooting

- **`/api/health` doesn't come back from Render's health check**: open the service logs — you
  want the `gym-api on :3000` line and no `nginx: [emerg]` lines. Then curl the app URL:
  `curl https://<you>.onrender.com/api/health`.
- **Passkey prompt doesn't appear**: you're almost certainly not on exactly `https://<you>
  .onrender.com` (a migrated hostname, a trailing path, an `http://` bookmark). `RP_ID` and
  `ORIGIN` must match the address bar byte for byte.
- **Exercise images broken**: the bundle was built with `VITE_IMG_BASE`/`VITE_GIF_BASE`
  pointing somewhere unreachable — rebuild with **Save, rebuild, and deploy** after setting
  them.
- **Data gone after redeploy**: the disk isn't mounted (check the service's Disks section) or
  a free instance was used (no persistent disks on Free).