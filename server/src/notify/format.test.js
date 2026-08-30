'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotification } = require('./format');
const slack = require('./channels/slack');
const discord = require('./channels/discord');
const webhook = require('./channels/webhook');

const INCIDENT = {
  id: 12,
  resource_id: 3,
  trigger_rule: 'service_inactive',
  trigger_summary: 'caddy is inactive',
  root_cause: 'caddy exited after a config reload failed'
};
const RESOURCE = { name: 'caddy', type: 'service' };
const ACTION = { id: 5, tool_name: 'restart_service', real_risk: 'MEDIUM_RISK', status: 'proposed' };

function notification(overrides = {}) {
  return buildNotification('INCIDENT_AWAITING_APPROVAL', {
    incident: INCIDENT, resource: RESOURCE, action: ACTION,
    approveUrl: 'https://s.example.com/a/tok',
    incidentUrl: 'https://s.example.com/incidents/12',
    ...overrides
  });
}

test('the canonical payload carries resource, trigger, root cause and action', () => {
  const n = notification();
  assert.match(n.title, /Approval needed · Incident #12/);
  const labels = n.fields.map(f => f.label);
  assert.deepEqual(labels, ['Resource', 'Trigger', 'Root cause', 'Proposed action']);
  assert.match(n.fields[0].value, /caddy \(service\)/);
  assert.match(n.fields[3].value, /restart_service \(MEDIUM_RISK\)/);
});

test('the approve link is listed first, ahead of the plain deep link', () => {
  // On a phone the approve button is the reason the message was opened.
  const n = notification();
  assert.equal(n.links.length, 2);
  assert.equal(n.links[0].primary, true);
  assert.match(n.links[0].label, /Approve restart_service/);
  assert.equal(n.links[1].label, 'Open in Sentinel');
});

test('no approve link is emitted when one was not supplied', () => {
  const n = notification({ approveUrl: null });
  assert.equal(n.links.length, 1);
  assert.equal(n.links[0].label, 'Open in Sentinel');
});

test('an incident with no action or root cause still renders', () => {
  const n = buildNotification('INCIDENT_DETECTED', {
    incident: { id: 1, resource_id: 9, trigger_rule: 'container_exit', trigger_summary: 'exited (1)' }
  });
  assert.match(n.title, /Incident detected/);
  assert.deepEqual(n.fields.map(f => f.label), ['Resource', 'Trigger']);
  assert.match(n.fields[0].value, /resource #9/);
  assert.equal(n.links.length, 0);
});

test('slack renders blocks with url buttons (no Slack app required)', () => {
  const payload = slack.render(notification());
  assert.equal(payload.text, notification().title);

  const actions = payload.blocks.find(b => b.type === 'actions');
  assert.equal(actions.elements.length, 2);
  assert.equal(actions.elements[0].type, 'button');
  assert.equal(actions.elements[0].url, 'https://s.example.com/a/tok');
  assert.equal(actions.elements[0].style, 'primary');
  // A plain link button needs no interactivity endpoint to verify.
  assert.ok(!JSON.stringify(payload).includes('action_id'));
});

test('slack omits the actions block entirely when there are no links', () => {
  const payload = slack.render(notification({ approveUrl: null, incidentUrl: null }));
  assert.equal(payload.blocks.find(b => b.type === 'actions'), undefined);
});

test('discord renders an embed with links in the description', () => {
  // Discord webhooks cannot carry buttons without a bot application.
  const payload = discord.render(notification());
  const embed = payload.embeds[0];
  assert.match(embed.description, /\[Approve restart_service\]\(https:\/\/s\.example\.com\/a\/tok\)/);
  assert.equal(typeof embed.color, 'number');
  assert.equal(embed.fields.length, 4);
  assert.equal(embed.footer.text, 'Sentinel');
});

test('the generic webhook emits the canonical structure unshaped', () => {
  const payload = webhook.render(notification());
  assert.equal(payload.source, 'sentinel');
  assert.equal(payload.event, 'INCIDENT_AWAITING_APPROVAL');
  assert.equal(payload.links[0].url, 'https://s.example.com/a/tok');
  assert.equal(payload.fields.length, 4);
});

test('long field values are truncated for the providers that cap them', () => {
  const long = 'x'.repeat(5000);
  const n = notification({ incident: { ...INCIDENT, root_cause: long } });

  const slackField = slack.render(n).blocks[1].fields.find(f => f.text.startsWith('*Root cause*'));
  assert.ok(slackField.text.length < 400);

  const discordField = discord.render(n).embeds[0].fields.find(f => f.name === 'Root cause');
  assert.ok(discordField.value.length <= 1001);
});
