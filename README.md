# Multi-app VPS with shared Postgres/MinIO/Redis, Ansible + Git CI/CD

One VPS, one Postgres container, one MinIO container, one Redis container.
Every app gets its own database, bucket, and/or Redis key-prefix + ACL user,
plus its own `docker-compose.yml` - but nobody runs their own copy of
Postgres/MinIO/Redis. Ansible provisions the box and deploys apps; a GitHub
Actions workflow triggers Ansible on every push.

## Layout

```
group_vars/all/vars.yml     <- the app registry (name, db_name, minio_bucket, domain)
group_vars/all/vault.yml    <- ENCRYPTED secrets (passwords, keys) - you create this
playbooks/                  <- provision / deploy / backup / restore
roles/
  docker/                   <- installs Docker + creates the shared network
  shared_services/          <- deploys Postgres + MinIO + Redis, creates per-app DBs/buckets/ACL users
  app_deploy/                <- syncs one app's folder, renders its .env, brings it up
  backup/                    <- backup.sh / restore.sh + nightly cron
apps/
  app1-notes-api/            <- demo: Node/Express using SHARED postgres + SHARED redis (cache)
  app2-static-site/          <- demo: nginx static site, no database at all
  app3-file-vault/           <- demo: Flask upload service using the SHARED minio
.github/workflows/deploy.yml <- CI/CD entrypoint
```

## 1. First-time setup

```bash
cp inventory/hosts.ini.example inventory/hosts.ini      # fill in your VPS IP/user/key
cp group_vars/all/vault.yml.example group_vars/all/vault.yml
# edit vault.yml with real passwords, then encrypt it:
ansible-vault encrypt group_vars/all/vault.yml

# so ansible-playbook can decrypt it locally without prompting every time:
echo 'your-vault-password' > .vault_pass.txt
chmod 600 .vault_pass.txt

ansible-galaxy collection install community.docker community.general ansible.posix
```

`.vault_pass.txt` and `inventory/hosts.ini` are already in `.gitignore` -
never commit them.

## 2. Provision the VPS (once, and safely re-runnable)

```bash
ansible-playbook playbooks/provision.yml
```

This installs Docker, creates the `shared_net` network, brings up Postgres +
MinIO + Redis, creates a database/user for every app in `vars.yml` that
declares a `db_name`, a bucket + scoped access key for every app that
declares a `minio_bucket`, a Redis ACL user restricted to `<appname>:*` keys
for every app with `redis_enabled: true`, and installs `/opt/scripts/backup.sh`
with a nightly cron job.

## 3. Deploy the demo apps

```bash
ansible-playbook playbooks/deploy.yml                       # all apps
ansible-playbook playbooks/deploy.yml -e app=app1-notes-api  # just one
```

Each app's `.env` is rendered on the server from `vault.yml` - the real
`.env` file never lives in git, only the `.env.j2` template does.

Try them:
```bash
curl http://YOUR_VPS_IP:3001/notes -X POST -H 'Content-Type: application/json' -d '{"content":"hello"}'
curl http://YOUR_VPS_IP:3001/notes/count      # redis-cached count, backed by shared redis
curl http://YOUR_VPS_IP:3002/                 # static site
curl http://YOUR_VPS_IP:3003/files            # empty list from the shared minio bucket
```
(Put nginx/Caddy + real domains + TLS in front of these ports for production -
that's intentionally out of scope here so the example stays focused.)

## 4. Swap in your real apps

1. Delete or keep the demo folders under `apps/` as you like.
2. Drop your real app in `apps/your-app-name/` with its own `docker-compose.yml`
   (join network `shared_net`, connect to host `postgres` / `minio`) and,
   if it needs secrets, a `.env.j2` template.
3. Add an entry to the `apps:` list in `group_vars/all/vars.yml`.
4. Add its secrets to `vault.yml` (`ansible-vault edit group_vars/all/vault.yml`).
5. Commit and push to `main` - GitHub Actions runs `deploy.yml` for you.
   Or run it yourself: `ansible-playbook playbooks/deploy.yml -e app=your-app-name`.

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

## 6. CI/CD (GitHub Actions -> Ansible -> VPS over SSH)

`.github/workflows/deploy.yml` runs on every push to `main` that touches
`apps/`, `roles/`, `playbooks/`, or `group_vars/`. It installs Ansible on the
runner, writes a temporary inventory pointing at your VPS, decrypts the
vault, and runs `playbooks/deploy.yml`. You can also trigger it manually from
the Actions tab and target a single app.

Add these secrets in your GitHub repo settings (Settings -> Secrets and
variables -> Actions):

| Secret | Value |
|---|---|
| `VPS_HOST` | your VPS IP or hostname |
| `VPS_USER` | SSH user (e.g. `deploy`) |
| `VPS_SSH_KEY` | private key with access to that user |
| `ANSIBLE_VAULT_PASSWORD` | the same password you put in `.vault_pass.txt` |

No agent needs to run on the VPS - Ansible connects over plain SSH from the
GitHub runner, same as running it from your laptop.

## Why this shape (answers to the questions behind the request)

- **Is Ansible the right tool?** For "one VPS, several isolated compose
  stacks, need secrets management and repeatable provisioning" - yes.
  It's agentless (just SSH), idempotent (safe to re-run provision/deploy any
  time), and Vault gives you encrypted secrets in git for free. Kubernetes/
  Swarm would be overkill for a single box; a bare git-push hook would work
  but you'd end up hand-rolling backup ordering, secret templating, and
  multi-app orchestration yourself - Ansible already has clean primitives for
  all three.
- **Shared Postgres/MinIO, isolated by name** - matches what you asked for.
  Each app gets its own DB (own user, own grants) or bucket (own scoped IAM
  policy in MinIO, not root credentials), so an app can't see another app's
  data even though they share the container.
- **Won't lose data on updates** - deploys are sequenced backup-first, and
  syncing app code explicitly excludes `.env` from deletion so a redeploy
  can't wipe a live secret file. Volumes for Postgres/MinIO are named docker
  volumes, untouched by app deploys entirely.
- **Vault for `.env`-based apps** - secrets live once, encrypted, in
  `vault.yml`; each app's `.env.j2` template pulls only the keys it needs and
  Ansible renders the real `.env` directly on the server, so plaintext
  secrets never touch git.
