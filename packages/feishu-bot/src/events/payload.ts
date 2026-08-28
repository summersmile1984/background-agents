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
          // Feishu uses `topic_group` for topic-group chats. Internally this
          // is normalized to the same group routing surface as ordinary
          // groups, while preserving the provider payload compatibility.
          chat_type: z.enum(["p2p", "group", "topic_group"]).optional(),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePostRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const text = row
      .flatMap((element) => {
        if (!isRecord(element)) return [];
        // Mentions are routing metadata, not part of the coding prompt.
        if (element.tag === "at") return [];
        return typeof element.text === "string" ? [element.text] : [];
      })
      .join("")
      .trim();
    return text ? [text] : [];
  });
}

function parseFeishuPostValue(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const direct = [
    ...(typeof value.title === "string" && value.title.trim() ? [value.title.trim()] : []),
    ...parsePostRows(value.content),
  ];
  if (direct.length > 0) return direct;

  // Older/localized rich-text payloads wrap locale documents below `post`.
  if (!isRecord(value.post)) return [];
  return Object.values(value.post).flatMap(parseFeishuPostValue);
}

/** Extract a user prompt from the Feishu message types used by topic and flat chats. */
export function parseFeishuMessageText(
  messageType: string | undefined,
  content: string | undefined
): string | null {
  if (messageType === "text") return parseFeishuText(content);
  if (messageType !== "post" || !content) return null;
  try {
    const text = parseFeishuPostValue(JSON.parse(content)).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}
