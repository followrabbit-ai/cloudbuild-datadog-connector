variable "notification" {
  type        = string
  description = "Datadog notification target appended to each monitor message, e.g. \"@slack-ci\" or an email. Plain text is fine."
  default     = ""
}

variable "name_prefix" {
  type        = string
  description = "Prefix for monitor names, e.g. \"[CI][prod] \"."
  default     = "[CI] "
}

variable "tags" {
  type        = list(string)
  description = "Tags applied to every monitor."
  default     = ["service:cloudbuild"]
}

variable "extra_filter" {
  type        = string
  description = "Extra CI Visibility search clauses ANDed into the failure-rate queries, e.g. \"@git.branch:(main OR develop)\"."
  default     = ""
}

variable "create_failure_rate_monitor" {
  type        = bool
  default     = true
  description = "Alert when too large a share of builds fail."
}

variable "failure_rate_window" {
  type        = string
  default     = "1h"
  description = "Evaluation window for the failure-rate monitor."
}

variable "failure_rate_critical" {
  type        = number
  default     = 25
  description = "Percentage of failed builds that triggers a critical alert."
}

variable "failure_rate_warning" {
  type        = number
  default     = 10
  description = "Percentage of failed builds that triggers a warning."
}

variable "create_liveness_monitor" {
  type        = bool
  default     = true
  description = "Alert when no builds reach Datadog at all, which means the connector is broken rather than idle."
}

variable "liveness_window" {
  type        = string
  default     = "4h"
  description = "How long without any build before the connector is considered silent. Set this above your quietest expected period, e.g. a weekend."
}

variable "liveness_no_data_minutes" {
  type        = number
  default     = 240
  description = "No-data timeframe in minutes for the liveness monitor. Keep it consistent with liveness_window."
}
