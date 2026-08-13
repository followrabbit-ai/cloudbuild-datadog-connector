variable "project_id" {
  type        = string
  description = "Project that hosts the connector (the function, its subscription and its dead letter queue)."
}

variable "region" {
  type        = string
  description = "Region for the Cloud Function."
  default     = "europe-west1"
}

variable "name" {
  type        = string
  description = "Base name for every resource this module creates. Change it to run more than one connector in a project."
  default     = "cloudbuild-datadog-connector"
}

variable "topic_id" {
  type        = string
  description = <<-EOT
    Pub/Sub topic to consume, as a full id (projects/<p>/topics/<t>).

    Single project: the project's own `cloud-builds` topic.
    Organization:   the topic fed by the org-log-sink module.
  EOT
}

variable "datadog_api_key_secret_id" {
  type        = string
  description = <<-EOT
    Secret Manager secret holding the Datadog API key, as a short id (not a
    full resource name). Create the secret and add its value yourself — this
    module never takes the key as a variable, because that would write it into
    Terraform state.
  EOT
}

variable "datadog_site" {
  type        = string
  description = "Datadog site, e.g. datadoghq.com, datadoghq.eu, us5.datadoghq.com."
  default     = "datadoghq.com"
}

variable "github_token_secret_id" {
  type        = string
  description = <<-EOT
    Optional Secret Manager secret holding a GitHub token with contents:read.

    Datadog requires git.author_email before it accepts a `git` block, and the
    Cloud Build resource contains no author anywhere. Without this, commit,
    branch and PR still ship as tags; only author attribution is missing.
  EOT
  default     = ""
}

variable "forward_logs" {
  type        = bool
  description = <<-EOT
    Whether the connector accepts Cloud Build step logs in addition to build
    results. This only takes effect if you also route those logs to `topic_id`.

    Cloud Build emits a log line per container layer, so org-wide this can be a
    large Log Management bill. Off by default on purpose.
  EOT
  default     = false
}

variable "env" {
  type        = string
  description = "Value for the Datadog `env` tag on forwarded logs. Optional."
  default     = ""
}

variable "service" {
  type        = string
  description = "Value for the Datadog `service` tag on forwarded logs."
  default     = "cloudbuild"
}

variable "max_instance_count" {
  type        = number
  description = "Cap on concurrent function instances, so a build storm cannot run away."
  default     = 10
}

variable "max_delivery_attempts" {
  type        = number
  description = "Deliveries before a message is dead-lettered. Only transient failures ever get this far; permanent ones are acked and logged."
  default     = 5
}
