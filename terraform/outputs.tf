###############################################################################
# Outputs
###############################################################################

output "sync_scheduler_jobs" {
  description = "Created Cloud Scheduler sync jobs"
  value = {
    for k, job in google_cloud_scheduler_job.sync : k => {
      name     = job.name
      schedule = job.schedule
      uri      = job.http_target[0].uri
      paused   = job.paused
    }
  }
}

output "cleanup_scheduler_job" {
  description = "Cleanup Cloud Scheduler job"
  value = {
    name     = google_cloud_scheduler_job.cleanup.name
    schedule = google_cloud_scheduler_job.cleanup.schedule
  }
}
