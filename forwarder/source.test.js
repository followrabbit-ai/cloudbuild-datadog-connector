'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage } = require('./source');

// Shapes below are trimmed from real messages, not invented.

test('cloud-builds payload resolves to a build ref', () => {
  const ref = parseMessage({
    id: '421bead7-5da3-449f-8a5a-d4e8a734edfc',
    projectId: 'example-ci-project',
    status: 'SUCCESS',
  });
  assert.equal(ref.kind, 'build');
  // No location in the payload -> global, which is where builds.get looks.
  assert.equal(
    ref.name,
    'projects/example-ci-project/locations/global/builds/421bead7-5da3-449f-8a5a-d4e8a734edfc'
  );
});

test('cloud-builds payload keeps the region of a regional build', () => {
  const ref = parseMessage({
    id: '21929dbc',
    projectId: 'example-ci-project',
    name: 'projects/123456789012/locations/europe-west3/builds/21929dbc',
  });
  // Regional builds 404 on builds.get unless the location is carried through.
  assert.match(ref.name, /locations\/europe-west3\//);
});

test('audit log completion resolves to a build ref with its region', () => {
  const ref = parseMessage({
    logName: 'projects/example-ci-project/logs/cloudaudit.googleapis.com%2Factivity',
    operation: { last: true, id: 'operations/build/example-ci-project/x' },
    resource: {
      labels: { build_id: '1d9b8e5b', project_id: 'example-ci-project' },
    },
    protoPayload: {
      serviceName: 'cloudbuild.googleapis.com',
      resourceLocation: { currentLocations: ['europe-west3'] },
    },
  });
  assert.equal(ref.kind, 'build');
  assert.equal(ref.projectId, 'example-ci-project');
  assert.match(ref.name, /locations\/europe-west3\/builds\/1d9b8e5b$/);
});

test('audit log start is ignored so builds are not forwarded twice', () => {
  const start = {
    logName: 'projects/p/logs/cloudaudit.googleapis.com%2Factivity',
    operation: { first: true },
    resource: { labels: { build_id: 'b', project_id: 'p' } },
    protoPayload: { serviceName: 'cloudbuild.googleapis.com' },
  };
  assert.equal(parseMessage(start), null);

  // Neither first nor last (a progress entry) is also not a completion.
  assert.equal(parseMessage({ ...start, operation: {} }), null);
});

test('build step log resolves to a log line with its step index', () => {
  const line = parseMessage({
    logName: 'projects/example-ci-project/logs/cloudbuild',
    resource: {
      labels: { build_id: 'aa84ae58', project_id: 'example-ci-project' },
    },
    labels: { build_step: 'Step #0 - "install"' },
    textPayload: 'Step #0 - "install": c3cc7b6f0473: Pull complete',
    severity: 'INFO',
    timestamp: '2026-08-12T05:00:00Z',
  });
  assert.equal(line.kind, 'log');
  assert.equal(line.buildId, 'aa84ae58');
  assert.equal(line.step, 0);
  assert.match(line.message, /Pull complete/);
});

test('double-digit step indexes parse correctly', () => {
  const line = parseMessage({
    logName: 'projects/p/logs/cloudbuild',
    resource: { labels: { build_id: 'b', project_id: 'p' } },
    labels: { build_step: 'Step #12 - "deploy"' },
    textPayload: 'x',
  });
  assert.equal(line.step, 12);
});

test('build-level log lines carry no step', () => {
  // "starting build", "Fetching storage object", etc. have no build_step label.
  const line = parseMessage({
    logName: 'projects/p/logs/cloudbuild',
    resource: { labels: { build_id: 'b', project_id: 'p' } },
    textPayload: 'starting build "b"',
  });
  assert.equal(line.kind, 'log');
  assert.equal(line.step, undefined);
});

test('unrelated messages are ignored rather than mis-parsed', () => {
  assert.equal(parseMessage({}), null);
  assert.equal(
    parseMessage({
      logName: 'projects/p/logs/cloudaudit.googleapis.com%2Factivity',
      operation: { last: true },
      resource: { labels: {} },
      protoPayload: { serviceName: 'compute.googleapis.com' },
    }),
    null
  );
  // An audit completion with no build id cannot be fetched.
  assert.equal(
    parseMessage({
      logName: 'projects/p/logs/cloudaudit.googleapis.com%2Factivity',
      operation: { last: true },
      resource: { labels: { project_id: 'p' } },
      protoPayload: { serviceName: 'cloudbuild.googleapis.com' },
    }),
    null
  );
});
