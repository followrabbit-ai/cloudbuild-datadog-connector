'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toDatadogLog, batch } = require('./logs');

const LINE = {
  kind: 'log',
  projectId: 'example-ci-project',
  buildId: 'aa84ae58-5a51-453d-81ff-9c993289f5d7',
  step: 0,
  message: 'Step #0 - "install": c3cc7b6f0473: Pull complete',
  severity: 'INFO',
  timestamp: '2026-08-12T05:00:00Z',
};

test('a step log correlates to the job id map.js assigns', () => {
  const log = toDatadogLog(LINE, { env: 'dev' });

  // These two must match map.js exactly or the log points at nothing.
  assert.equal(log.ci.pipeline.id, LINE.buildId);
  assert.equal(log.ci.job.id, `${LINE.buildId}-step-0`);

  assert.equal(log.ddsource, 'cloudbuild');
  assert.equal(log.status, 'info');
  assert.equal(log.timestamp, LINE.timestamp);
  assert.ok(log.ddtags.includes('env:dev'));
  assert.ok(log.ddtags.includes('cloudbuild.project:example-ci-project'));
});

test('the redundant step prefix is stripped from the message', () => {
  // The step is already a structured attribute; repeating it in every line
  // makes the log column unreadable.
  assert.equal(toDatadogLog(LINE).message, 'c3cc7b6f0473: Pull complete');
  assert.equal(
    toDatadogLog({ ...LINE, message: 'Step #3: plain form' }).message,
    'plain form'
  );
  // A line that merely mentions a step must not be mangled.
  assert.equal(
    toDatadogLog({ ...LINE, message: 'ran Step #3 earlier' }).message,
    'ran Step #3 earlier'
  );
});

test('build-level lines correlate to the pipeline but no job', () => {
  const log = toDatadogLog({ ...LINE, step: undefined, message: 'starting build' });
  assert.equal(log.ci.pipeline.id, LINE.buildId);
  assert.equal(log.ci.job, undefined);
  assert.equal(log.cloudbuild.step, undefined);
});

test('severity maps onto Datadog status, defaulting safely', () => {
  assert.equal(toDatadogLog({ ...LINE, severity: 'ERROR' }).status, 'error');
  assert.equal(toDatadogLog({ ...LINE, severity: 'WARNING' }).status, 'warn');
  assert.equal(toDatadogLog({ ...LINE, severity: undefined }).status, 'info');
  assert.equal(toDatadogLog({ ...LINE, severity: 'WEIRD' }).status, 'info');
});

test('batching respects the intake limit', () => {
  const many = Array.from({ length: 2500 }, () => LINE);
  const batches = batch(many);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 1000);
  assert.equal(batches[2].length, 500);
  assert.equal(batch([]).length, 0);
});
