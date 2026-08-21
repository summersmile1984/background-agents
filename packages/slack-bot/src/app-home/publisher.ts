import { publishView } from "@open-inspect/shared/slack";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { getUserRepoBranchPreferences } from "../branch-preferences";
import { getAvailableRepos } from "../classifier/repos";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { getResolvedUserPreferences } from "../user-preferences";
import { getAvailableModels, getSlackDefaultModel } from "./models";
import { buildAppHomeView } from "./view";
import { getAvailableHarnesses } from "./harnesses";

const log = createLogger("app-home");

export async function publishAppHome(env: Env, userId: string): Promise<void> {
  const [availableModels, slackDefaultModel, repos, repoBranchPreferences, availableHarnesses] =
    await Promise.all([
      getAvailableModels(env),
      getSlackDefaultModel(env),
      getAvailableRepos(env),
      getUserRepoBranchPreferences(env, userId),
      getAvailableHarnesses(env),
    ]);
  const current = await getResolvedUserPreferences(env, userId, {
    defaultModel: slackDefaultModel ?? env.DEFAULT_MODEL,
    enabledModels: availableModels.map((model) => model.value),
  });
  const view = buildAppHomeView({
    appName: resolveAppName(env),
    availableModels,
    availableHarnesses,
    currentHarness: current.agentHarness,
    currentModel: current.model,
    currentEffort: current.reasoningEffort,
    currentBranch: current.branch,
    repos,
    repoBranchPreferences,
  });

  const result = await publishView(env.SLACK_BOT_TOKEN, userId, {
    type: view.type,
    blocks: view.blocks,
  });

  if (!result.ok) {
    log.error("slack.app_home", { user_id: userId, outcome: "error", slack_error: result.error });
  }
}
