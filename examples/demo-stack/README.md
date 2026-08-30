# Demo stack — incident rehearsal

A self-contained two-container stack (`demo-api` depends on `demo-db`) for
rehearsing Sentinel's full OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY loop
without touching any of your other production services. Its distinct
compose project name and internal-only network keep it isolated.

## 1. Bring the stack up

```bash
docker compose -p sentinel-demo -f examples/demo-stack/compose.yml up -d --build
```

Confirm `demo-api` is healthy: `curl http://127.0.0.1:8890/health` → `{"status":"ok"}`.

## 2. The dependency edge (now automatic)

Sentinel auto-discovers Docker Compose `depends_on` edges from the
labels compose stamps on each container, on every detector poll — so
`demo-api depends_on demo-db` registers itself within ~5 seconds of the
stack coming up. Nothing to do here.

This edge matters: `docker stop demo-db` exits **0**, and a clean exit
only raises an incident *because* something depends on it.

For a non-compose dependency (or to declare one by hand), the explicit
route still exists:

```bash
curl -X POST http://localhost:<sentinel-port>/api/resources/relationships \
  -H "Content-Type: application/json" -H "Cookie: sentinel_token=<your session cookie>" \
  -d '{
    "fromType": "container", "fromExternalId": "sentinel-demo-demo-api-1",
    "toType": "container", "toExternalId": "sentinel-demo-demo-db-1",
    "relationship": "depends_on"
  }'
```

(Container names come from `docker ps` — compose prefixes them with the
project name, `sentinel-demo-*-1` by default.)

## 3. The happy path

```bash
docker stop sentinel-demo-demo-db-1
```

Within ~10s (2 consecutive 5s detector polls), `demo-api`'s Docker
`HEALTHCHECK` starts failing (`demo-db` is unreachable), which fires the
`container_unhealthy` detector rule. Watch it through the loop:

```bash
curl http://localhost:<sentinel-port>/api/incidents
```

You should see, in order: an incident at `DETECTED` → `INVESTIGATING`
(evidence being gathered — container logs showing the database
connection timing out, git status showing no recent deploy) → `DIAGNOSED` (root cause + a
`restart_container` recommendation) → `AWAITING_APPROVAL`. Approve it:

```bash
curl -X POST http://localhost:<sentinel-port>/api/incidents/<id>/approve \
  -H "Content-Type: application/json" -H "Cookie: sentinel_token=<your session cookie>" \
  -d '{"actionId": <action-id-from-the-incident-detail>}'
```

The incident moves to `REMEDIATING` → `VERIFYING` → `RESOLVED` once
`demo-db` is confirmed running again.

## 4. The failure path (rehearse this too)

Break `demo-db` so a restart "succeeds" but the dependency never actually
recovers — this is the honesty check: Sentinel must report `FAILED`, not
lie about resolution.

```bash
docker stop sentinel-demo-demo-db-1
docker rm sentinel-demo-demo-db-1
# recreate demo-db with a command that will never come up healthy, e.g.:
docker run -d --name sentinel-demo-demo-db-1 --network sentinel-demo_demo-net \
  postgres:16-alpine postgres --this-flag-does-not-exist
```

Repeat the approve step above. The tool call itself will still "succeed"
(the container starts), but `demo-api`'s health never recovers, so
verification never converges and the incident ends at `FAILED`.

## Cleanup

```bash
docker compose -p sentinel-demo -f examples/demo-stack/compose.yml down -v
```
