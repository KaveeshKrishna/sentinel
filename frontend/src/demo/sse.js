/**
 * Build a streaming `Response` whose body emits SSE `data:` frames on a
 * timer — the same wire format server/src/routes/{chat,deployments}.js
 * produce and AskSentinel.jsx / Deployments.jsx already parse.
 *
 * `steps` is an array of { after, event }:
 *   - after:  ms to wait before emitting, relative to the previous step
 *   - event:  an object → written as `data: {json}\n\n`
 *             the string 'done' → written as `event: done\ndata: {}\n\n`
 * `onFrame(event)` (optional) runs as each object frame is emitted, so a
 * script can mutate demo state (e.g. finish a chat turn) mid-stream.
 */
export function sseResponse(steps, onFrame) {
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      for (const { after, event } of steps) {
        if (cancelled) break;
        await sleep(after);
        if (cancelled) break;
        if (event === 'done') {
          controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`));
          try { onFrame?.(event); } catch { /* ignore */ }
        }
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
