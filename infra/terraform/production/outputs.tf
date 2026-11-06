output "name_servers" {
  description = "Azure DNS name servers for townwise.tech. Set these at InterNetX."
  value       = azurerm_dns_zone.main.name_servers
}

output "key_vault_name" {
  description = "Vault for infra/scripts/set-secret.sh."
  value       = azurerm_key_vault.main.name
}

output "api_secret_names" {
  description = "Key Vault secret name => API env var. Seed each before the full apply."
  value       = local.api_secrets
}

output "db_cluster_id" {
  description = "DocumentDB cluster (free tier, private endpoint only). Its connectionString property gives the host for the mongodb+srv URIs (infra/README.md)."
  value       = azapi_resource.docdb.id
}

output "db_jobs" {
  description = "Container Apps jobs: nightly backup, user setup, restore, smoke test."
  value = {
    backup   = azapi_resource.job_backup.name
    db_users = azapi_resource.job_db_users.name
    restore  = azapi_resource.job_restore.name
    smoke    = azapi_resource.job_smoke.name
  }
}

output "backup_storage_account" {
  description = "Holds the mongodump archives (container mongodump, write-once for 30 days)."
  value       = azurerm_storage_account.backup.name
}

output "files_blob_endpoint" {
  description = "FILES_BLOB_ACCOUNT_URL in api/production.env (infra/README.md, \"Enable file storage\"). Reachable only through the private endpoint."
  value       = azurerm_storage_account.files.primary_blob_endpoint
}

output "acr_name" {
  description = "GitHub variable AZURE_ACR_NAME."
  value       = azurerm_container_registry.main.name
}

output "acr_login_server" {
  description = "Registry host for images (<login server>/townwise-api@sha256:...)."
  value       = azurerm_container_registry.main.login_server
}

output "container_app_name" {
  description = "GitHub variable AZURE_CONTAINER_APP."
  value       = azurerm_container_app.api.name
}

output "container_app_fqdn" {
  description = "Default host name of the API, before the custom domain."
  value       = azurerm_container_app.api.ingress[0].fqdn
}

output "static_web_app_name" {
  description = "GitHub variable AZURE_STATIC_WEB_APP."
  value       = azurerm_static_web_app.web.name
}

output "static_web_app_host" {
  description = "Default host name of the web app, before the custom domains."
  value       = azurerm_static_web_app.web.default_host_name
}

output "communication_service_endpoint" {
  description = "Communication Services endpoint for the API's email client (managed identity, AZURE_CLIENT_ID)."
  value       = "https://${azurerm_communication_service.main.hostname}"
}

output "email_sender" {
  description = "From address for outbound email."
  value       = "${azurerm_email_communication_service_domain_sender_username.no_reply.name}@${local.domain}"
}

output "email_service_name" {
  description = "Email Communication Services resource, for domain verification (infra/README.md)."
  value       = azurerm_email_communication_service.main.name
}

output "web_headers" {
  description = "Response headers the Static Web App sends (infra/web/staticwebapp.config.json); compare with curl -sI after a deploy."
  value       = jsondecode(file("${path.module}/../../web/staticwebapp.config.json")).globalHeaders
}

output "web_navigation_fallback" {
  description = "Single-page fallback the Static Web App applies to app routes."
  value       = jsondecode(file("${path.module}/../../web/staticwebapp.config.json")).navigationFallback.rewrite
}
