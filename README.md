# Lost Planet Escalation League

Tracker for a Warhammer Horus Heresy escalation league run by the Lost Planet Discord. Players join with a league code, keep one army list per points tier, and report games. Standings are public. There are no accounts.

A fresh data directory starts empty apart from three default tiers: 1000, 1500, and 2000 points, one calendar month each. No sample roster is shipped.

## Local run

Node.js 22 or newer. There are no runtime dependencies.

```bash
npm start
```

Open http://localhost:3871

For a known admin password and join code:

```bash
ADMIN_PASSWORD='choose-a-long-password' JOIN_CODE='lost-planet' npm start
```

If `JOIN_CODE` is unset, development prints a code once at startup. It is stored as a hash, not in plaintext. If `ADMIN_PASSWORD` is unset or weak, the process still starts locally and admin login stays disabled.

League files go in `./data` unless you set `DATA_DIR`. That folder is gitignored.

```bash
npm test
```

## How it works

- **Tiers.** Defaults are 1000, 1500, and 2000 points, each covering one UTC calendar month. An admin can edit the name, points, and start/end dates, and can add a tier. The current tier is the one whose dates contain today (UTC). If two overlap, the one that started most recently wins.
- **Join.** A player enters the league code, name, faction, and allegiance (Loyalist or Traitor). The browser stores a personal edit token in `localStorage`. A recovery code is shown once. Entering it on another device issues a new token and signs the old one out. The recovery code stays the same until an admin replaces it. Tokens and recovery codes are hashed at rest.
- **Army lists.** One list per player per tier, as pasted text or an http(s) link. The player can edit it until the tier end date, inclusive. Admins can always edit.
- **Games.** Two players, a tier (defaults to the current one), and a win, loss, or draw. Optional scores and notes. Either player can report it. Admins can edit or delete reports. Players cannot.
- **Standings.** Public. Wins, losses, draws, and games played for one tier or overall, plus who has not played yet in the selected tier. Names link to that player's lists and games. Sort is wins, then fewer losses, then draws, then name.
- **Admin.** Password from `ADMIN_PASSWORD`. The session is an HttpOnly, SameSite=Lax cookie (Secure on https). Admins edit tiers, change the join code, edit or remove players, edit lists and reports, download a JSON backup, and restore one. Restore shows a summary first and writes only after you type `RESTORE`.

Join attempts and admin logins are rate-limited per IP. JSON files are written atomically (write a temp file, then rename).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port. Default `3871`. Render sets this. |
| `HOST` | No | Bind address. Default `0.0.0.0`. |
| `DATA_DIR` | In production | Directory for the JSON files. Default `./data`, which is fine locally. On Render set this to the disk mount, `/var/data`. |
| `NODE_ENV` | In production | `production` turns on the data-directory and password checks. |
| `RENDER` | Set by Render | Any non-empty value is treated as production for the data-directory check, same as `NODE_ENV=production`. |
| `ADMIN_PASSWORD` | In production | Admin password. At least 12 characters, not a common phrase, and not all digits. Missing or weak refuses to start in production. |
| `JOIN_CODE` | In production, until one is stored | Code players type to join. Hashed at rest. 6 to 64 characters. A stored code survives restart. `JOIN_CODE_FORCE=1` replaces the stored code from this variable. |
| `TRUST_PROXY` | On Render | Leave unset when Node sees the client directly. The rate limiter then ignores `X-Forwarded-For`. Render is one proxy hop, so set this to `1` there. |
| `ALLOW_EPHEMERAL_DATA` | No | Set to `1` only to override the production refusal when `DATA_DIR` is missing or points inside the app. The process logs a loud warning. The league is then wiped on the next deploy. Leave it unset. |
| `LEAGUE_TODAY` | No | `YYYY-MM-DD` override for tests. Ignored in production. |
| `AUTH_MAX_ATTEMPTS` | No | Optional per-IP cap used outside production. Ignored in production. |
| `MAX_BODY_BYTES` | No | JSON body cap. Default 1 MB. |
| `RESTORE_MAX_BYTES` | No | Backup upload cap. Default 8 MB. |

A good production boot logs this line:

```text
Data directory: /var/data
```

If `DATA_DIR` is unset, or the path resolves inside the application directory, production refuses to start. That includes `NODE_ENV=production` and Render's own `RENDER` variable. Fix the path and look for the line above.

## Deploy on Render

This creates a **paid** web service. Check [Render's pricing page](https://render.com/pricing) before you turn it on. Prices below were checked against that page on 3 November 2026.

- The small paid web service is **$7 per month**: 0.5 CPU, 512 MB RAM. Render's current plan id is `0.5c-512mb`. The blueprint calls this Starter and sets `plan: starter`. If Blueprint rejects that name, change the one line to `0.5c-512mb`. Same size, same $7 price.
- A persistent disk is **$0.25 per GB per month**. The blueprint uses 1 GB, about **$0.25 per month**.
- Together that is about **$7.25 per month**, plus whatever bandwidth your workspace does not already include. A Hobby workspace is $0 plus compute.
- A **Free** web service cannot attach a disk. Its filesystem is wiped on redeploy, restart, and when it spins down after 15 idle minutes. Do not use Free for this league.

`render.yaml` creates one web service and the 1 GB disk. It does not create a database or any other service. Secrets are not in git: `ADMIN_PASSWORD` and `JOIN_CODE` are `sync: false`, so Render asks for them when you apply the blueprint.

### Blueprint

1. In the Render dashboard, choose **New → Blueprint**.
2. Select this repo. Render reads `render.yaml`.
3. When it asks, set `ADMIN_PASSWORD` to a long password and `JOIN_CODE` to the code players will type.
4. Apply the blueprint. It creates a web service with a disk named `league-data` mounted at `/var/data`, and sets `DATA_DIR=/var/data`, `NODE_ENV=production`, and `TRUST_PROXY=1`.

The disk and `DATA_DIR` in `render.yaml` apply only when Render creates the service from this blueprint.

### By hand

A web service you create yourself does **not** read `render.yaml`. It does not get the disk, and it does not get `DATA_DIR`, unless you add both yourself.

1. **New → Web Service**, connect this repo.
2. Runtime **Node**. Build command `npm install`. Start command `npm start`.
3. Instance type: the **$7** plan (`starter` / plan id `0.5c-512mb`), not Free.
4. Add a disk. Mount path **`/var/data`**. Size 1 GB is enough. You can grow it later. You cannot shrink it.
5. Set `DATA_DIR` to **`/var/data`** yourself.
6. Set `NODE_ENV` to `production`, `TRUST_PROXY` to `1`, `ADMIN_PASSWORD`, and `JOIN_CODE`.
7. Health check path: `/health`.

Disks only keep files under the mount path. `DATA_DIR` must be that path. The rest of the container, including the git checkout, is replaced on every deploy.

After the first boot, open the logs and confirm this line:

```text
Data directory: /var/data
```

That is the check that the process is using the disk. If the line is missing, or the process refused to start, `DATA_DIR` was unset or still pointed at the code directory. Fix it and redeploy. Do not set `ALLOW_EPHEMERAL_DATA` on a league you want to keep.

## Backups

**Download backup** on the admin page exports tiers, players, lists, reports, and the join-code hash. It does not include admin sessions. Tokens and the join code are hashes, not plaintext, but the file is still secret. **Restore** shows a summary first and replaces the league only after you type `RESTORE`. The server keeps a pre-restore copy in `DATA_DIR/backups/`.

## Roadmap

- Discord webhook when a game is reported or a tier changes
- Tiebreakers and a points system beyond wins, losses, and draws
- Richer player history pages (head-to-head, record over time)

The player page already shows that player's lists and games.

## Project structure

- `server.js` — JSON API and static file server
- `index.html`, `games.html`, `join.html`, `play.html`, `player.html`, `admin.html` — mobile-first pages
- `css/site.css`, `js/` — shared styles and page scripts
- `test/` — `node:test` coverage for standings, tiers, auth, permissions, the data directory, and backup/restore
- `render.yaml` — Render blueprint
