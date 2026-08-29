'use strict';

/**
 * Discord webhook.
 *
 * Discord does not allow buttons on plain webhook messages (components
 * require a bot application), so links go into the embed description as
 * markdown instead. Same signed URL, same one-tap behaviour on a phone —
 * only the affordance differs.
 */
function render(n) {
  const description = [
    n.text,
    '',
    ...n.links.map(l => `**[${l.label}](${l.url})**`)
  ].join('\n');

  return {
    embeds: [{
      title: n.title,
      description: truncate(description, 4000),
      color: n.colorInt,
      fields: n.fields.slice(0, 25).map(f => ({
        name: f.label,
        value: truncate(f.value, 1000),
        inline: false
      })),
      timestamp: new Date().toISOString(),
      footer: { text: 'Sentinel' }
    }]
  };
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

module.exports = { render };
