'use strict';

const functions = require('@google-cloud/functions-framework');
const { CloudBuildClient } = require('@google-cloud/cloudbuild');
const { buildToEvents } = require('./map');
const { parseMessage } = require('./source');
const { toDatadogLog, batch } = require('./logs');

// Raw fetch rather than @datadog/datadog-api-client: the SDK's value here would
// be typing a body whose schema map.js already pins, and it cannot express the
// single-or-array `data` union without a fight. Node 20 has global fetch.
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_API_KEY = process.env.DD_API_KEY;
const DD_ENV = process.env.DD_ENV;
const DD_SERVICE = process.env.DD_SERVICE || 'cloudbuild';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Independent of the sink filter on purpose: a mis-scoped filter would
// otherwise start billing Log Management for every container layer Cloud Build
// prints, with nothing on this side to stop it.
const FORWARD_LOGS = process.env.FORWARD_LOGS === 'true';

const cloudBuild = new CloudBuildClient();

// A push can fan out several messages for one commit. Instances are short
// lived, so a plain Map is enough.
// ponytail: unbounded, bounded in practice by instance lifetime. Swap for an
// LRU if one instance ever sees enough distinct commits to matter.
const commitCache = new Map();

/**
 * Datadog will not accept a `git` block without author_email, and the Cloud
 * Build resource carries no author anywhere — not in source, sourceProvenance
 * or substitutions. Only GitHub can supply it. Without a token the commit
 * context still ships as tags; only author attribution is lost.
 */
async function commitInfo(build) {
  const repo = build.substitutions?.REPO_FULL_NAME;
  const sha = build.substitutions?.COMMIT_SHA;
  if (!GITHUB_TOKEN || !repo || !sha) return undefined;

  const key = `${repo}@${sha}`;
  if (commitCache.has(key)) return commitCache.get(key);

  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    console.warn(`GitHub commit lookup failed (${res.status}) for ${key}`);
    commitCache.set(key, undefined);
    return undefined;
  }

  const { commit } = await res.json();
  const info = {
    authorEmail: commit?.author?.email,
    authorName: commit?.author?.name,
    committerEmail: commit?.committer?.email,
    committerName: commit?.committer?.name,
    commitTime: commit?.author?.date,
    message: commit?.message?.split('\n')[0],
  };
  commitCache.set(key, info);
  return info;
}

/**
 * Failures no amount of retrying can fix: a payload Datadog rejects (400 — most
 * often "end cannot be older than 18 hours") or one too large (413).
 *
 * Auth (401/403), rate limits (429) and 5xx are deliberately absent: those are
 * worth retrying, and if they persist the dead letter queue is the signal we
 * want. Parking unfixable messages instead leaves the queue permanently
 * non-empty, which keeps an oldest-unacked-age alert firing forever and trains
 * people to ignore it.
 */
const PERMANENT_STATUSES = new Set([400, 413]);

class PermanentFailure extends Error {}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'DD-API-KEY': DD_API_KEY },
    body: JSON.stringify(body),
  });
  if (res.ok) return;

  const detail = `Datadog ${res.status}: ${await res.text()}`;
  if (PERMANENT_STATUSES.has(res.status)) throw new PermanentFailure(detail);
  throw new Error(detail);
}

const sendPipelineEvents = (events) =>
  post(`https://api.${DD_SITE}/api/v2/ci/pipeline`, {
    data: events.map((resource) => ({
      type: 'cipipeline_resource_request',
      attributes: { provider_name: 'cloudbuild', resource },
    })),
  });

const sendLogs = (logs) =>
  post(`https://http-intake.logs.${DD_SITE}/api/v2/logs`, logs);

async function forwardBuild(ref) {
  let build;
  try {
    [build] = await cloudBuild.getBuild({
      name: ref.name,
      projectId: ref.projectId,
      id: ref.id,
    });
  } catch (err) {
    // 5 = NOT_FOUND. The build does not exist and never will.
    if (err.code === 5) throw new PermanentFailure(`build not found: ${err.message}`);
    throw err;
  }

  const events = buildToEvents(build, { commit: await commitInfo(build) });
  if (events.length === 0) {
    // Not a finished build: nothing Datadog's finished-event schema can express.
    return null;
  }

  await sendPipelineEvents(events);
  return `build ${build.id} (${build.status}) as ${events.length} events`;
}

async function forwardLog(line) {
  const log = toDatadogLog(line, { env: DD_ENV, service: DD_SERVICE });
  for (const chunk of batch([log])) await sendLogs(chunk);
  return null; // Too chatty to log one line per line.
}

// Invoked by a Pub/Sub push subscription. Any throw becomes a 500, which
// Pub/Sub retries and eventually dead-letters — deliberate, so a transient
// failure is never silently acked and lost.
functions.http('forwardBuild', async (req, res) => {
  const encoded = req.body?.message?.data;
  if (!encoded) {
    console.warn('Push request without message.data — ignoring');
    res.status(204).send();
    return;
  }

  let message;
  try {
    message = JSON.parse(Buffer.from(encoded, 'base64').toString());
  } catch {
    // Unparseable will stay unparseable.
    console.error('Message data is not JSON — dropping');
    res.status(204).send();
    return;
  }

  const parsed = parseMessage(message);
  if (!parsed || (parsed.kind === 'log' && !FORWARD_LOGS)) {
    // A build starting, a non-terminal transition, a log stream we do not
    // handle, or logs arriving while log forwarding is off. Ack: redelivering
    // will not change the verdict.
    res.status(204).send();
    return;
  }

  try {
    const summary =
      parsed.kind === 'build' ? await forwardBuild(parsed) : await forwardLog(parsed);
    if (summary) console.log(`Forwarded ${summary}`);
    res.status(204).send();
  } catch (err) {
    if (!(err instanceof PermanentFailure)) throw err;
    console.error(
      `Dropping ${parsed.kind} ${parsed.id || parsed.buildId} permanently: ${err.message}`
    );
    res.status(204).send();
  }
});
