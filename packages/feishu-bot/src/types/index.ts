import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import type { FeishuCompletionJob } from "../completion/job";

export interface FeishuCompletionQueue {
  send(message: FeishuCompletionJob, options?: { contentType?: "json" }): Promise<unknown>;
}

/** Cloudflare Worker bindings for the Feishu entrypoint. */
export interface Env {
  FEISHU_KV: KVNamespace;
  CONTROL_PLANE: ControlPlaneFetcher;
  FEISHU_COMPLETION_QUEUE: FeishuCompletionQueue;

  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  DEFAULT_AGENT_HARNESS?: string;
  APP_NAME?: string;
  /** Group messages are never processed until this explicitly equals true. */
  FEISHU_TRIGGERS_ENABLED?: string;
  /** Required to distinguish a bot @mention from an ordinary group mention. */
  FEISHU_BOT_OPEN_ID?: string;
  /** Mainland Feishu by default; Terraform allow-lists the value. */
  FEISHU_API_BASE?: string;

  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_VERIFICATION_TOKEN: string;
  FEISHU_ENCRYPT_KEY?: string;
  SERVICE_AUTH_SECRET?: string;
  LOG_LEVEL?: string;
}
