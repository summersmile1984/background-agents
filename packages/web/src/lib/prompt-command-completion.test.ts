import { describe, expect, it } from "vitest";
import type { RuntimeCommandOption } from "@open-inspect/shared/types/runtime-launch";
import {
  applyCommandCompletion,
  filterCommandSuggestions,
  findActiveCommandCompletion,
} from "./prompt-command-completion";

const command: RuntimeCommandOption = {
  id: "product.status",
  slashName: "status",
  title: "Status",
  description: "Show status",
  group: "session",
  owner: "product",
  harnesses: "all",
  contexts: ["idle-session"],
  execution: "control-plane",
  arguments: [],
  mutates: [],
  available: true,
};

describe("prompt command completion", () => {
  it("recognizes only a leading slash command token", () => {
    expect(findActiveCommandCompletion("/sta", 4, 4)).toEqual({
      query: "sta",
      start: 0,
      end: 4,
    });
    expect(findActiveCommandCompletion("Please /sta", 11, 11)).toBeNull();
    expect(findActiveCommandCompletion("$sta", 4, 4)).toBeNull();
  });

  it("filters and applies a command without converting it to prompt text", () => {
    const completion = findActiveCommandCompletion("/sta", 4, 4);
    expect(filterCommandSuggestions([command], completion)).toEqual([command]);
    expect(applyCommandCompletion(command)).toEqual({ value: "/status", caret: 7 });
  });
});
