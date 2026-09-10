# Demo stack, for rehearsing an incident

A small two-container stack (`demo-api` depends on `demo-db`) you can use to run through Sentinel's whole OBSERVE → DIAGNOSE → PLAN → ACT → VERIFY loop without touching any of your other real services. It runs under its own compose project name and its own network, so it stays isolated.

## 1. Bring it up

```bash
docker compose -p sentinel-demo -f examples/demo-stack/compose.yml up -d --build
```

Check `demo-api` is healthy: `curl http://127.0.0.1:8890/health` should give you `{"status":"ok"}`.

## 2. The dependency link (this part is automatic)

Sentinel picks up Docker Compose's `depends_on` info from the labels compose adds to each container, every time it polls. So `demo-api depends_on demo-db` registers itself within about 5 seconds of the stack coming up, you don't have to do anything for this step.

It matters because `docker stop demo-db` exits with code 0, a clean exit. The only reason that turns into an incident at all is because something else depends on it.

If you're not using compose, or you want to declare a dependency yourself, there's a manual way too:

```bash
curl -X POST http://localhost:<sentinel-port>/api/resources/relationships \
  -H "Content-Type: application/json" -H "Cookie: sentinel_token=<your session cookie>" \
  -d '{
    "fromType": "container", "fromExternalId": "sentinel-demo-demo-api-1",
    "toType": "container", "toExternalId": "sentinel-demo-demo-db-1",
    "relationship": "depends_on"
  }'
```

(Container names come from `docker ps`, compose prefixes them with the project name, so `sentinel-demo-*-1` by default.)

## 3. Try the happy path

```bash
docker stop sentinel-demo-demo-db-1
```

Within about 10 seconds (two 5-second detector polls), `demo-api`'s Docker healthcheck starts failing since it can't reach `demo-db` anymore, and that trips the `container_unhealthy` rule. Watch it move through the loop:

```bash
curl http://localhost:<sentinel-port>/api/incidents
```

You should see it go `DETECTED` → `INVESTIGATING` (gathering evidence, logs showing the DB connection timing out, checking if there was a recent deploy) → `DIAGNOSED` (a cause plus a `restart_container` suggestion) → `AWAITING_APPROVAL`. Approve it:

```bash
curl -X POST http://localhost:<sentinel-port>/api/incidents/<id>/approve \
  -H "Content-Type: application/json" -H "Cookie: sentinel_token=<your session cookie>" \
  -d '{"actionId": <action-id-from-the-incident-detail>}'
```

It'll move to `REMEDIATING` → `VERIFYING` → `RESOLVED` once `demo-db` is actually back up and confirmed healthy.

## 4. Try the failure path too

This one's worth doing on purpose: break `demo-db` in a way where a restart looks like it "succeeds" but the dependency never actually comes back. This is the honesty check, Sentinel needs to say `FAILED` here, not pretend everything's fine.

```bash
docker stop sentinel-demo-demo-db-1
docker rm sentinel-demo-demo-db-1
# bring demo-db back with something that will never actually get healthy, e.g.:
docker run -d --name sentinel-demo-demo-db-1 --network sentinel-demo_demo-net \
  postgres:16-alpine postgres --this-flag-does-not-exist
```

Approve the fix the same way as above. The restart itself will "succeed" (the container does start), but `demo-api` never gets healthy again, so verification never passes and the incident ends at `FAILED` instead of `RESOLVED`.

## Cleaning up

```bash
docker compose -p sentinel-demo -f examples/demo-stack/compose.yml down -v
```
