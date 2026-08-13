'use strict';

// The connector accepts three different Pub/Sub payload shapes, because there
// are two ways to feed it and one of them carries two kinds of message:
//
//   1. Single project  — a subscription on the project's `cloud-builds` topic.
//      The message IS a Build resource.
//
//   2. Organization    — a Cloud Logging sink. Two log streams matter:
//      a) the Cloud Build audit log, where `operation.last = true` marks a
//         finished build. This is the org-wide equivalent of `cloud-builds`.
//      b) the `cloudbuild` platform log, which carries build step output.
//
// Coverage of (2a) was measured against `gcloud builds list` over a 72h window:
// 166 builds, 166 audit completions, 0 missing — across SUCCESS, FAILURE and
// CANCELLED, in both global and regional builds, triggered and untriggered.

const AUDIT_SERVICE = 'cloudbuild.googleapis.com';
const BUILD_LOG_SUFFIX = '/logs/cloudbuild';

// "Step #0 - \"install\"" / "Step #12". Absent on build-level lines like
// "starting build", which then attach to the pipeline rather than a job.
const STEP_LABEL = /^Step #(\d+)/;

/**
 * A finished build to fetch and forward. The full resource name matters:
 * builds.get by projectId + id only searches global, so regional builds 404
 * without it.
 */
function buildRef(projectId, id, location) {
  if (!projectId || !id) return null;
  return {
    kind: 'build',
    projectId,
    id,
    name: `projects/${projectId}/locations/${location || 'global'}/builds/${id}`,
  };
}

/**
 * Normalise any accepted payload into one of:
 *   { kind: 'build', ... }  -> fetch and forward as pipeline/stage/job events
 *   { kind: 'log', ... }    -> forward as a log line
 *   null                    -> ignore (not terminal, or not ours)
 */
function parseMessage(message) {
  // --- Cloud Logging sink ---------------------------------------------------
  if (message.logName) {
    const labels = message.resource?.labels || {};

    if (message.logName.endsWith(BUILD_LOG_SUFFIX)) {
      const stepMatch = STEP_LABEL.exec(message.labels?.build_step || '');
      return {
        kind: 'log',
        projectId: labels.project_id,
        buildId: labels.build_id,
        step: stepMatch ? Number(stepMatch[1]) : undefined,
        message: message.textPayload ?? JSON.stringify(message.jsonPayload ?? ''),
        severity: message.severity,
        timestamp: message.timestamp,
      };
    }

    if (message.protoPayload?.serviceName === AUDIT_SERVICE) {
      // Cloud Build reports builds as a long-running operation: `first` when it
      // starts, `last` when it finishes. Only the finish has a final status.
      // The sink filter should already restrict to this, but a mis-set filter
      // would otherwise double-forward every build.
      if (message.operation?.last !== true) return null;
      return buildRef(
        labels.project_id,
        labels.build_id,
        message.protoPayload.resourceLocation?.currentLocations?.[0]
      );
    }

    return null;
  }

  // --- cloud-builds topic ---------------------------------------------------
  // The message is a Build. It already carries the full resource name, which is
  // how regional builds resolve correctly here.
  if (message.id && message.projectId) {
    const location = /\/locations\/([^/]+)\//.exec(message.name || '')?.[1];
    return buildRef(message.projectId, message.id, location);
  }

  return null;
}

module.exports = { parseMessage };
