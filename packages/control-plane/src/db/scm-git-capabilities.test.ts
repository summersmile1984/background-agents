import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "./sql-database";
import { ScmGitCapabilityStore } from "./scm-git-capabilities";

describe("ScmGitCapabilityStore.extend", () => {
  it.each([
    [1, true],
    [0, false],
  ] as const)("maps %i updated rows to %s", async (changes, expected) => {
    const run = vi.fn(async () => ({ results: [], meta: { changes } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const store = new ScmGitCapabilityStore({ prepare } as unknown as SqlDatabase);

    await expect(store.extend("session_git", "session-1", 123_456)).resolves.toBe(expected);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE scm_git_capabilities"));
    expect(bind).toHaveBeenCalledWith(123_456, "session_git", "session-1");
  });
});
