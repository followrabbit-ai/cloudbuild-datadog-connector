'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildToEvents } = require('./map');

// Trimmed from a real build: example-ci-project / 421bead7-5da3-449f-8a5a-d4e8a734edfc
const SUCCESS_BUILD = {
  id: '421bead7-5da3-449f-8a5a-d4e8a734edfc',
  projectId: 'example-ci-project',
  status: 'SUCCESS',
  createTime: '2026-08-11T13:04:45.000000Z',
  startTime: '2026-08-11T13:04:50.009189522Z',
  finishTime: '2026-08-11T13:12:14.615713599Z',
  logUrl: 'https://console.cloud.google.com/cloud-build/builds/421bead7',
  buildTriggerId: '0203679f-1651-4893-ac96-992420dda6c7',
  source: { gitSource: { url: 'https://github.com/example-org/example-repo.git' } },
  substitutions: {
    BRANCH_NAME: 'develop',
    COMMIT_SHA: 'fccb2745b0a31b6470c6f27c27906fc8f32638fc',
    REPO_FULL_NAME: 'example-org/example-repo',
    TRIGGER_NAME: 'backend-pr',
    TRIGGER_BUILD_CONFIG_PATH: 'backend/cloudbuild-pr.yaml',
    _PR_NUMBER: '8221',
    _HEAD_REPO_URL: 'https://github.com/example-org/example-repo',
  },
  timing: {
    FETCHSOURCE: {
      startTime: '2026-08-11T13:04:50.009189522Z',
      endTime: '2026-08-11T13:04:54.291814187Z',
    },
    // Identical span to FETCHSOURCE — must not become a stage.
    GIT_SOURCE: {
      startTime: '2026-08-11T13:04:50.009189522Z',
      endTime: '2026-08-11T13:04:54.291814187Z',
    },
    SETUPBUILD: {
      startTime: '2026-08-11T13:04:54.291814187Z',
      endTime: '2026-08-11T13:04:55.042000000Z',
    },
    BUILD: {
      startTime: '2026-08-11T13:04:55.043007508Z',
      endTime: '2026-08-11T13:12:14.615713599Z',
    },
  },
  steps: [
    {
      name: 'docker/compose',
      status: 'SUCCESS',
      timing: {
        startTime: '2026-08-11T13:04:55.797729001Z',
        endTime: '2026-08-11T13:05:18.250568144Z',
      },
    },
    {
      name: 'eclipse-temurin:17-jdk-jammy',
      status: 'SUCCESS',
      timing: {
        startTime: '2026-08-11T13:05:18.250698631Z',
        endTime: '2026-08-11T13:12:11.120907233Z',
      },
    },
    {
      name: 'docker/compose',
      status: 'SUCCESS',
      timing: {
        startTime: '2026-08-11T13:12:11.121271496Z',
        endTime: '2026-08-11T13:12:14.615600024Z',
      },
    },
  ],
};

const byLevel = (events, level) => events.filter((e) => e.level === level);

test('success build maps to pipeline + stages + one job per step', () => {
  const events = buildToEvents(SUCCESS_BUILD);

  const pipelines = byLevel(events, 'pipeline');
  assert.equal(pipelines.length, 1);
  assert.equal(pipelines[0].unique_id, SUCCESS_BUILD.id);
  assert.equal(pipelines[0].name, 'backend-pr');
  assert.equal(pipelines[0].status, 'success');
  assert.equal(pipelines[0].partial_retry, false);
  // createTime -> startTime, in milliseconds.
  assert.equal(pipelines[0].queue_time, 5009);

  // GIT_SOURCE duplicates FETCHSOURCE and must be dropped.
  const stageNames = byLevel(events, 'stage').map((s) => s.name);
  assert.deepEqual(stageNames, ['FETCHSOURCE', 'SETUPBUILD', 'BUILD']);

  const jobs = byLevel(events, 'job');
  assert.equal(jobs.length, 3);
  // Same image used twice: names must still be distinct and stable.
  assert.deepEqual(
    jobs.map((j) => j.name),
    ['0: docker/compose', '1: eclipse-temurin:17-jdk-jammy', '2: docker/compose']
  );
  assert.equal(new Set(jobs.map((j) => j.id)).size, 3);
  // Jobs hang off the BUILD stage, which must be a stage we actually emitted.
  assert.ok(jobs.every((j) => j.stage_id === `${SUCCESS_BUILD.id}-BUILD`));
  assert.ok(byLevel(events, 'stage').some((s) => s.id === jobs[0].stage_id));

  // Every event must carry the parent linkage Datadog requires.
  for (const e of events.filter((x) => x.level !== 'pipeline')) {
    assert.equal(e.pipeline_unique_id, SUCCESS_BUILD.id);
    assert.equal(e.pipeline_name, 'backend-pr');
  }
});

test('commit context ships as tags, and git is omitted without an author email', () => {
  const events = buildToEvents(SUCCESS_BUILD);
  const pipeline = byLevel(events, 'pipeline')[0];

  assert.ok(pipeline.tags.includes('git.branch:develop'));
  assert.ok(pipeline.tags.includes('pr.number:8221'));
  assert.ok(pipeline.tags.includes('git.repository:example-org/example-repo'));
  // Datadog rejects a git block without author_email — omit rather than fake it.
  assert.equal(pipeline.git, undefined);
});

test('git block is emitted once a commit author is resolved', () => {
  const events = buildToEvents(SUCCESS_BUILD, {
    commit: {
      authorEmail: 'dev@example.com',
      authorName: 'Dev Eloper',
      message: 'fix: something',
      commitTime: '2026-08-11T13:00:00Z',
    },
  });
  const { git } = byLevel(events, 'pipeline')[0];

  assert.equal(git.author_email, 'dev@example.com');
  assert.equal(git.author_name, 'Dev Eloper');
  assert.equal(git.message, 'fix: something');
  assert.equal(git.sha, SUCCESS_BUILD.substitutions.COMMIT_SHA);
  assert.equal(git.branch, 'develop');
  assert.ok(git.repository_url);
});

test('failure attributes the error to the last phase and skips steps that never ran', () => {
  const failed = {
    ...SUCCESS_BUILD,
    status: 'FAILURE',
    steps: [
      SUCCESS_BUILD.steps[0],
      { name: 'never-ran' }, // no status, no timing
    ],
  };
  const events = buildToEvents(failed);

  assert.equal(byLevel(events, 'pipeline')[0].status, 'error');

  const stages = byLevel(events, 'stage');
  assert.deepEqual(
    stages.map((s) => [s.name, s.status]),
    [['FETCHSOURCE', 'success'], ['SETUPBUILD', 'success'], ['BUILD', 'error']]
  );

  const jobs = byLevel(events, 'job');
  assert.equal(jobs[0].status, 'success');
  assert.equal(jobs[1].status, 'skipped');
  // A skipped job still needs the start/end Datadog requires.
  assert.ok(jobs[1].start && jobs[1].end);
});

test('timeouts and cancellations map onto the Datadog enums', () => {
  assert.equal(
    buildToEvents({ ...SUCCESS_BUILD, status: 'TIMEOUT' })[0].status,
    'error'
  );
  assert.equal(
    buildToEvents({ ...SUCCESS_BUILD, status: 'CANCELLED' })[0].status,
    'canceled'
  );
});

// The fixture above uses RFC3339 strings, which is what
// `gcloud builds describe --format=json` renders. The @google-cloud/cloudbuild
// client does NOT: it returns protobuf Timestamps. Sending those raw earned a
// Datadog 400 ("Time.UnmarshalJSON: input is not a JSON string") on the first
// real deploy, so pin both shapes to the same output.
const toProtoTimestamps = (value) => {
  if (Array.isArray(value)) return value.map(toProtoTimestamps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toProtoTimestamps(v)])
    );
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value)) {
    const ms = Date.parse(value);
    return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 };
  }
  return value;
};

test('protobuf Timestamps from the client map identically to RFC3339 strings', () => {
  const fromStrings = buildToEvents(SUCCESS_BUILD);
  const fromProto = buildToEvents(toProtoTimestamps(SUCCESS_BUILD));

  // Millisecond precision only: protobuf carries nanos, RFC3339 in the fixture
  // carries nanos too, but Datadog is fed millisecond-resolution ISO strings.
  const truncate = (events) =>
    events.map((e) => ({
      ...e,
      start: new Date(e.start).toISOString(),
      end: new Date(e.end).toISOString(),
    }));

  assert.deepEqual(truncate(fromProto), truncate(fromStrings));

  // Every timestamp Datadog receives must be a string, at every level.
  for (const e of fromProto) {
    assert.equal(typeof e.start, 'string', `${e.level} start must be a string`);
    assert.equal(typeof e.end, 'string', `${e.level} end must be a string`);
  }
  assert.equal(typeof fromProto[0].queue_time, 'number');
  assert.equal(fromProto[0].queue_time, 5009);
});

test('non-terminal builds produce nothing', () => {
  // Cloud Build publishes an event per state transition; only finished builds
  // satisfy Datadog's finished-event schema, which requires `end`.
  for (const status of ['QUEUED', 'WORKING', 'STATUS_UNKNOWN']) {
    assert.deepEqual(buildToEvents({ ...SUCCESS_BUILD, status }), []);
  }
});

test('untriggered deploy builds get a per-service name, not a shared one', () => {
  // Cloud Functions / Cloud Run deploy builds have no trigger at all. Without a
  // per-service name they all aggregate into one "cloudbuild" pipeline and the
  // duration/failure stats become meaningless.
  const deploy = {
    ...SUCCESS_BUILD,
    buildTriggerId: undefined,
    substitutions: {},
    tags: ['t-function', 'service_cloudbuild-datadog-forwarder'],
  };
  assert.equal(
    buildToEvents(deploy)[0].name,
    'deploy/cloudbuild-datadog-forwarder'
  );

  // Nothing to go on at all -> the generic fallback.
  assert.equal(
    buildToEvents({ ...SUCCESS_BUILD, buildTriggerId: undefined, substitutions: {}, tags: [] })[0].name,
    'cloudbuild'
  );
});

test('failures carry a structured reason on pipeline, stage and job', () => {
  const failed = {
    ...SUCCESS_BUILD,
    status: 'FAILURE',
    failureInfo: {
      type: 'USER_BUILD_STEP',
      detail: 'build step 1 "eclipse-temurin:17-jdk-jammy" failed',
    },
    steps: [
      { ...SUCCESS_BUILD.steps[0], status: 'FAILURE' },
      { name: 'never-ran' },
    ],
  };
  const events = buildToEvents(failed);

  const pipeline = byLevel(events, 'pipeline')[0];
  assert.equal(pipeline.error.domain, 'user');
  assert.equal(pipeline.error.type, 'USER_BUILD_STEP');
  assert.match(pipeline.error.message, /eclipse-temurin/);

  // Only the phase that failed, and only the step that failed.
  const stages = byLevel(events, 'stage');
  assert.ok(stages.find((s) => s.name === 'BUILD').error);
  assert.equal(stages.find((s) => s.name === 'FETCHSOURCE').error, undefined);

  const jobs = byLevel(events, 'job');
  assert.ok(jobs[0].error, 'failed step should carry the reason');
  assert.equal(jobs[1].error, undefined, 'skipped step should not');
});

test('timeouts still get a reason even though failureInfo is absent', () => {
  // Verified against real builds: TIMEOUT/EXPIRED never carry failureInfo, and
  // 5 of 15 sampled FAILUREs had none either.
  const { error } = buildToEvents({ ...SUCCESS_BUILD, status: 'TIMEOUT' })[0];
  assert.equal(error.domain, 'unknown');
  assert.equal(error.type, 'TIMEOUT');
});

test('successful builds carry no error block', () => {
  assert.equal(buildToEvents(SUCCESS_BUILD)[0].error, undefined);
});

test('region and failure type ship as tags', () => {
  const b = {
    ...SUCCESS_BUILD,
    name: 'projects/example-ci-project/locations/europe-west3/builds/abc',
    status: 'FAILURE',
    failureInfo: { type: 'PUSH_FAILED', detail: 'nope' },
  };
  const { tags, error } = buildToEvents(b)[0];
  assert.ok(tags.includes('cloudbuild.region:europe-west3'));
  assert.ok(tags.includes('cloudbuild.failure_type:PUSH_FAILED'));
  assert.equal(error.domain, 'provider');
});
