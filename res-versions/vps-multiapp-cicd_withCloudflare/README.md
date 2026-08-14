# Multi-app VPS with shared Postgres/MinIO/Redis, Cloudflare Tunnel, Ansible + Git CI/CD

One VPS, one Postgres container, one MinIO container, one Redis container,
one Caddy reverse proxy, and a Cloudflare Tunnel that's the *only* way in -
**no inbound ports are open at all**, not even SSH. Every app gets its own
database, bucket, and/or Redis key-prefix + ACL user, plus its own
`docker-compose.yml`. Ansible provisions the box and deploys apps; a GitHub
Actions workflow triggers Ansible on every push, connecting the same way you
do: through the tunnel, never a raw IP.

## Why this networking model

You mentioned your ISP rotates your IP - that's actually irrelevant here,
which is the point. Nothing on the VPS listens for inbound connections from
the public internet:

- **cloudflared** runs on the VPS and opens an *outbound* connection to
  Cloudflare's edge. Public hostnames (`app1.example.com`, `ssh.example.com`,
  etc.) are routed through that outbound tunnel to internal services -
  there's no listening socket on the VPS's public interface for any of them.
- **Caddy** (the internal reverse proxy) binds to `127.0.0.1:8080` only -
  loopback, unreachable from outside the machine regardless of firewall.
- **Postgres / MinIO / Redis** publish no host ports at all - only reachable
  container-to-container over the internal `shared_net` docker network.
- **ufw** is set to default-deny-incoming with nothing allowed back in - not
  even port 22. There's nothing to allowlist by IP because there's nothing
  listening to allowlist against.
- Access control is **identity-based via Cloudflare Access**, not IP-based.
  You authenticate to Cloudflare (browser SSO for humans, a service token for
  CI), and *then* Cloudflare proxies you through the tunnel to the VPS. Your
  IP - rotating or not - never matters.

This also covers your other two asks: Cloudflare sits in front of MinIO for
both the S3 API (`s3.example.com`) and the web console
(`minio-console.example.com`), and Caddy is what actually does the
host-based routing behind it, since MinIO's console in particular needs a
real reverse proxy in front of it (Cloudflare Tunnel alone routes by
hostname to *one* internal address - Caddy is what lets several
`*.example.com` hostnames share the tunnel and land on different
containers).

## Layout

```
group_vars/all/vars.yml     <- app registry + all public hostnames + tunnel ID
group_vars/all/vault.yml    <- ENCRYPTED secrets (passwords, keys, tunnel credentials) - you create this
playbooks/                  <- provision / deploy / backup / restore
roles/
  docker/                   <- installs Docker + creates the shared network
  cloudflared/               <- installs+configures the Cloudflare Tunnel (verified up before firewall locks down)
  shared_services/          <- deploys Postgres + MinIO + Redis + Caddy, creates per-app DBs/buckets/ACL users
  app_deploy/                <- syncs one app's folder, renders its .env, brings it up
  backup/                    <- backup.sh / restore.sh + nightly cron
  firewall/                  <- ufw default-deny-incoming, runs LAST in provision.yml
apps/
  app1-notes-api/            <- demo: Node/Express using SHARED postgres + SHARED redis (cache)
  app2-static-site/          <- demo: nginx static site, no database at all
  app3-file-vault/           <- demo: Flask upload service using the SHARED minio
.github/workflows/deploy.yml <- CI/CD entrypoint, connects via the tunnel too
└── README.md
```

## 0. One-time Cloudflare setup (before touching Ansible)

You need a domain on Cloudflare and `cloudflared` installed on your own
machine (`brew install cloudflared` / see cloudflare.com/downloads).

```bash
cloudflared tunnel login                        # opens a browser, pick your domain
cloudflared tunnel create vps-tunnel             # writes ~/.cloudflared/<TUNNEL_ID>.json, prints the ID

# Point every hostname you'll use at the tunnel:
cloudflared tunnel route dns vps-tunnel app1.example.com
cloudflared tunnel route dns vps-tunnel app2.example.com
cloudflared tunnel route dns vps-tunnel app3.example.com
cloudflared tunnel route dns vps-tunnel s3.example.com
cloudflared tunnel route dns vps-tunnel minio-console.example.com
cloudflared tunnel route dns vps-tunnel ssh.example.com
```

Then, in the Cloudflare Zero Trust dashboard:
- **Access -> Applications**: create a Self-hosted app for `ssh.example.com`
  (and optionally the others) with a policy for who can reach it - your
  email for interactive login, and/or a **Service Token** (Access ->
  Service Auth) for headless CI access. Save the token's Client ID/Secret -
  you'll put those in GitHub Actions secrets, not in this repo.
- Copy the contents of `~/.cloudflared/<TUNNEL_ID>.json` - that goes into
  `vault.yml` as `cloudflare_tunnel_credentials_json`, and the ID itself goes
  into `vars.yml` as `cloudflare_tunnel_id`.

## 1. First-time setup

```bash
cp inventory/hosts.ini.example inventory/hosts.ini
# For the FIRST run only, uncomment the direct-IP [vps] block and comment out
# the tunnel-based one - the tunnel doesn't exist on the server yet.

cp group_vars/all/vault.yml.example group_vars/all/vault.yml
# edit vault.yml: real passwords + the tunnel credentials JSON from step 0
ansible-vault encrypt group_vars/all/vault.yml

echo 'your-vault-password' > .vault_pass.txt
chmod 600 .vault_pass.txt

# edit vars.yml: set cloudflare_tunnel_id and your real domains

ansible-galaxy collection install community.docker community.general ansible.posix
```

`.vault_pass.txt` and `inventory/hosts.ini` are already in `.gitignore` -
never commit them.

## 2. Provision the VPS (once, over the direct IP - then never again)

```bash
ansible-playbook playbooks/provision.yml
```

Order matters here, and the playbook enforces it: Docker -> **cloudflared
(and it waits until the tunnel actually reports a connection before moving
on)** -> Postgres/MinIO/Redis/Caddy + per-app databases/buckets/ACL users ->
backup cron -> **firewall lockdown, last**. If the tunnel fails to come up,
the play stops before ufw ever runs, so you can't get locked out by a broken
tunnel config - only by a broken *this* SSH session after it succeeds, which
is expected.

**Immediately after this completes**, in a second terminal, verify the
tunnel path works before you close your direct-IP session:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname ssh.example.com" deploy@ssh.example.com
```

Once that works, edit `inventory/hosts.ini` to use the tunnel-based `[vps]`
block (the example file has it ready, commented) and delete/comment the
direct-IP one. Every command below assumes you've done this.

## 3. Deploy the demo apps

```bash
ansible-playbook playbooks/deploy.yml                       # all apps
ansible-playbook playbooks/deploy.yml -e app=app1-notes-api  # just one
```

Each app's `.env` is rendered on the server from `vault.yml` - the real
`.env` file never lives in git, only the `.env.j2` template does.

Try them (once DNS/tunnel routes are live):
```bash
curl https://app1.example.com/notes -X POST -H 'Content-Type: application/json' -d '{"content":"hello"}'
curl https://app1.example.com/notes/count      # redis-cached count, backed by shared redis
curl https://app2.example.com/                 # static site
curl https://app3.example.com/files            # empty list from the shared minio bucket
curl https://s3.example.com/app3-uploads/       # MinIO S3 API, path-style
# https://minio-console.example.com             # MinIO web console, in a browser
```

## 4. Swap in your real apps

1. Delete or keep the demo folders under `apps/` as you like.
2. Drop your real app in `apps/your-app-name/` with its own `docker-compose.yml`
   (join network `shared_net`, connect to host `postgres` / `minio` / `redis`,
   **do not publish any ports** - Caddy reaches it by container name) and,
   if it needs secrets, a `.env.j2` template.
3. Add an entry to the `apps:` list in `group_vars/all/vars.yml`, including
   `internal_port` (the port your app's container listens on) and `domain`.
4. Add its secrets to `vault.yml` (`ansible-vault edit group_vars/all/vault.yml`).
5. Add a DNS route for its domain: `cloudflared tunnel route dns vps-tunnel your-app.example.com`.
6. Commit and push to `main` - GitHub Actions runs `deploy.yml` for you
   (re-running `deploy.yml` also re-renders the Caddyfile/tunnel config via
   `provision.yml` if you change routing - run that too when you add a
   domain). Or run it yourself:
   `ansible-playbook playbooks/provision.yml && ansible-playbook playbooks/deploy.yml -e app=your-app-name`.

## 5. Backups & restore (never lose data on an update)

- Nightly, everything is backed up automatically to `/opt/backups/` on the VPS
  (Postgres via `pg_dump`, MinIO via `mc mirror`, Redis via `BGSAVE` + RDB copy,
  all gzipped, 14-day retention by default - change `backup_keep_days` in
  `vars.yml`). Note: Redis is one shared keyspace isolated by ACL + key
  prefix rather than separate instances, so its backup/restore is
  whole-instance, not per app - restoring it restores every app's cached
  keys at once. That's usually fine since Redis here is a cache, not a
  system of record; if any app needs Redis data to be durable and
  independently restorable, give that app its own Redis container instead.
- **Every deploy also runs a backup first**, automatically, for any app that
  has a database or bucket (`roles/app_deploy/tasks/main.yml` calls the backup
  role before touching containers). A bad deploy can't cost you the data.
- Manual backup any time: `ansible-playbook playbooks/backup.yml [-e app=app1-notes-api]`
- Restore:
  ```bash
  ansible-playbook playbooks/restore.yml -e kind=db -e name=app1_db \
    -e file=/opt/backups/postgres/app1_db-20260101-020000.sql.gz

  ansible-playbook playbooks/restore.yml -e kind=bucket -e name=app3-uploads \
    -e file=/opt/backups/minio/app3-uploads-20260101-020000.tar.gz

  ansible-playbook playbooks/restore.yml -e kind=redis -e name=- \
    -e file=/opt/backups/redis/dump-20260101-020000.rdb.gz
  ```
- Want off-server copies too (recommended)? Add an `rclone sync /opt/backups
  remote:bucket` line to the cron job in `roles/backup/tasks/main.yml` once
  you've configured an `rclone` remote - local-only backups don't survive the
  VPS itself dying.

## 6. CI/CD (GitHub Actions -> Cloudflare Tunnel -> Ansible -> VPS)

`.github/workflows/deploy.yml` runs on every push to `main` that touches
`apps/`, `roles/`, `playbooks/`, or `group_vars/`. It installs Ansible and
`cloudflared` on the runner, writes a temporary inventory that connects
through the tunnel using a Cloudflare Access **service token** (headless,
no browser), decrypts the vault, and runs `playbooks/deploy.yml`. You can
also trigger it manually from the Actions tab and target a single app.

Add these secrets in your GitHub repo settings (Settings -> Secrets and
variables -> Actions):

| Secret | Value |
|---|---|
| `VPS_SSH_HOSTNAME` | `ssh.example.com` (your SSH tunnel hostname, not an IP) |
| `VPS_USER` | SSH user (e.g. `deploy`) |
| `VPS_SSH_KEY` | private key with access to that user |
| `ANSIBLE_VAULT_PASSWORD` | the same password you put in `.vault_pass.txt` |
| `CF_ACCESS_CLIENT_ID` | Client ID of the Cloudflare Access Service Token from step 0 |
| `CF_ACCESS_CLIENT_SECRET` | Client Secret of that same service token |

No port is ever opened for this to work - the runner authenticates to
Cloudflare Access with the service token, and Cloudflare proxies it through
the same outbound tunnel the VPS already has open.

## Why this shape (answers to the questions behind the request)

- **Is Ansible the right tool?** For "one VPS, several isolated compose
  stacks, need secrets management and repeatable provisioning" - yes.
  It's agentless (just SSH), idempotent (safe to re-run provision/deploy any
  time), and Vault gives you encrypted secrets in git for free. Kubernetes/
  Swarm would be overkill for a single box; a bare git-push hook would work
  but you'd end up hand-rolling backup ordering, secret templating, and
  multi-app orchestration yourself - Ansible already has clean primitives for
  all three.
- **Shared Postgres/MinIO/Redis, isolated by name** - matches what you asked
  for. Each app gets its own DB (own user, own grants), bucket (own scoped
  IAM policy in MinIO, not root credentials), or Redis ACL user restricted
  to its own key prefix, so an app can't see another app's data even though
  they share the container.
- **Won't lose data on updates** - deploys are sequenced backup-first, and
  syncing app code explicitly excludes `.env` from deletion so a redeploy
  can't wipe a live secret file. Volumes for Postgres/MinIO/Redis are named
  docker volumes, untouched by app deploys entirely.
- **Vault for `.env`-based apps** - secrets live once, encrypted, in
  `vault.yml`; each app's `.env.j2` template pulls only the keys it needs and
  Ansible renders the real `.env` directly on the server, so plaintext
  secrets never touch git.
- **Zero open ports despite a rotating ISP IP** - covered above under "Why
  this networking model". Short version: nothing listens publicly, so there's
  no IP to allowlist in the first place; Cloudflare Access authenticates
  *you*, not your address.

