# Organization-wide: every Cloud Build build in every project under the org,
# including projects that do not exist yet, forwarded by one connector.
#
# Prerequisites you must create yourself:
#   - the host project, with cloudfunctions, run, pubsub, secretmanager and
#     cloudbuild APIs enabled
#   - a Secret Manager secret holding the Datadog API key, with a version:
#       printf '%s' "$DD_API_KEY" | gcloud secrets versions add datadog-api-key \
#         --project=<host> --data-file=-

terraform {
  required_version = ">= 1.3"
}

provider "google" {
  project = var.project_id
}

variable "organization_id" { type = string }
variable "project_id" { type = string }
variable "datadog_site" {
  type    = string
  default = "datadoghq.com"
}

module "sink" {
  source = "github.com/followrabbit-ai/cloudbuild-datadog-connector//modules/org-log-sink"

  organization_id = var.organization_id
  project_id      = var.project_id

  # Off by default: Cloud Build logs a line per container layer, so org-wide
  # this is a large Log Management bill. Start narrow, e.g.
  #   include_build_logs      = true
  #   build_logs_filter_extra = "AND severity>=WARNING"
  include_build_logs = false
}

module "connector" {
  source = "github.com/followrabbit-ai/cloudbuild-datadog-connector//modules/connector"

  project_id                = var.project_id
  topic_id                  = module.sink.topic_id
  datadog_api_key_secret_id = "datadog-api-key"
  datadog_site              = var.datadog_site
}

# The connector reads builds in every project, so it needs builds.viewer at the
# org node. This is deliberately not inside the module: granting org-level IAM
# should be visible in the caller's code, not buried in a dependency.
resource "google_organization_iam_member" "builds_viewer" {
  org_id = var.organization_id
  role   = "roles/cloudbuild.builds.viewer"
  member = "serviceAccount:${module.connector.service_account_email}"
}

output "dead_letter_subscription" {
  description = "Should normally be empty. Anything here is a transient failure that survived every retry."
  value       = module.connector.dead_letter_subscription
}
