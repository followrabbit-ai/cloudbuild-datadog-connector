'use strict';

// Cloud Build step output -> Datadog log events.
//
// Correlation: Datadog documents automatic CI job-log correlation only for the
// providers it integrates with natively (GitHub, GitLab, Azure). For a custom
// provider we attach the same attributes those integrations produce —
// `ci.pipeline.id` and `ci.job.id` — matching the ids map.js assigns, so a log
// line points at the exact job it came from.
//
// Datadog lowercases `ddtags` but preserves attribute case (verified against
// US5), so anything you need to match exactly belongs in an attribute, not a
// tag. Build ids are lowercase UUIDs so either works for them, but do not rely
// on tags for case-sensitive values.

const STATUS = {
  DEBUG: 'debug',
  INFO: 'info',
  NOTICE: 'info',
  WARNING: 'warn',
  ERROR: 'error',
  CRITICAL: 'error',
  ALERT: 'error',
  EMERGENCY: 'error',
};

// Cloud Build prefixes every line with its own step marker. The step is already
// a structured attribute, so leaving it in the message just makes the log
// column noisy and harder to read.
const STEP_PREFIX = /^Step #\d+(?: - "[^"]*")?: ?/;

/**
 * @param line   a parsed log line from source.js
 * @param opts   { env, service } — env shows up as a Datadog env tag
 */
function toDatadogLog(line, { env, service = 'cloudbuild' } = {}) {
  const jobId = line.step === undefined ? undefined : `${line.buildId}-step-${line.step}`;

  const tags = [`cloudbuild.project:${line.projectId}`];
  if (env) tags.push(`env:${env}`);

  return {
    ddsource: 'cloudbuild',
    ddtags: tags.join(','),
    service,
    hostname: line.projectId,
    // Read by Datadog's default date remapper, so lines keep build order rather
    // than collapsing onto ingestion time.
    timestamp: line.timestamp,
    status: STATUS[line.severity] || 'info',
    message: (line.message || '').replace(STEP_PREFIX, ''),
    ci: {
      pipeline: { id: line.buildId },
      ...(jobId ? { job: { id: jobId } } : {}),
    },
    cloudbuild: {
      build_id: line.buildId,
      project: line.projectId,
      ...(line.step === undefined ? {} : { step: line.step }),
    },
  };
}

// The intake accepts up to 1000 events and 5 MB per request. Cloud Build is
// chatty (every docker layer is a line), so batching is not optional.
const MAX_BATCH = 1000;

function batch(logs, size = MAX_BATCH) {
  const out = [];
  for (let i = 0; i < logs.length; i += size) out.push(logs.slice(i, i + size));
  return out;
}

module.exports = { toDatadogLog, batch, MAX_BATCH };
