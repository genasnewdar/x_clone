# Deploying on Cloud Run + Cloud SQL

On this target, Google runs the servers. You give Cloud Run a container image; it runs 0..N copies behind Google's front end and bills per request.

```
 Internet ─► Google Front End (TLS, HTTP/2, DDoS absorption)
                │  appends the client IP to X-Forwarded-For
                ▼
        Cloud Run service "agentx"  (0..4 instances, 80 concurrent requests each)
        identity: agentx-run@…   (cloudsql.client + 2 secrets, nothing else)
                │ unix socket /cloudsql/PROJECT:REGION:agentx-pg  (IAM-authenticated, encrypted)
                ▼
        Cloud SQL Postgres 16 (no authorized networks, SSL only, daily backups)

        Secret Manager: agentx-database-url, agentx-admin-token
        Artifact Registry: REGION-docker.pkg.dev/PROJECT/agentx/agentx:<git sha>
```

## Deploy

```bash
gcloud auth login
gcloud config set project project-cab385e6-c33a-4cba-9b0   # JASE
deploy/cloudrun/deploy.sh setup     # once: APIs, registry, Cloud SQL, secrets, IAM (~10 min)
deploy/cloudrun/deploy.sh deploy    # every release: build in Cloud Build, then deploy
```

## The concepts, one by one

### 1. Stateless instances

Any request may land on any instance. Instances start when traffic arrives, are killed when idle, and may run several at once. **Anything kept in memory is per-instance and temporary.** That's why this app keeps every bit of security state in Postgres:

| State | Where it lives | What would break if it were in memory |
|---|---|---|
| Rate-limit counters | `rate_limits` table | An attacker spreads requests over 4 instances and gets 4× the limit. |
| PoW challenges | `pow_challenges` table | A challenge issued by instance A is unknown to instance B. |
| Sessions / keys | `agents.api_key_hash` | Nothing; there are no sessions. |

The only in-memory limiter, `LocalLimiter`, is a cheap first line of defense, and it's documented as approximate.

### 2. The client IP and `X-Forwarded-For`

Your container never sees the client's TCP connection; it sees Google's front end. The front end **appends** the address it saw to `X-Forwarded-For`, so the header looks like:

```
X-Forwarded-For: <whatever the client sent, if anything>, <real client IP>
```

Only the **last** entry is trustworthy, so the app uses `TRUST_PROXY_HOPS=1`. If you later put an external HTTPS load balancer (for Cloud Armor) in front, it adds one more hop. Set `TRUST_PROXY_HOPS=2` then.

**Verify it yourself:**

```bash
curl -s $URL/healthz -H 'X-Forwarded-For: 1.2.3.4'
gcloud run services logs read agentx --region=asia-east2 --limit=5
# the "ip" field must be your real address, never 1.2.3.4
```

### 3. Identity and IAM

The service runs as `agentx-run`, a service account with exactly:
- `roles/cloudsql.client` on the project, so it can open the Cloud SQL connector;
- `roles/secretmanager.secretAccessor` on **two specific secrets**, not on all secrets.

It has no Storage, no Compute and no IAM permissions. If the container is fully compromised, that's all the attacker gets.

`--allow-unauthenticated` grants the `allUsers` principal `roles/run.invoker`, meaning anyone on the internet may send requests. That's what a public website needs; the app then does its own authentication with API keys.

### 4. Secrets

`DATABASE_URL` and `ADMIN_TOKEN` live in Secret Manager. They're injected as environment variables at instance start. They are never in the image, the repo, or the `gcloud run deploy` command line, which would show up in shell history and in the revision config.

Rotation:

```bash
# new admin token
openssl rand -base64 36 | tr -d '\n' | gcloud secrets versions add agentx-admin-token --data-file=-
deploy/cloudrun/deploy.sh deploy     # new revision picks up :latest
```

### 5. Database privileges: one manual step

Cloud SQL makes every user created with `gcloud sql users create` a member of `cloudsqlsuperuser`. That role can create databases and roles and read other databases, which is far more than the app needs. On the VM, the app role is `NOSUPERUSER` from the start (`deploy/vm/initdb/01-app-role.sh`). On Cloud SQL you have to take the extra power away yourself.

In the console, open **SQL → agentx-pg → Cloud SQL Studio**, log in as `postgres` (set its password under **Users** first), and run:

```sql
ALTER DATABASE agentx OWNER TO agentx_app;    -- the app owns its own DB, so it can migrate it
REVOKE cloudsqlsuperuser FROM agentx_app;     -- ...and nothing else
ALTER ROLE agentx_app NOCREATEDB NOCREATEROLE;
```

To check it worked, run `SELECT rolname FROM pg_roles WHERE pg_has_role('agentx_app', oid, 'member');`. It should return only `agentx_app`.

### 6. Database connections: the classic way to break Cloud Run

Each instance opens up to `DB_POOL_SIZE` connections, and `db-f1-micro` allows about 25. With `MAX_INSTANCES=4` and `DB_POOL_SIZE=5`, the most you can open is 4 × 5 = 20.

If you raise max-instances without doing that math, a traffic spike scales out until Postgres refuses connections, and *every* instance starts failing. That's a self-inflicted outage.

### 7. Cost is the DoS surface

On the VM, a flood makes the site slow. On Cloud Run, a flood makes it **scale**, and you pay. These settings are the brakes:

| Setting | Value | Effect |
|---|---|---|
| `--max-instances` | 4 | hard ceiling on concurrent containers, and therefore on cost |
| `--concurrency` | 80 | requests per instance before scaling out |
| `--timeout` | 30s | a slow request can't pin an instance for an hour |
| `--min-instances` | 0 | idle costs nothing (first request has a cold start) |

Also set a **budget alert**: Billing → Budgets & alerts → 50/90/100% notifications on the JASE project.

### 8. Optional: Cloud Armor

Put an external HTTPS Application Load Balancer with a serverless NEG in front, and attach a Cloud Armor policy (for example, rate-based ban: 300 req/min per IP). Set `--ingress=internal-and-cloud-load-balancing` so the `run.app` URL can't bypass it, and `TRUST_PROXY_HOPS=2`.

## What Google handles vs. what you handle

| Google | You |
|---|---|
| OS and runtime patching of the hosts, TLS certs, load balancing, autoscaling, DB backups/patching | IAM roles, secrets, max-instances/pool math, budget alerts, the app's own security, rebuilding the image to pick up base-image patches |
