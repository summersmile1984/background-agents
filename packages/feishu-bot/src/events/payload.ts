import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const feishuEventEnvelopeSchema = z.object({
  schema: z.string().optional(),
  type: z.string().optional(),
  challenge: z.string().optional(),
  header: z
    .object({
      event_id: nonEmpty.optional(),
      event_type: nonEmpty.optional(),
      tenant_key: nonEmpty.optional(),
      token: nonEmpty.optional(),
    })
    .optional(),
  event: z
    .object({
      sender: z
        .object({
          sender_type: z.string().optional(),
          sender_id: z.object({ open_id: nonEmpty.optional() }).optional(),
        })
        .optional(),
      message: z
        .object({
          chat_id: nonEmpty.optional(),
          chat_type: z.enum(["p2p", "group"]).optional(),
          message_id: nonEmpty.optional(),
          root_id: nonEmpty.optional(),
          parent_id: nonEmpty.optional(),
          thread_id: nonEmpty.optional(),
          message_type: z.string().optional(),
          content: z.string().optional(),
          mentions: z
            .array(z.object({ id: z.object({ open_id: nonEmpty.optional() }).optional() }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type FeishuEventEnvelope = z.infer<typeof feishuEventEnvelopeSchema>;

export function isUrlVerification(
  payload: FeishuEventEnvelope
): payload is FeishuEventEnvelope & { challenge: string } {
  return payload.type === "url_verification" && typeof payload.challenge === "string";
}

export function parseFeishuText(content: string | undefined): string | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).text === "string"
    ) {
      const text = (parsed as Record<string, string>).text.trim();
      return text || null;
    }
    return null;
  } catch {
    return null;
  }
}
