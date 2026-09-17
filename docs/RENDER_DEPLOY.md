# Deploying openGym on Render (single service, single origin)

The classic self-hosted install ships as two containers behind one nginx (see
`SELF_HOSTING.md`). This guide is the Render equivalent: **one** Render web service that runs
both — nginx serving the app and the Node API on a second, internal port. Everything lives on
one HTTPS origin, which is what the passkey/WebAuthn flow and the signed session cookie require.

It's the cheapest way to put openGym on Render (one Starter instance, one small persistent
disk) and there is no second service to proxy between — `/api` goes straight to
`127.0.0.1` inside the container.

> Costs (Hobby workspace, as of 2026): one Starter web service ~$7/mo + one 1 GB persistent
> disk ~$0.25/mo. Free instances can't attach a persistent disk and lose `/data` on every
> restart, so a personal install with real workouts should be paid.

## What this deployment is

```
Browser ──► https://<you>.onrender.com  (nginx, port 10000)
                 │  static app  (frontend/dist)
                 │  /api/*  ────► 127.0.0.1:3000  (node server.js)
                 │                                   └── /data  (persistent disk)
                 │  images/GIFs ─────────────────► jsDelivr CDN (not from Render)
```

Deployment-relevant files:

- `render/Dockerfile` — multi-stage build: compiles `frontend/` (media pointed at the
  jsDelivr exercises dataset via `VITE_IMG_BASE`/`VITE_GIF_BASE`, passed by Render as
  Docker build args), then a final image with `nginx` + the API's prod deps and `dist/`.
- `render/run.sh` — entrypoint: renders `web/nginx.conf.template` (with
  `BACKEND=127.0.0.1`, so no DNS resolution is needed), starts nginx, then runs
  `node server.js` on port 3000 as PID 1.

No application code is modified — the guide only adds the two files above.

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
   - **Plan**: **Starter** (needed for the persistent disk).
3. **Disk persistence** → **Add Disk**: mount path `/data`, size `1 GB`.
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
| `DATA_DIR` | `/data` (the disk mount) |
| `ALLOW_GUEST` | `0` — no "Continue without account" entrance |
| `VAPID_SUBJECT` | `mailto:you@example.com` — a real address so Web Push is accepted |
| `VITE_IMG_BASE` | the images CDN URL (see below, optional — the Dockerfile has a default) |
| `VITE_GIF_BASE` | the GIFs CDN URL (see below, optional) |

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

## 5. Notifications (rest-timer & reminders)

The API generates VAPID keys into `/data/vapid.json` on first boot — the disk keeps them, so
they survive redeploys. The browser asks `/api/push/public-key` at runtime, no server env
needed. If you set `VAPID_SUBJECT`, use `mailto:you@example.com` (or your `https://` origin);
push services reject `mailto:admin@localhost`.

## 6. Backups

`/data` holds everything that matters (`db.json`, per-user state, `secret`, `vapid.json`,
`audit.log`):

- Render snapshots the disk once a day and keeps 7 days — usable to restore after corruption.
- In-app: Settings → export/backup downloads your state; keep a copy somewhere of your own.
- Human backup: everything is JSON in `/data`, so a nightly copy of that folder to your own
  storage is all that's needed (see `SELF_HOSTING.md` §6 for the same `tar czf` ritual).

## 7. Updating

Push to the repo (or hit **Manual Deploy → Deploy latest commit**) — Render rebuilds and
redeploys. A few seconds of downtime because of the disk; your data is untouched.

## 8. Costs and limits

| Item | Cost |
|---|---|
| Workspace (Hobby) | $0 |
| Starter web service | ~$7/mo |
| 1 GB persistent disk | ~$0.25/mo |

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