# Cloud Build → Datadog CI Visibility connector

Google Cloud Build is not a Datadog-supported CI provider. This connector makes
your builds show up in Datadog CI Visibility as proper pipeline traces —
pipeline → stage → job, with failure reasons, git context and optional build
logs.

No changes to your `cloudbuild.yaml` files.

```
                  ┌─ single project ─────────────────────────────┐
                  │  cloud-builds topic                          │
                  └──────────────┬───────────────────────────────┘
                                 │
                  ┌─ organization ▼──────────────────────────────┐
                  │  org log sink → one topic (all projects)     │
                  └──────────────┬───────────────────────────────┘
                                 │
                        push subscription
                                 │
                        ┌────────▼────────┐
                        │  Cloud Function │──► builds.get (authoritative Build)
                        └────────┬────────┘
                                 │
                    POST /api/v2/ci/pipeline  (+ logs intake)
```

## Why this exists

Datadog natively supports AWS CodePipeline, Azure Pipelines, Buildkite,
CircleCI, Codefresh, GitHub Actions, GitLab, Jenkins and TeamCity. Cloud Build
is not on that list, and as of writing:

- there is no `integrations/google-cloud-build` documentation page
- `datadog-ci` detects 15 providers; Cloud Build is not one of them, so its
  `tag` and `measure` commands cannot attach to a Cloud Build run
- searching GitHub for `api/v2/ci/pipeline` returns only Datadog's own repos

The only supported route is Datadog's [custom pipeline
API](https://docs.datadoghq.com/continuous_integration/pipelines/custom/), where
you construct the events yourself. That is what this does.

## What you get

| Datadog level | From |
|---|---|
| pipeline | the build — duration, status, `queue_time` from create→start |
| stage | the build's `timing` phases: FETCHSOURCE, SETUPBUILD, BUILD, PUSH |
| job | each entry in `steps[]`, parented to the BUILD stage, with `waitFor` dependencies |

Attributes on every event:

| Attribute | Source | Needs a GitHub token? |
|---|---|---|
| `@ci.pipeline.name` | `TRIGGER_NAME`, else `deploy/<service>` for untriggered builds | no |
| `@git.branch`, `@git.commit.sha` | build substitutions | no |
| `@pr.number`, `@pr.base_branch` | build substitutions | no |
| `@cloudbuild.trigger`, `.config`, `.region`, `.failure_type`, `.build_id` | the build | no |
| `@error.domain`, `.type`, `.message` | `failureInfo`, on the pipeline, the failing phase and the failing step | no |
| `@git.commit.author.*`, commit message | GitHub API | **yes** |

Datadog promotes dotted tag keys into its own namespaces, which is why branch,
commit and PR work without a `git` block. The **author** is the exception: it
appears nowhere in the Cloud Build resource — not in `source`,
`sourceProvenance` or `substitutions` — and Datadog refuses a `git` block that
lacks `author_email`. Set `github_token_secret_id` to fill it in.

## Choosing a mode

### Organization-wide (recommended)

Cloud Build publishes to a `cloud-builds` topic **per project**, with no
org-wide equivalent — watching everything that way means a subscription in
every project, forever, including projects that do not exist yet.

Cloud Build also writes an audit log entry per build, and audit logs *can* be
aggregated by a single organization sink. Builds are reported as a long-running
operation: `operation.first` when one starts, `operation.last` when it finishes.
Filtering on the latter yields exactly one event per finished build.

Measured against `gcloud builds list` over a 72-hour window in a busy project:
**166 builds, 166 completions, 0 missing** — SUCCESS, FAILURE and CANCELLED,
global and regional, triggered and untriggered.

The connector does not depend on what the log entry contains beyond
`project_id`, `build_id` and location; it then reads the authoritative Build via
`builds.get`. So step timings and statuses are identical in both modes.

See [`examples/organization`](examples/organization).

### Single project

Subscribe to one project's `cloud-builds` topic. No organization permissions
needed, but it only sees that project.

See [`examples/single-project`](examples/single-project).

## Quick start

```hcl
module "connector" {
  source = "github.com/followrabbit-ai/cloudbuild-datadog-connector//modules/connector"

  project_id                = "my-ci-project"
  topic_id                  = data.google_pubsub_topic.cloud_builds.id
  datadog_api_key_secret_id = "datadog-api-key"
  datadog_site              = "datadoghq.eu"   # your site
}
```

Create the secret's value out of band — the module never takes the key as a
variable, because that would write it into Terraform state:

```bash
printf '%s' "$DD_API_KEY" | \
  gcloud secrets versions add datadog-api-key --project=my-ci-project --data-file=-
```

### Modules

| Module | Purpose |
|---|---|
| [`modules/connector`](modules/connector) | The forwarder: function, push subscription, dead letter queue, IAM. Needs only the `google` provider. |
| [`modules/org-log-sink`](modules/org-log-sink) | Organization sink + aggregation topic. |
| [`modules/monitors`](modules/monitors) | Optional Datadog monitors. Separate so the core needs no Datadog provider. |

## Build logs

Off by default. Enable `include_build_logs` on the sink and `forward_logs` on
the connector to ship Cloud Build step output to Datadog Log Management,
correlated to the pipeline and the exact job via `ci.pipeline.id` / `ci.job.id`.

**Cloud Build logs a line per container layer.** Organization-wide this can be a
large Log Management bill. Narrow it first:

```hcl
include_build_logs      = true
build_logs_filter_extra = "AND severity>=WARNING"
```

Note that Datadog documents automatic CI job-log correlation only for the
providers it integrates with natively. This connector attaches the same
attributes those integrations produce, which is the best available route for a
custom provider, but in-product correlation behaviour is not contractual —
filtering logs by `@ci.pipeline.id` always works regardless.

## Limits worth knowing

These are properties of the platforms, all found by running this in anger:

- **Datadog rejects events older than 18 hours** (`timestamp attribute "end"
  cannot be older than 18 hours from the current time`). There is no backfill,
  and a message stuck in retry past 18h can never be ingested afterwards.
- **Ingestion deduplicates on `unique_id`.** Re-sending a build Datadog has
  already seen does not update it. When testing a mapping change, use a build id
  that has never been forwarded, or you will read the old payload and conclude
  your change did nothing.
- **Events land at the build's timestamp, not at ingest time.** A replayed build
  will not appear in a `now-1h` window.
- **`builds.get` by project + id only finds global builds.** Regional builds need
  the full `projects/../locations/../builds/..` name. Both input paths carry it.
- **`ddtags` are lowercased; attributes are not.** Query identifiers as
  attributes.
- **The dead letter queue is meant to be empty.** Permanently unfixable messages
  (Datadog 400/413, `NOT_FOUND` builds) are acked and logged rather than parked,
  so anything that *does* land there is a transient failure worth investigating.
  Auth failures, rate limits and 5xx are deliberately still retried and parked.

## Verifying

```bash
gcloud functions logs read cloudbuild-datadog-connector \
  --project=<project> --region=<region> --gen2 --limit=20
# Forwarded build <id> (SUCCESS) as 7 events

# Should normally be empty
gcloud pubsub subscriptions pull cloudbuild-datadog-connector-dlq \
  --project=<project> --limit=5
```

Then filter to `@ci.provider.name:cloudbuild` in Datadog under
**Software Delivery → CI Visibility → Pipelines**.

## Development

```bash
cd forwarder && npm install && node --test
terraform fmt -recursive && terraform -chdir=modules/connector validate
```

The forwarder is split so the logic worth testing is pure:

| File | Responsibility |
|---|---|
| `source.js` | normalise the three accepted Pub/Sub payload shapes |
| `map.js` | Build → Datadog pipeline/stage/job events |
| `logs.js` | Cloud Build log line → Datadog log event |
| `index.js` | I/O: fetch the build, call Datadog, decide retry vs ack |

Tests use fixtures trimmed from real builds. One of them exists because
`@google-cloud/cloudbuild` returns protobuf `Timestamp` objects while
`gcloud builds describe --format=json` renders the same fields as RFC3339
strings — a fixture built from the CLI passes while every real message is
rejected. If you add a fixture, take it from the client, not the CLI.

## License

Apache 2.0.
