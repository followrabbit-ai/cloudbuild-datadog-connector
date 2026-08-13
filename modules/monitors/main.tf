terraform {
  required_version = ">= 1.3"
  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = ">= 3.30"
    }
  }
}

# Datadog ships CI Visibility dashboards out of the box, so there is no
# dashboard here. Alerting is the part it does not give you.
#
# Ratios on this monitor type must be expressed as formulas-and-functions:
# named event_query variables plus a formula(...) query. The inline
# ci-pipelines("(count[a] / count[b]) * 100") form that circulates online is
# rejected by /api/v1/monitor/validate with "invalid operator specified".

locals {
  provider_filter = "ci_level:pipeline @ci.provider.name:cloudbuild"
  extra           = var.extra_filter == "" ? "" : " ${var.extra_filter}"
}

resource "datadog_monitor" "failure_rate" {
  count = var.create_failure_rate_monitor ? 1 : 0

  name    = "${var.name_prefix}Cloud Build failure rate"
  type    = "ci-pipelines alert"
  query   = "formula(\"(query_a / query_b) * 100\").last(\"${var.failure_rate_window}\") > ${var.failure_rate_critical}"
  message = <<-EOT
    More than ${var.failure_rate_critical}% of Cloud Build pipelines failed in the last ${var.failure_rate_window}.

    ${var.notification}
  EOT

  variables {
    event_query {
      name        = "query_a"
      data_source = "ci_pipelines"
      indexes     = ["*"]
      compute {
        aggregation = "count"
      }
      search {
        query = "${local.provider_filter} @ci.status:error${local.extra}"
      }
    }
    event_query {
      name        = "query_b"
      data_source = "ci_pipelines"
      indexes     = ["*"]
      compute {
        aggregation = "count"
      }
      search {
        query = "${local.provider_filter}${local.extra}"
      }
    }
  }

  monitor_thresholds {
    critical = var.failure_rate_critical
    warning  = var.failure_rate_warning
  }

  notify_no_data = false # A quiet hour is not an incident.
  tags           = var.tags
}

# Unlike a native Datadog integration, this connector is your own moving part,
# so it can fail silently. This watches the pipe itself.
resource "datadog_monitor" "connector_silent" {
  count = var.create_liveness_monitor ? 1 : 0

  name    = "${var.name_prefix}Cloud Build connector has stopped reporting"
  type    = "ci-pipelines alert"
  query   = "ci-pipelines(\"${local.provider_filter}\").rollup(\"count\").last(\"${var.liveness_window}\") < 1"
  message = <<-EOT
    No Cloud Build pipelines reached Datadog in the last ${var.liveness_window}.

    Check, in order:
      - the connector's dead letter subscription for parked messages
      - the forwarder function logs
      - that the Datadog API key secret still has a valid version

    ${var.notification}
  EOT

  monitor_thresholds {
    critical = 1
  }

  # This monitor exists precisely to fire on absence.
  notify_no_data    = true
  no_data_timeframe = var.liveness_no_data_minutes
  tags              = var.tags
}
