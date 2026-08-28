/**
 * A compact, non-secret identifier that users can quote in a chat when they
 * need to select one of several sessions in a private timeline.
 */
export function sessionShortId(sessionId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6).toUpperCase();
}

/**
 * Parse the explicit private-chat continuation form: `#ABC123 request`.
 * Requiring a six-character hexadecimal id keeps ordinary issue references
 * such as `#123` and prose beginning with `#` on the normal new-session path.
 */
export function parseSessionReference(
  content: string
): { shortId: string; prompt: string } | undefined {
  const match = /^\s*#([0-9a-f]{6})\s+([\s\S]+?)\s*$/i.exec(content);
  if (!match) return undefined;
  const prompt = match[2].trim();
  return prompt ? { shortId: match[1].toUpperCase(), prompt } : undefined;
}
