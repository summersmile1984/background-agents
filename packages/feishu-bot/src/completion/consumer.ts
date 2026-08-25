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
    await processFeishuCompletion(parsed.data, env);
    // A posting failure may have created a message remotely. Do not retry a
    // queue job blindly and risk duplicate completion cards.
    message.ack();
  }
}
