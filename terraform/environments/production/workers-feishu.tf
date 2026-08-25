# =============================================================================
# Feishu Bot Worker
# =============================================================================

resource "cloudflare_queue" "feishu_completion_delivery" {
  count = var.enable_feishu_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-feishu-completion-${local.name_suffix}"
}

resource "cloudflare_queue" "feishu_completion_delivery_dlq" {
  count = var.enable_feishu_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-feishu-completion-dlq-${local.name_suffix}"
}

resource "null_resource" "feishu_bot_build" {
  count = var.enable_feishu_bot ? 1 : 0

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/feishu-bot"
  }
}

module "feishu_bot_worker" {
  count  = var.enable_feishu_bot ? 1 : 0
  source = "../../modules/cloudflare-worker"

  account_id       = var.cloudflare_account_id
  zone_id          = local.feishu_custom_domain_enabled ? local.control_plane_zone_id : null
  worker_name      = "open-inspect-feishu-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
  custom_domain    = local.feishu_custom_domain_enabled ? local.feishu_custom_domain : null
  script_path      = local.feishu_bot_script_path

  kv_namespaces = [
    {
      binding_name = "FEISHU_KV"
      namespace_id = module.feishu_kv[0].namespace_id
    }
  ]

  service_bindings = [
    {
      binding_name = "CONTROL_PLANE"
      service_name = "open-inspect-control-plane-${local.name_suffix}"
    }
  ]

  enable_service_bindings = var.enable_service_bindings

  queue_bindings = [
    {
      binding_name = "FEISHU_COMPLETION_QUEUE"
      queue_name   = cloudflare_queue.feishu_completion_delivery[0].queue_name
    }
  ]

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "APP_NAME", value = var.app_name },
    { name = "DEFAULT_MODEL", value = "openai/gpt-5.6-luna" },
    { name = "DEFAULT_AGENT_HARNESS", value = var.default_agent_harness },
    { name = "FEISHU_API_BASE", value = var.feishu_api_base },
    { name = "FEISHU_TRIGGERS_ENABLED", value = var.feishu_triggers_enabled ? "true" : "false" },
    { name = "FEISHU_BOT_OPEN_ID", value = var.feishu_bot_open_id },
  ]

  secrets = [
    { name = "FEISHU_APP_ID", value = var.feishu_app_id },
    { name = "FEISHU_APP_SECRET", value = var.feishu_app_secret },
    { name = "FEISHU_VERIFICATION_TOKEN", value = var.feishu_verification_token },
    { name = "FEISHU_ENCRYPT_KEY", value = var.feishu_encrypt_key },
    { name = "SERVICE_AUTH_SECRET", value = random_password.service_auth_secret_feishu_bot.result },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [null_resource.feishu_bot_build[0], module.feishu_kv[0]]
}

resource "cloudflare_queue_consumer" "feishu_completion_delivery" {
  count = var.enable_feishu_bot ? 1 : 0

  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.feishu_completion_delivery[0].queue_id
  type              = "worker"
  script_name       = module.feishu_bot_worker[0].worker_name
  dead_letter_queue = cloudflare_queue.feishu_completion_delivery_dlq[0].queue_name
  settings = {
    batch_size       = 1
    max_wait_time_ms = 1000
    max_concurrency  = 5
    max_retries      = 1
    retry_delay      = 15
  }

  depends_on = [module.feishu_bot_worker]
}
