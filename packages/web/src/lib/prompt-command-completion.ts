import type { RuntimeCommandOption } from "@open-inspect/shared/types/runtime-launch";

export interface ActiveCommandCompletion {
  query: string;
  start: 0;
  end: number;
}

export function findActiveCommandCompletion(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null
): ActiveCommandCompletion | null {
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart !== selectionEnd ||
    !value.startsWith("/") ||
    !/^\/[a-z0-9-]*$/i.test(value.slice(0, selectionStart)) ||
    value.slice(selectionStart).trim().length > 0
  ) {
    return null;
  }
  return { query: value.slice(1, selectionStart).toLowerCase(), start: 0, end: value.length };
}

export function filterCommandSuggestions(
  commands: readonly RuntimeCommandOption[],
  completion: ActiveCommandCompletion | null
): RuntimeCommandOption[] {
  if (!completion) return [];
  return commands.filter((command) => command.slashName.startsWith(completion.query));
}

export function applyCommandCompletion(
  command: RuntimeCommandOption,
  maxLength?: number
): { value: string; caret: number } | null {
  const value = `/${command.slashName}`;
  if (maxLength !== undefined && value.length > maxLength) return null;
  return { value, caret: value.length };
}
