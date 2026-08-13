# Single project: consume the project's own `cloud-builds` topic. Simplest
# setup, no organization permissions needed — but it only sees builds in this
# one project.
#
# Prerequisites:
#   - a Secret Manager secret holding the Datadog API key, with a version
#   - the `cloud-builds` topic, which Cloud Build creates on the first build in
#     the project. If it does not exist yet, run one build first.

terraform {
  required_version = ">= 1.3"
}

provider "google" {
  project = var.project_id
}

variable "project_id" { type = string }
variable "datadog_site" {
  type    = string
  default = "datadoghq.com"
}

# Referenced rather than managed, so `terraform destroy` cannot remove the topic
# every build in the project publishes to.
data "google_pubsub_topic" "cloud_builds" {
  name    = "cloud-builds"
  project = var.project_id
}

module "connector" {
  source = "github.com/followrabbit-ai/cloudbuild-datadog-connector//modules/connector"

  project_id                = var.project_id
  topic_id                  = data.google_pubsub_topic.cloud_builds.id
  datadog_api_key_secret_id = "datadog-api-key"
  datadog_site              = var.datadog_site

  # Optional: unlocks commit author attribution. Without it, branch, commit and
  # PR still ship as tags.
  # github_token_secret_id = "cicd-github-token"
}
