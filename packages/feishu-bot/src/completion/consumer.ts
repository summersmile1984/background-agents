import { createLogger } from "../logger";
import type { Env } from "../types";
import { processFeishuCompletion } from "./delivery";
import { feishuCompletionJobSchema } from "./job";

const log = createLogger("completion-consumer");

export async function consumeFeishuCompletions(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = feishuCompletionJobSchema.safeParse(message.body);
    if (!parsed.success) {
      log.error("completion.invalid_job", {
        queue_message_id: message.id,
        attempts: message.attempts,
      });
      message.ack();
      continue;
    }
    // Card PATCH and legacy replies use stable idempotency identities, while
    // media delivery has its own persistent artifact record. Let a thrown
    // transport failure retry the same job instead of ACKing a lost completion.
    await processFeishuCompletion(parsed.data, env);
    message.ack();
  }
}
