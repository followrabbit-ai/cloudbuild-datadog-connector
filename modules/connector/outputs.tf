output "service_account_email" {
  description = "Connector identity. Grant it roles/cloudbuild.builds.viewer on every project, folder or organization whose builds it must read."
  value       = google_service_account.forwarder.email
}

output "function_uri" {
  description = "HTTPS endpoint of the forwarder."
  value       = google_cloudfunctions2_function.forwarder.service_config[0].uri
}

output "subscription_name" {
  description = "Push subscription consuming the source topic."
  value       = google_pubsub_subscription.forwarder.name
}

output "dead_letter_topic" {
  description = "Topic that receives messages which failed every delivery attempt."
  value       = google_pubsub_topic.dead_letter.id
}

output "dead_letter_subscription" {
  description = "Pull this to inspect parked messages. It should normally be empty."
  value       = google_pubsub_subscription.dead_letter.name
}
