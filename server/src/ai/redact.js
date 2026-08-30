'use strict';

// Patterns for common secret shapes that must never reach an AI prompt or
// be persisted to incident_evidence/ai_runs. Not exhaustive — a
// defense-in-depth pass, not the only control (the tool registry itself
// has no tool that returns raw secret files). Deliberately does NOT match
// a generic long hex/base64 blob — git commit SHAs and container IDs are
// exactly that shape, and are legitimate, important evidence.
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,           // Anthropic-style
  /sk-[A-Za-z0-9_-]{10,}/g,               // OpenAI-style
  /AIza[A-Za-z0-9_-]{20,}/g,              // Google/Gemini-style
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /(api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi
];

const MAX_LENGTH = 2000;

/** Scrub secret-shaped substrings and cap length before persisting/sending a string. */
function redact(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]');
  if (out.length > MAX_LENGTH) out = out.slice(0, MAX_LENGTH) + '… [truncated]';
  return out;
}

module.exports = { redact, MAX_LENGTH };
