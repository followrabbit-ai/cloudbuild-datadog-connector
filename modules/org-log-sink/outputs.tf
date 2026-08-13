output "topic_id" {
  description = "Full topic id to pass to the connector module's topic_id."
  value       = google_pubsub_topic.builds.id
}

output "writer_identity" {
  description = "Identity the sink writes as."
  value       = google_logging_organization_sink.builds.writer_identity
}

output "filter" {
  description = "The effective log filter, useful for checking what the sink will match before applying."
  value       = google_logging_organization_sink.builds.filter
}
