/**
 * Scripted deploy / rollback SSE streams for the demo. Frame shape matches
 * server/src/routes/deployments.js ({ step, type, data, ts }) which
 * Deployments.jsx and IncidentDetail.jsx already parse.
 */
import { sseResponse } from './sse.js';
import { getState, mutate, nextId } from './state.js';
import { broadcast, withMeta } from './liveSim.js';

const line = (step, type, data) => ({ event: { step, type, data } });

export function runDeployStream(repoName) {
  const s = getState();
  const repo = s.repos.find(r => r.name === repoName);
  const newHash = randHash();

  const steps = [
    { after: 200, ...line('start', 'info', `▶ Deploying ${repoName}`) },
    { after: 600, ...line('fetch', 'log', '$ git fetch --all --prune') },
    { after: 900, ...line('fetch', 'log', `remote: Enumerating objects: 42, done.`) },
    { after: 500, ...line('pull', 'log', '$ git pull --ff-only') },
    { after: 1100, ...line('pull', 'success', `Updated ${repo?.commit?.hash || 'abc1234'}..${newHash} (${repo?.behind || 2} commits)`) },
    { after: 400, ...line('build', 'log', '$ docker compose build') },
    { after: 1600, ...line('build', 'success', 'Successfully built 3 images') },
    { after: 300, ...line('up', 'log', '$ docker compose up -d') },
    { after: 1400, ...line('up', 'success', 'Recreated demo-web, demo-api') },
    { after: 400, ...line('success', 'success', `✔ ${repoName} deployed — now at ${newHash}`) },
    { after: 150, event: 'done' },
  ];

  const onFrame = (ev) => {
    if (ev.step === 'success') {
      mutate(() => {
        if (repo) {
          repo.behind = 0; repo.ahead = 0;
          repo.commit = { ...repo.commit, hash: newHash, fullHash: newHash + '0'.repeat(33), date: new Date().toISOString(), message: `deploy: ${repoName} via Sentinel demo` };
        }
        const e = { id: nextId('activity'), type: 'DEPLOYMENT', message: `${repoName}: deployed ${newHash} successfully`, timestamp: Date.now(), details: null };
        s.activity = [e, ...s.activity].slice(0, 50);
        broadcast({ type: 'activity', data: withMeta(e) });
      });
    }
  };

  return sseResponse(steps, onFrame);
}

export function runRollbackStream(repoName, sha) {
  const short = String(sha || '').slice(0, 7);
  const steps = [
    { after: 200, ...line('start', 'info', `▶ Rolling ${repoName} back to ${short}`) },
    { after: 600, ...line('reset', 'log', `$ git reset --hard ${short}`) },
    { after: 900, ...line('reset', 'success', `HEAD is now at ${short}`) },
    { after: 400, ...line('build', 'log', '$ docker compose build') },
    { after: 1500, ...line('build', 'success', 'Successfully built 3 images') },
    { after: 300, ...line('up', 'log', '$ docker compose up -d') },
    { after: 1300, ...line('up', 'success', 'Recreated demo-web, demo-api') },
    { after: 400, ...line('success', 'success', `✔ ${repoName} rolled back to ${short}`) },
    { after: 150, event: 'done' },
  ];
  return sseResponse(steps, () => {
    mutate(s => {
      const e = { id: nextId('activity'), type: 'DEPLOYMENT', message: `${repoName}: rolled back to ${short}`, timestamp: Date.now(), details: null };
      s.activity = [e, ...s.activity].slice(0, 50);
      broadcast({ type: 'activity', data: withMeta(e) });
    });
  });
}

function randHash() {
  return Math.random().toString(16).slice(2, 9);
}
