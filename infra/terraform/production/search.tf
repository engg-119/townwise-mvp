# Event search: the Azure AI Search service that holds the event scout's findings (modeling/research). What it stores
# is public information about public events (titles, dates, venues, the source page) and the scout's own judgment of
# their effect on demand, never client data, so the service keeps its public endpoint. Entra ID only: API keys are
# off, so every caller needs a role on the service. Developers get Search Index Data Contributor on it alone
# (bootstrap/team.tf); an administrator creates the index once (infra/README.md, "Event search").
#
# Free tier: one per subscription, 50 MB and three indexes, no SLA, no private endpoint and no managed identity.
# Plenty for a few thousand events. Off by default.
resource "azurerm_search_service" "events" {
  count                         = var.enable_event_search ? 1 : 0
  name                          = "srch-townwise-${local.suffix}"
  resource_group_name           = local.rg
  location                      = local.location
  sku                           = "free"
  local_authentication_enabled  = false
  public_network_access_enabled = true
  #checkov:skip=CKV_AZURE_124:public events only, no client data; the Free tier has no private endpoint, and callers still need an Entra role
  #checkov:skip=CKV_AZURE_207:the Free tier has no managed identity, and the service calls nothing that would need one
  #checkov:skip=CKV_AZURE_208:the Free tier has one replica and no SLA; the index is rebuilt by re-running the scout
  #checkov:skip=CKV_AZURE_209:the Free tier has one replica and no SLA; the index is rebuilt by re-running the scout
}
