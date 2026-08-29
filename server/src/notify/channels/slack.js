'use strict';

/**
 * Slack incoming webhook.
 *
 * Deliberately uses plain link buttons (`type: 'button'` with a `url`)
 * rather than Slack's interactive actions: link buttons work with a
 * bare incoming-webhook URL, with no Slack app to create, no OAuth, and
 * no request-signature-verifying endpoint to expose. The approval
 * security lives in the signed link itself (notify/approveLink.js),
 * which is also what makes the identical flow work on Discord and email.
 */
function render(n) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${n.title}*` } },
    {
      type: 'section',
      fields: n.fields.slice(0, 10).map(f => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${truncate(f.value, 300)}`
      }))
    }
  ];

  if (n.links.length > 0) {
    blocks.push({
      type: 'actions',
      elements: n.links.map(l => ({
        type: 'button',
        text: { type: 'plain_text', text: l.label },
        url: l.url,
        ...(l.primary ? { style: 'primary' } : {})
      }))
    });
  }

  return { text: n.title, blocks };
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

module.exports = { render };
