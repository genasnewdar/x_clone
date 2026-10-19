# Handoff: where things stand

**Branch:** `claude/amazing-davinci-3h8hic`. Draft PR into `main`: https://github.com/genasnewdar/x_clone/pull/1

## Done and verified (in the cloud dev session)

- **API** (`server/`): 96/96 tests passing against Postgres 16. Typecheck clean; `npm audit` reports 0 vulnerabilities.
- **Security review:** an independent adversarial review found 16 issues. All are fixed, each has a regression test (`server/test/review.test.ts`), and the deploy-time items are covered below.
- **Web UI** (`web/`): build and 18 tokenizer tests pass. Playwright saw no CSP violations or console errors.
- **Simulator** (`sim/`): ran against a local server with 0 × 429 and 0 × 5xx. LLM mode is untested against the real API because no Anthropic key was available.
- **Docker image:** builds. The full VM stack (Caddy, app, Postgres) ran locally and passed these checks:
  - a spoofed `X-Forwarded-For` is ignored
  - the database can't be reached from Caddy and has no internet access
  - the app's DB role is not a superuser
  - the app container's filesystem is read-only

## Not done yet

1. **GitHub Actions never starts the jobs.** Each job ends in about 2 seconds with no logs. That's an account-level block (billing, spending limit or Actions disabled), not the code. The reason is shown at the top of any run page.
2. **Nothing is deployed to GCP yet.** The project is JASE, `project-cab385e6-c33a-4cba-9b0`. The deploy scripts have never run against a real project, so expect a fix or two on the first run.

## Next steps (run on a machine logged in to gcloud)

```bash
gcloud auth list                                   # right account?
gcloud config set project project-cab385e6-c33a-4cba-9b0
# 0. Budget alert: console -> Billing -> Budgets & alerts (do this first)
deploy/cloudrun/deploy.sh setup     # APIs, Artifact Registry, Cloud SQL, secrets, IAM (~10 min)
#    then run the 3 SQL lines it prints in Cloud SQL Studio (docs/DEPLOY_CLOUDRUN.md section 5)
deploy/cloudrun/deploy.sh deploy    # Cloud Build -> Cloud Run, prints the URL
```

## Verify before sharing the URL

```bash
URL=https://...run.app
curl -s $URL/healthz -H 'X-Forwarded-For: 1.2.3.4'
gcloud run services logs read agentx --region=asia-east2 --limit=5
# "ip" must be YOUR address. If it is 1.2.3.4, the TRUST_PROXY_HOPS setting is wrong: stop and fix it.
```

Then seed some activity:

```bash
cd sim && npm ci
ADMIN_TOKEN=$(gcloud secrets versions access latest --secret=agentx-admin-token) \
AGENTX_BASE_URL=$URL SIM_STATE_FILE=.agents.cloudrun.json npx tsx sim.ts --templates
```

## After that

- The VM target (`docs/DEPLOY_VM.md`) as the learning lab, or as round 2 of the challenge.
- A brainstorm on the red-team rules of engagement (draft in `SECURITY.md`) before handing the URL to Codex.
- Later: CI/CD to GCP using Workload Identity Federation, with no stored keys.
