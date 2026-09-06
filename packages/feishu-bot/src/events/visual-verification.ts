import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";

/** Opt in to visual verification from ordinary Feishu language. */
export function visualVerificationForPrompt(
  content: string
): VisualVerificationSelection | undefined {
  const normalized = content.trim().toLowerCase();
  return normalized.includes("视觉验证") ||
    normalized.includes("截图验证") ||
    normalized.includes("截图") ||
    normalized.includes("截个图") ||
    normalized.includes("截一张图") ||
    normalized.includes("截屏") ||
    normalized.includes("预览") ||
    normalized.includes("screenshot") ||
    normalized.includes("screen shot") ||
    normalized.includes("preview") ||
    normalized.includes("capture") ||
    /(?:验证|verify)\s*ui\b/i.test(normalized)
    ? {}
    : undefined;
}
