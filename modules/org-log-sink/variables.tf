variable "organization_id" {
  type        = string
  description = "GCP organization numeric id. The sink covers every project beneath it, including ones created later."
}

variable "project_id" {
  type        = string
  description = "Project that hosts the aggregation topic. Normally the same project as the connector."
}

variable "topic_name" {
  type        = string
  description = "Name of the topic the sink writes to."
  default     = "cloudbuild-events"
}

variable "sink_name" {
  type        = string
  description = "Name of the organization sink."
  default     = "cloudbuild-datadog-connector"
}

variable "include_build_logs" {
  type        = bool
  description = <<-EOT
    Also route Cloud Build step output, so build logs reach Datadog Log
    Management correlated to their pipeline and job.

    High volume: Cloud Build logs a line per container layer. Off by default.
    Narrow it with build_logs_filter_extra before enabling org-wide.
  EOT
  default     = false
}

variable "build_logs_filter_extra" {
  type        = string
  description = <<-EOT
    Extra log filter clauses ANDed onto the build-log selector, to keep volume
    sane. For example, to ship only warnings and errors:

      AND severity>=WARNING

    or to limit to one project:

      AND resource.labels.project_id="my-ci-project"
  EOT
  default     = ""
}
