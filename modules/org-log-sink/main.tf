terraform {
  required_version = ">= 1.3"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

# Cloud Build publishes build notifications to a `cloud-builds` Pub/Sub topic in
# each project. There is no organization-wide equivalent, so watching every
# project that way means creating a subscription in every project, forever,
# including ones that do not exist yet.
#
# Cloud Build also writes an audit log entry per build, and audit logs *can* be
# aggregated org-wide by a single sink. Builds are reported as a long-running
# operation: `operation.first` when one starts, `operation.last` when it
# finishes. Filtering on the latter yields exactly one event per finished build.
#
# Measured against `gcloud builds list` over a 72h window in a busy project:
# 166 builds, 166 completions, 0 missing — SUCCESS, FAILURE and CANCELLED, both
# global and regional, triggered and untriggered.
#
# The entry carries project_id, build_id and the build's location, which is all
# the connector needs; it then reads the authoritative Build via builds.get.
locals {
  builds_filter = <<-EOT
    logName:"/logs/cloudaudit.googleapis.com%2Factivity"
    AND protoPayload.serviceName="cloudbuild.googleapis.com"
    AND resource.type="build"
    AND operation.last=true
  EOT

  # Cloud Build emits a line per container layer, so this is high volume and
  # bills as Log Management. Narrow it with var.build_logs_filter_extra before
  # turning it on organization-wide.
  logs_filter = <<-EOT
    logName:"/logs/cloudbuild"
    AND resource.type="build"
    ${var.build_logs_filter_extra}
  EOT

  filter = var.include_build_logs ? "(${local.builds_filter}) OR (${local.logs_filter})" : local.builds_filter
}

resource "google_pubsub_topic" "builds" {
  name    = var.topic_name
  project = var.project_id
}

resource "google_logging_organization_sink" "builds" {
  name             = var.sink_name
  org_id           = var.organization_id
  include_children = true
  destination      = "pubsub.googleapis.com/projects/${var.project_id}/topics/${google_pubsub_topic.builds.name}"
  filter           = local.filter
}

# The sink writes as its own generated identity, which must be able to publish.
resource "google_pubsub_topic_iam_member" "sink_writer" {
  project = var.project_id
  topic   = google_pubsub_topic.builds.name
  role    = "roles/pubsub.publisher"
  member  = google_logging_organization_sink.builds.writer_identity
}
