'use strict';

/**
 * Generic JSON webhook — the canonical payload, unshaped, for anything
 * that isn't Slack or Discord (a homelab bot, ntfy, an email bridge, a
 * custom automation). Deliberately the same structure buildNotification
 * produces, so a consumer can rely on it.
 */
function render(n) {
  return {
    source: 'sentinel',
    event: n.event,
    title: n.title,
    text: n.text,
    color: n.color,
    fields: n.fields,
    links: n.links,
    ts: Date.now()
  };
}

module.exports = { render };
