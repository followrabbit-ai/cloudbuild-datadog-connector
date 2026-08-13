terraform {
  required_version = ">= 1.3"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

data "google_project" "host" {
  project_id = var.project_id
}

locals {
  pubsub_agent = "serviceAccount:service-${data.google_project.host.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# --- source ------------------------------------------------------------------

data "archive_file" "src" {
  type             = "zip"
  source_dir       = "${path.module}/../../forwarder"
  output_file_mode = "0666"
  output_path      = "${path.module}/forwarder.zip"
  excludes         = ["node_modules", "map.test.js", "source.test.js", "logs.test.js"]
}

resource "google_storage_bucket" "src" {
  name                        = "${var.project_id}-${var.name}-src"
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_storage_bucket_object" "src" {
  # The hash is in the name so a source change produces a new object and
  # therefore a new function revision. A fixed name leaves the function on
  # stale code while Terraform reports success.
  name   = "forwarder-${data.archive_file.src.output_md5}.zip"
  bucket = google_storage_bucket.src.name
  source = data.archive_file.src.output_path
}

# --- identity ----------------------------------------------------------------

resource "google_service_account" "forwarder" {
  account_id   = substr("${var.name}-fwd", 0, 30)
  display_name = "Cloud Build -> Datadog connector"
  project      = var.project_id
}

resource "google_secret_manager_secret_iam_member" "datadog_key" {
  project   = var.project_id
  secret_id = var.datadog_api_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.forwarder.email}"
}

resource "google_secret_manager_secret_iam_member" "github_token" {
  count     = var.github_token_secret_id == "" ? 0 : 1
  project   = var.project_id
  secret_id = var.github_token_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.forwarder.email}"
}

# NOTE: the connector needs roles/cloudbuild.builds.viewer on every project
# whose builds it reads. For a single project that is granted below. For an
# organization-wide deployment it must be granted at the org or folder node,
# which this module deliberately does not do — org-level IAM should be explicit
# in the caller. See examples/organization.
resource "google_project_iam_member" "builds_viewer" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.viewer"
  member  = "serviceAccount:${google_service_account.forwarder.email}"
}

# --- function ----------------------------------------------------------------

resource "google_cloudfunctions2_function" "forwarder" {
  name     = var.name
  location = var.region
  project  = var.project_id

  build_config {
    runtime     = "nodejs20"
    entry_point = "forwardBuild"

    source {
      storage_source {
        bucket = google_storage_bucket.src.name
        object = google_storage_bucket_object.src.name
      }
    }
  }

  service_config {
    max_instance_count    = var.max_instance_count
    available_memory      = "256M"
    timeout_seconds       = 60
    service_account_email = google_service_account.forwarder.email
    ingress_settings      = "ALLOW_ALL"

    environment_variables = {
      DD_SITE      = var.datadog_site
      DD_ENV       = var.env
      DD_SERVICE   = var.service
      FORWARD_LOGS = tostring(var.forward_logs)
    }

    secret_environment_variables {
      key        = "DD_API_KEY"
      project_id = var.project_id
      secret     = var.datadog_api_key_secret_id
      version    = "latest"
    }

    dynamic "secret_environment_variables" {
      for_each = var.github_token_secret_id == "" ? [] : [var.github_token_secret_id]
      content {
        key        = "GITHUB_TOKEN"
        project_id = var.project_id
        secret     = secret_environment_variables.value
        version    = "latest"
      }
    }
  }
}

# --- delivery ----------------------------------------------------------------

# A push subscription rather than an Eventarc event trigger: it makes the dead
# letter policy explicit, and it works with a topic in another project.
resource "google_service_account" "pusher" {
  account_id   = substr("${var.name}-push", 0, 30)
  display_name = "Pub/Sub push identity for the Cloud Build -> Datadog connector"
  project      = var.project_id
}

resource "google_cloud_run_service_iam_member" "pusher_invoker" {
  project  = var.project_id
  location = google_cloudfunctions2_function.forwarder.location
  service  = google_cloudfunctions2_function.forwarder.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pusher.email}"
}

# Pub/Sub mints the OIDC token as the push identity, so its service agent must
# be able to impersonate it.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pusher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}

resource "google_pubsub_topic" "dead_letter" {
  name    = "${var.name}-dlq"
  project = var.project_id
}

# A dead letter topic with no subscription silently discards everything it
# receives. This is what actually retains parked messages for inspection.
resource "google_pubsub_subscription" "dead_letter" {
  name                       = "${var.name}-dlq"
  topic                      = google_pubsub_topic.dead_letter.id
  project                    = var.project_id
  message_retention_duration = "604800s"
}

resource "google_pubsub_subscription" "forwarder" {
  name    = var.name
  topic   = var.topic_id
  project = var.project_id

  ack_deadline_seconds = 60

  push_config {
    push_endpoint = google_cloudfunctions2_function.forwarder.service_config[0].uri

    oidc_token {
      service_account_email = google_service_account.pusher.email
      audience              = google_cloudfunctions2_function.forwarder.service_config[0].uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  depends_on = [google_cloud_run_service_iam_member.pusher_invoker]
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.forwarder.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
