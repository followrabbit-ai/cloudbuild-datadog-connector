'use strict';

// Cloud Build is not a Datadog-supported CI provider, so there is no integration
// to install: we map its Build resource onto Datadog's *custom pipeline* schema
// by hand and POST it to /api/v2/ci/pipeline.
//
//   build          -> pipeline
//   timing phases  -> stage    (FETCHSOURCE / SETUPBUILD / BUILD / PUSH)
//   steps[]        -> job      (parented to the BUILD stage)
//
// Field names and required-ness come from CIAppPipelineEvent{Pipeline,Stage,Job}
// in Datadog's v2 OpenAPI spec. Getting a required field wrong is a 400, so keep
// this in sync with the spec rather than with intuition.

// GIT_SOURCE is deliberately not a stage: Cloud Build reports it with
// byte-identical start/end to FETCHSOURCE, so emitting both renders the same
// four seconds twice in the flame graph.
const STAGE_PHASES = ['FETCHSOURCE', 'SETUPBUILD', 'BUILD', 'PUSH'];

// Cloud Build status -> Datadog status. Datadog's pipeline/job enums accept
// success|error|canceled|skipped (pipeline also allows blocked).
const STATUS = {
  SUCCESS: 'success',
  FAILURE: 'error',
  INTERNAL_ERROR: 'error',
  TIMEOUT: 'error',
  EXPIRED: 'error',
  CANCELLED: 'canceled',
};

/**
 * Datadog wants RFC3339 strings. The Cloud Build *client* hands back protobuf
 * Timestamps ({seconds, nanos}) even though `gcloud builds describe --format=json`
 * renders the same fields as strings — sending the raw object gets a 400
 * ("Time.UnmarshalJSON: input is not a JSON string"). Accept both.
 */
function rfc3339(ts) {
  if (!ts) return undefined;
  if (typeof ts === 'string') return ts;
  // seconds arrives as a string or Long for values beyond 2^53.
  const seconds = Number(ts.seconds ?? 0);
  const nanos = Number(ts.nanos ?? 0);
  return new Date(seconds * 1000 + Math.round(nanos / 1e6)).toISOString();
}

const millis = (from, to) => {
  const a = rfc3339(from);
  const b = rfc3339(to);
  return a && b ? Date.parse(b) - Date.parse(a) : undefined;
};

/**
 * Free-form tags. Datadog promotes dotted keys into its own namespaces, so
 * `git.branch:develop` here surfaces as `@git.branch` and `pr.number:8221` as
 * `@pr.number` — verified against real forwarded builds. That is why branch,
 * commit and PR work without the `git` block below.
 */
function tagsFor(build) {
  const s = build.substitutions || {};
  const tags = [
    `cloudbuild.project:${build.projectId}`,
    `cloudbuild.build_id:${build.id}`,
  ];
  // projects/<p>/locations/<region>/builds/<id> — absent on global builds.
  const region = /\/locations\/([^/]+)\//.exec(build.name || '')?.[1];
  const optional = {
    'git.commit.sha': s.COMMIT_SHA,
    'git.branch': s.BRANCH_NAME,
    'git.repository': s.REPO_FULL_NAME,
    'pr.number': s._PR_NUMBER,
    'pr.base_branch': s._BASE_BRANCH,
    'cloudbuild.config': s.TRIGGER_BUILD_CONFIG_PATH,
    'cloudbuild.trigger': s.TRIGGER_NAME,
    'cloudbuild.region': region,
    'cloudbuild.failure_type': build.failureInfo?.type,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) tags.push(`${key}:${value}`);
  }
  return tags;
}

/**
 * The pipeline name is what Datadog aggregates duration and failure rate by, so
 * a bad fallback silently merges unrelated builds into one meaningless series.
 *
 * Across 80 recent dev builds, TRIGGER_NAME and buildTriggerId were always both
 * present or both absent — there is no case where looking the trigger up via
 * the Cloud Build triggers API would add anything, so we do not call it.
 */
function pipelineName(build) {
  const s = build.substitutions || {};
  if (s.TRIGGER_NAME) return s.TRIGGER_NAME;
  if (build.buildTriggerId) return build.buildTriggerId;
  // Untriggered builds are Cloud Functions / Cloud Run deploys. Without this
  // they all collapse into a single "cloudbuild" pipeline. Cloud Build tags
  // them `service_<name>`.
  const service = (build.tags || []).find((t) => t.startsWith('service_'));
  if (service) return `deploy/${service.slice('service_'.length)}`;
  return 'cloudbuild';
}

// Datadog rejects a `git` block that lacks author_email, so omit the block
// entirely rather than send a placeholder that would pollute commit attribution.
// Cloud Build carries no author anywhere, so `commit` has to come from GitHub.
function gitFor(build, commit = {}) {
  const s = build.substitutions || {};
  const url = s._HEAD_REPO_URL || build.source?.gitSource?.url;
  const sha = s.COMMIT_SHA || build.sourceProvenance?.resolvedGitSource?.revision;
  if (!commit.authorEmail || !url || !sha) return undefined;

  const git = { repository_url: url, sha, author_email: commit.authorEmail };
  if (s.BRANCH_NAME) git.branch = s.BRANCH_NAME;
  if (commit.authorName) git.author_name = commit.authorName;
  if (commit.message) git.message = commit.message;
  if (commit.commitTime) git.commit_time = commit.commitTime;
  if (commit.committerEmail) git.committer_email = commit.committerEmail;
  if (commit.committerName) git.committer_name = commit.committerName;
  return git;
}

// Cloud Build FailureType -> Datadog error domain. Anything the build itself
// did wrong is "user"; anything the platform did is "provider".
const ERROR_DOMAIN = {
  USER_BUILD_STEP: 'user',
  FETCH_SOURCE_FAILED: 'provider',
  PUSH_FAILED: 'provider',
  PUSH_IMAGE_NOT_FOUND: 'provider',
  PUSH_NOT_AUTHORIZED: 'provider',
  LOGGING_FAILURE: 'provider',
};

/**
 * Without this a failed pipeline reaches Datadog with a red status and no
 * reason. Note failureInfo is often absent (5 of 15 sampled failed builds), and
 * TIMEOUT/EXPIRED never carry one, so fall back to the build status.
 */
function errorFor(build) {
  const info = build.failureInfo;
  if (!info && build.status === 'SUCCESS') return undefined;
  if (!info) {
    return { domain: 'unknown', type: build.status, message: build.status };
  }
  return {
    domain: ERROR_DOMAIN[info.type] || 'unknown',
    type: info.type || build.status,
    message: info.detail || build.status,
  };
}

/**
 * Convert one Cloud Build Build resource into an array of Datadog CI pipeline
 * events, ready to be sent as the `data` array of a single POST.
 *
 * Returns [] for non-terminal builds (QUEUED/WORKING) — Datadog's finished-event
 * schema requires an `end`, and a running build has none.
 */
function buildToEvents(build, { commit } = {}) {
  const status = STATUS[build.status];
  if (!status) return [];

  const name = pipelineName(build);
  const start = rfc3339(build.startTime || build.createTime);
  const end = rfc3339(build.finishTime);
  const tags = tagsFor(build);
  const git = gitFor(build, commit);
  const error = status === 'success' ? undefined : errorFor(build);

  const pipeline = {
    level: 'pipeline',
    unique_id: build.id, // Cloud Build ids are UUIDs, unique across retries.
    name,
    url: build.logUrl,
    start,
    end,
    status,
    partial_retry: false,
    tags,
  };
  const queueTime = millis(build.createTime, build.startTime);
  if (queueTime !== undefined) pipeline.queue_time = queueTime;
  if (git) pipeline.git = git;
  if (error) pipeline.error = error;

  const events = [pipeline];
  const parent = { pipeline_unique_id: build.id, pipeline_name: name, tags };
  if (git) parent.git = git;

  // Stages. A Cloud Build phase carries no status of its own; a failed build
  // failed *during* its last recorded phase, so only that one inherits the error.
  const timing = build.timing || {};
  const phases = STAGE_PHASES.filter(
    (p) => timing[p]?.startTime && timing[p]?.endTime
  );
  const lastPhase = phases[phases.length - 1];
  for (const phase of phases) {
    const failed = status !== 'success' && phase === lastPhase;
    events.push({
      ...(failed && error ? { error } : {}),
      ...parent,
      level: 'stage',
      id: `${build.id}-${phase}`,
      name: phase,
      start: rfc3339(timing[phase].startTime),
      end: rfc3339(timing[phase].endTime),
      status: status !== 'success' && phase === lastPhase ? status : 'success',
    });
  }

  // Jobs, one per build step, hung off the BUILD stage when it exists.
  const buildStage = timing.BUILD?.startTime
    ? { stage_id: `${build.id}-BUILD`, stage_name: 'BUILD' }
    : {};
  (build.steps || []).forEach((step, i) => {
    // A step with no timing never ran (an earlier step failed first). Report it
    // as skipped, pinned to the build end so the flame graph stays consistent.
    const job = {
      ...parent,
      ...buildStage,
      level: 'job',
      id: `${build.id}-step-${i}`,
      // Step `id` is optional in Cloud Build and unset across this repo's
      // configs, so fall back to the image. Prefix with the index to keep names
      // stable and distinct when the same image is used more than once.
      name: step.id || `${i}: ${step.name}`,
      url: build.logUrl,
      start: rfc3339(step.timing?.startTime) || end,
      end: rfc3339(step.timing?.endTime) || end,
      status: STATUS[step.status] || 'skipped',
    };
    // Attach the reason to the step that actually failed, not to every step.
    if (error && STATUS[step.status] === 'error') job.error = error;
    if (step.waitFor?.length) job.dependencies = step.waitFor;
    events.push(job);
  });

  return events;
}

module.exports = { buildToEvents, STAGE_PHASES, STATUS };
