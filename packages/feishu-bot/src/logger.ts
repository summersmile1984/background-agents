import {
  createLogger as createSharedLogger,
  type LogLevel,
  type Logger,
} from "@open-inspect/shared/logger";

export type { Logger, LogLevel } from "@open-inspect/shared/logger";

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  return createSharedLogger(component, context, minLevel, "feishu-bot");
}
