# townwise.tech is delegated from InterNetX to this zone by hand (infra/README.md). Apply the zone alone
# first (-target), change the name servers, then apply the rest so every validation below can resolve.
resource "azurerm_dns_zone" "main" {
  name                = local.domain
  resource_group_name = local.rg
}

# Web: the apex is an alias to the Static Web App (Azure DNS flattens it); www is a CNAME.
resource "azurerm_dns_a_record" "apex" {
  name                = "@"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600
  target_resource_id  = azurerm_static_web_app.web.id
}

resource "azurerm_dns_cname_record" "www" {
  name                = "www"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600
  record              = azurerm_static_web_app.web.default_host_name
}

# Static Web Apps domain validation. The token is needed only until validation succeeds and may later
# read back empty, so Terraform does not chase it. It does read back empty once a domain is Ready, and the
# provider rejects an empty TXT value at plan time even under ignore_changes, so coalesce() supplies a
# placeholder that ignore_changes keeps out of the live record.
resource "azurerm_dns_txt_record" "swa_validation" {
  for_each = {
    "_dnsauth"     = coalesce(azurerm_static_web_app_custom_domain.apex.validation_token, "validated")
    "_dnsauth.www" = coalesce(azurerm_static_web_app_custom_domain.www.validation_token, "validated")
  }
  name                = each.key
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600

  record {
    value = each.value
  }

  lifecycle {
    ignore_changes = [record]
  }
}

# API: an A record to the Container Apps environment's static inbound IP, plus the ownership TXT record.
resource "azurerm_dns_a_record" "api" {
  name                = "api"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600
  records             = [azurerm_container_app_environment.main.static_ip_address]
}

resource "azurerm_dns_txt_record" "api_verification" {
  name                = "asuid.api"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600

  record {
    value = azurerm_container_app.api.custom_domain_verification_id
  }
}

# Email (Communication Services, email.tf): domain verification and SPF share the apex TXT record set.
locals {
  acs_records = azurerm_email_communication_service_domain.main.verification_records[0]
}

resource "azurerm_dns_txt_record" "apex" {
  name                = "@"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600

  record {
    value = local.acs_records.domain[0].value
  }

  record {
    value = local.acs_records.spf[0].value
  }
}

resource "azurerm_dns_cname_record" "acs_dkim" {
  for_each = {
    dkim  = local.acs_records.dkim[0]
    dkim2 = local.acs_records.dkim2[0]
  }
  name                = each.value.name
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600
  record              = each.value.value
}

# Reject from day one, for the apex and every subdomain, with strict DKIM alignment. Only Communication
# Services sends as townwise.tech, and it DKIM-signs with the selector1/selector2 keys above. Before any other
# sender is added (a newsletter tool, a help desk), it must DKIM-sign as townwise.tech with an aligned key, or
# its mail is rejected. No reports until a mailbox exists for them.
resource "azurerm_dns_txt_record" "dmarc" {
  name                = "_dmarc"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = local.rg
  ttl                 = 3600

  record {
    value = "v=DMARC1; p=reject; sp=reject; adkim=s;"
  }
}
