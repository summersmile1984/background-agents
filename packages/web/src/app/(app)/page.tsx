"use client";

import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { isSessionInboxKey } from "@/lib/session-inbox-api";
import { APP_NAME } from "@/lib/site-config";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  type ModelCategory,
  type ValidModel,
} from "@open-inspect/shared/models";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useAgentRuntimeReadiness } from "@/hooks/use-agent-runtime";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import {
  ATTACHMENT_ACCEPT,
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import {
  useSessionTargetPicker,
  type SessionTargetSelection,
} from "@/hooks/use-session-target-picker";
import { SessionTargetPicker } from "@/components/session-target-picker";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { ModelIcon, PaperclipIcon, SendIcon } from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { SessionSkillSelector } from "@/components/session-skill-selector";
import { PromptSkillTextarea } from "@/components/prompt-skill-autocomplete";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import {
  useSkillResolutionPreview,
  type SkillResolutionPreviewInput,
  type SkillResolutionPreviewResponse,
} from "@/hooks/use-managed-skills";
import type { SessionTargetRequestFields } from "@/lib/session-target";
import type { PromptSkillSuggestionSource } from "@/lib/prompt-skill-completion";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { AgentHarnessSelector, getAgentHarnessLabel } from "@/components/agent-harness-selector";
import { getAgentHarnessModelOptions, getModelIds } from "@/lib/agent-harness-models";
import type { Repo } from "@/hooks/use-repos";
import type {
  RuntimeEffortOption,
  RuntimeHarnessOption,
  RuntimeLaunchTarget,
  RuntimeModelOption,
  ResolvedRuntimeValue,
  RuntimeCommandOption,
} from "@open-inspect/shared/types/runtime-launch";
import { useRuntimeLaunchDraft } from "@/hooks/use-runtime-launch-draft";
import { repoSelectionValue } from "@/lib/repository-selection";
import { RuntimeSettingsPopover } from "@/components/runtime-settings-popover";
import { VisualVerificationToggle } from "@/components/visual-verification-toggle";
import { toast } from "sonner";

const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";

function runtimeModelCategories(models: RuntimeModelOption[]): ModelCategory[] {
  const groups = new Map<string, ModelCategory["models"]>();
  for (const model of models) {
    const entries = groups.get(model.category) ?? [];
    entries.push({
      id: model.model as ValidModel,
      name: model.displayName,
      description: model.description,
    });
    groups.set(model.category, entries);
  }
  return [...groups].map(([category, entries]) => ({ category, models: entries }));
}

function runtimeTargetForPicker(picker: SessionTargetSelection): RuntimeLaunchTarget | null {
  const target = picker.sessionTarget;
  if (!target) return null;
  if (target.kind === "none") return { kind: "none" };
  if (target.kind === "environment") {
    return { kind: "environment", environmentId: target.environmentId };
  }
  if (target.kind === "repo") {
    const repository = picker.repos.find(
      (repo) =>
        repoSelectionValue(repo) === target.repoFullName || repo.fullName === target.repoFullName
    );
    return repository?.repositoryKey
      ? {
          kind: "repository",
          repositoryKey: repository.repositoryKey,
          ...(picker.selectedBranch ? { branch: picker.selectedBranch } : {}),
        }
      : null;
  }
  const repositoryKeys = target.repoFullNames.flatMap((value) => {
    const repository = picker.repos.find(
      (repo) => repoSelectionValue(repo) === value || repo.fullName.toLowerCase() === value
    );
    return repository?.repositoryKey ? [repository.repositoryKey] : [];
  });
  return repositoryKeys.length === target.repoFullNames.length
    ? { kind: "repository-set", repositoryKeys }
    : null;
}

function skillPreviewTarget(
  fields: SessionTargetRequestFields | null,
  repos: Repo[]
): Omit<SkillResolutionPreviewInput, "selection"> | null {
  if (!fields) return null;
  if ("environmentId" in fields) return { environmentId: fields.environmentId };
  if ("repositories" in fields) {
    return {
      repositories: fields.repositories.map((repository) => ({
        ...repository,
        baseBranch: null,
      })),
    };
  }
  if ("repositoryKey" in fields) {
    const repo = repos.find((candidate) => candidate.repositoryKey === fields.repositoryKey);
    return repo ? { repoOwner: repo.owner, repoName: repo.name } : {};
  }
  if ("repositoryKeys" in fields) {
    const selected = fields.repositoryKeys
      .map((key) => repos.find((candidate) => candidate.repositoryKey === key))
      .filter((repo): repo is Repo => Boolean(repo));
    return selected.length === fields.repositoryKeys.length
      ? {
          repositories: selected.map((repo) => ({
            repoOwner: repo.owner,
            repoName: repo.name,
            baseBranch: null,
          })),
        }
      : {};
  }
  return fields.repoOwner && fields.repoName
    ? { repoOwner: fields.repoOwner, repoName: fields.repoName }
    : {};
}

export default function Home() {
  const { data: session } = useAuthSession();
  const router = useRouter();
  const picker = useSessionTargetPicker();
  const { sessionTarget, selectedBranch, configKey, buildRequestFields, isLaunchable } = picker;
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [prompt, setPrompt] = useState("");
  const [visualVerificationRequested, setVisualVerificationRequested] = useState(false);
  const [agentHarness, setAgentHarness] = useState<AgentHarness | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Record<string, unknown>>({});
  const [skillSelection, setSkillSelection] = useState<SessionSkillSelection>({ mode: "all" });
  const skillSelectionKey =
    skillSelection.mode === "profile" ? `profile:${skillSelection.profileId}` : skillSelection.mode;
  const sessionAttachments = useSessionAttachments();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);
  const [pendingVisualVerificationAvailable, setPendingVisualVerificationAvailable] = useState<
    boolean | null
  >(null);
  const pendingVisualVerificationAvailableRef = useRef<boolean | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const sessionCreationErrorRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const submitInFlightRef = useRef(false);
  // Keyed by the picker's configKey so environment/ad-hoc selections
  // invalidate a warmed session exactly like repo/branch changes do.
  const pendingConfigRef = useRef<{
    target: string;
    model: string;
    reasoningEffort?: string;
    branch: string;
    skills: string;
    agentHarness: AgentHarness | null;
    runtimeSettings: string;
  } | null>(null);
  const hasHydratedModelPreferencesRef = useRef(false);
  const { enabledModelOptions, loading: loadingEnabledModels } = useEnabledModels();
  const { data: agentRuntime } = useAgentRuntimeReadiness();
  const effectiveAgentHarness =
    agentHarness ??
    picker.targetDefaultAgentHarness ??
    agentRuntime?.preferences.defaultAgentHarness ??
    "opencode";
  const harnessModelOptions = getAgentHarnessModelOptions(
    enabledModelOptions,
    effectiveAgentHarness
  );
  const harnessModelIds = getModelIds(harnessModelOptions);
  const currentSkillPreviewTarget = session
    ? skillPreviewTarget(buildRequestFields(), picker.repos)
    : null;
  const {
    preview: skillPreview,
    loading: skillPreviewLoading,
    suggestions: skillSuggestions,
  } = useSkillResolutionPreview(currentSkillPreviewTarget, skillSelection);

  useEffect(() => {
    if (hasHydratedModelPreferencesRef.current) return;

    const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const storedReasoningEffort = localStorage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    setStoredPreference({
      model: storedModel ?? DEFAULT_MODEL,
      reasoningEffort: storedReasoningEffort ?? undefined,
    });
    hasHydratedModelPreferencesRef.current = true;
  }, []);

  const { model: selectedModel, reasoningEffort } = resolveModelPreference(
    modelPreferenceDraft ?? storedPreference,
    loadingEnabledModels ? undefined : harnessModelIds
  );
  const runtimeTarget = useMemo(() => runtimeTargetForPicker(picker), [picker]);
  const runtimeDraftRequest = useMemo(
    () =>
      runtimeTarget
        ? {
            target: runtimeTarget,
            runtime: {
              harness: agentHarness ?? ("inherit" as const),
              model: selectedModel,
              effort: reasoningEffort ?? ("inherit" as const),
              ...(Object.keys(runtimeSettings).length ? { settings: runtimeSettings } : {}),
            },
          }
        : null,
    [runtimeTarget, agentHarness, selectedModel, reasoningEffort, runtimeSettings]
  );
  const runtimeDraft = useRuntimeLaunchDraft(runtimeDraftRequest);
  const resolvedModelOptions = runtimeDraft.data
    ? runtimeModelCategories(runtimeDraft.data.options.models)
    : harnessModelOptions;
  const runtimeEffortOptions = runtimeDraft.data?.options.efforts;
  const runtimeLaunchable =
    isLaunchable &&
    (!runtimeTarget ||
      (runtimeDraft.data
        ? runtimeDraft.data.launchable
        : !runtimeDraft.loading && !runtimeDraft.error));
  const displayedEffectiveAgentHarness =
    runtimeDraft.data?.effective.harness?.value ?? effectiveAgentHarness;
  const selectedRuntimeHarnessOption = runtimeDraft.data?.options.harnesses.find(
    (option) => option.harness === displayedEffectiveAgentHarness
  );
  const runtimeSettingsKey = JSON.stringify(runtimeSettings);

  useEffect(() => {
    setRuntimeSettings({});
  }, [displayedEffectiveAgentHarness]);

  // Skills are pinned while the session warms, so any identity input change
  // must discard that session rather than submit a prompt with stale skills.
  useEffect(() => {
    const staleSessionId = pendingSessionIdRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    pendingSessionIdRef.current = null;
    setPendingSessionId(null);
    pendingVisualVerificationAvailableRef.current = null;
    setPendingVisualVerificationAvailable(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    sessionCreationErrorRef.current = null;
    pendingConfigRef.current = null;
    if (staleSessionId) {
      void browserApiFetch(`/api/sessions/${staleSessionId}/expire-draft`, {
        method: "POST",
      }).catch(() => undefined);
    }
  }, [
    sessionTarget,
    selectedModel,
    reasoningEffort,
    selectedBranch,
    skillSelectionKey,
    agentHarness,
    runtimeDraft.data?.draftDigest,
    runtimeSettingsKey,
  ]);

  const createSessionForWarming = useCallback(async () => {
    if (loadingEnabledModels) return null;
    if (runtimeTarget && runtimeDraft.data && !runtimeDraft.data.launchable) {
      const issue = runtimeDraft.data?.issues.find((candidate) => candidate.severity === "error");
      sessionCreationErrorRef.current = issue?.message ?? "Runtime configuration is not ready";
      return null;
    }
    if (runtimeTarget && runtimeDraft.loading) return null;
    if (pendingSessionId) return pendingSessionId;
    if (sessionCreationPromise.current) return sessionCreationPromise.current;
    const targetRequestFields = buildRequestFields();
    if (!targetRequestFields) return null;

    setIsCreatingSession(true);
    sessionCreationErrorRef.current = null;
    const currentConfig = {
      target: configKey,
      model: selectedModel,
      reasoningEffort,
      branch: sessionTarget?.kind === "repo" ? selectedBranch : "",
      skills: skillSelectionKey,
      agentHarness,
      runtimeSettings: runtimeSettingsKey,
    };
    pendingConfigRef.current = currentConfig;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const promise = (async () => {
      try {
        const res = await browserApiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...targetRequestFields,
            model: selectedModel,
            reasoningEffort,
            ...(agentHarness ? { agentHarness } : {}),
            ...(runtimeDraft.data
              ? {
                  runtime: runtimeDraftRequest?.runtime,
                  runtimeDraftDigest: runtimeDraft.data.draftDigest,
                }
              : {}),
            skillSelection,
          }),
          signal: abortController.signal,
        });

        if (res.ok) {
          const data = await res.json();
          if (
            pendingConfigRef.current?.target === currentConfig.target &&
            pendingConfigRef.current?.model === currentConfig.model &&
            pendingConfigRef.current?.reasoningEffort === currentConfig.reasoningEffort &&
            pendingConfigRef.current?.branch === currentConfig.branch &&
            pendingConfigRef.current?.skills === currentConfig.skills &&
            pendingConfigRef.current?.agentHarness === currentConfig.agentHarness &&
            pendingConfigRef.current?.runtimeSettings === currentConfig.runtimeSettings
          ) {
            pendingSessionIdRef.current = data.sessionId;
            setPendingSessionId(data.sessionId);
            const visualVerificationAvailable = data.visualVerificationEnabled === true;
            pendingVisualVerificationAvailableRef.current = visualVerificationAvailable;
            setPendingVisualVerificationAvailable(visualVerificationAvailable);
            return data.sessionId as string;
          }
          return null;
        }
        let message = "Failed to create session";
        try {
          const data = (await res.json()) as { error?: unknown; code?: unknown };
          if (typeof data.error === "string" && data.error) message = data.error;
          if (
            typeof data.code === "string" &&
            [
              "HARNESS_DISABLED",
              "RUNTIME_UNAVAILABLE",
              "MODEL_INCOMPATIBLE",
              "CREDENTIAL_MISSING",
              "CREDENTIAL_EXPIRED",
              "RELAY_UNAVAILABLE",
              "PROVIDER_UNAVAILABLE",
            ].includes(data.code)
          ) {
            message += ". Check Settings → Harnesses.";
          }
        } catch {
          // Keep the stable fallback for non-JSON responses.
        }
        sessionCreationErrorRef.current = message;
        setError(message);
        return null;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return null;
        }
        console.error("Failed to create session for warming:", error);
        sessionCreationErrorRef.current = "Failed to create session";
        setError("Failed to create session");
        return null;
      } finally {
        if (abortControllerRef.current === abortController) {
          setIsCreatingSession(false);
          sessionCreationPromise.current = null;
          abortControllerRef.current = null;
        }
      }
    })();

    sessionCreationPromise.current = promise;
    return promise;
  }, [
    sessionTarget,
    selectedBranch,
    configKey,
    buildRequestFields,
    selectedModel,
    reasoningEffort,
    skillSelection,
    skillSelectionKey,
    agentHarness,
    pendingSessionId,
    loadingEnabledModels,
    runtimeTarget,
    runtimeDraftRequest,
    runtimeDraft.data,
    runtimeDraft.loading,
    runtimeSettingsKey,
  ]);

  const saveModelPreferenceDraft = useCallback((preference: ModelPreference) => {
    setModelPreferenceDraft(preference);
    localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, preference.model);
    if (preference.reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, preference.reasoningEffort);
    } else {
      localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const resolved = runtimeDraft.data;
    if (!resolved || resolved.options.models.length === 0) return;
    const currentModel = resolved.options.models.find((model) => model.model === selectedModel);
    const nextModel = currentModel ?? resolved.options.models[0];
    const allowedEfforts = new Set(nextModel.efforts.map((effort) => effort.value));
    const nextEffort =
      reasoningEffort && allowedEfforts.has(reasoningEffort)
        ? reasoningEffort
        : (nextModel.efforts.find((effort) => effort.isDefault)?.value ?? undefined);
    if (nextModel.model !== selectedModel || nextEffort !== reasoningEffort) {
      saveModelPreferenceDraft({ model: nextModel.model, reasoningEffort: nextEffort });
    }
  }, [runtimeDraft.data, selectedModel, reasoningEffort, saveModelPreferenceDraft]);

  const handleModelChange = useCallback(
    (model: string) => {
      saveModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
    },
    [saveModelPreferenceDraft]
  );

  const handleReasoningEffortChange = useCallback(
    (nextReasoningEffort: string | undefined) => {
      saveModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [saveModelPreferenceDraft, selectedModel]
  );

  const handlePromptChange = (value: string) => {
    const wasEmpty = prompt.length === 0;
    setPrompt(value);
    if (
      wasEmpty &&
      value.length > 0 &&
      !pendingSessionId &&
      !isCreatingSession &&
      !loadingEnabledModels &&
      runtimeLaunchable
    ) {
      createSessionForWarming();
    }
  };

  const handleAddFiles = (files: Iterable<File>) => {
    sessionAttachments.addFiles(files);
    if (!pendingSessionId && !isCreatingSession && runtimeLaunchable) {
      createSessionForWarming();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current || sessionAttachments.isUploading || loadingEnabledModels) return;
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (!prompt.trim() && !hasAttachments) return;
    const commandMatch = !hasAttachments ? /^\/([a-z0-9-]+)$/i.exec(prompt.trim()) : null;
    if (commandMatch) {
      const slashName = commandMatch[1].toLowerCase();
      const command = runtimeDraft.data?.options.commands.find(
        (candidate) => candidate.slashName === slashName
      );
      if (!command || !command.available) {
        setError(command?.unavailableReason ?? `Unknown command: /${slashName}`);
        return;
      }
      const staleDraftSessionId = pendingSessionId;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      sessionCreationPromise.current = null;
      pendingConfigRef.current = null;
      pendingSessionIdRef.current = null;
      setPendingSessionId(null);
      pendingVisualVerificationAvailableRef.current = null;
      setPendingVisualVerificationAvailable(null);
      setIsCreatingSession(false);
      if (staleDraftSessionId) {
        void browserApiFetch(`/api/sessions/${staleDraftSessionId}/expire-draft`, {
          method: "POST",
        }).catch(() => undefined);
      }
      if (command.id === "product.model") {
        document.getElementById("draft-runtime-model-selector")?.click();
      } else if (command.id === "product.effort") {
        document.querySelector<HTMLButtonElement>('button[aria-label^="Reasoning:"]')?.focus();
        toast.info("Use the Effort control beside the model selector");
      } else if (command.id === "product.help") {
        toast.info(
          `Available: ${runtimeDraft.data?.options.commands
            .filter((candidate) => candidate.available)
            .map((candidate) => `/${candidate.slashName}`)
            .join(", ")}`
        );
      } else if (command.id === "product.new") {
        setAgentHarness(null);
        setRuntimeSettings({});
      }
      setPrompt("");
      return;
    }
    if (!runtimeLaunchable) {
      const runtimeIssue = runtimeDraft.data?.issues.find((issue) => issue.severity === "error");
      setError(
        runtimeIssue?.message ??
          (sessionTarget?.kind === "repos"
            ? "Select at least one repository"
            : "Please select a repository or environment")
      );
      return;
    }

    submitInFlightRef.current = true;
    setCreating(true);
    setError("");

    try {
      let sessionId = pendingSessionId;
      if (!sessionId) {
        sessionId = await createSessionForWarming();
      }

      if (!sessionId) {
        setError(sessionCreationErrorRef.current ?? "Failed to create session");
        return;
      }

      if (visualVerificationRequested && pendingVisualVerificationAvailableRef.current === false) {
        setError(
          "Visual verification is disabled for this target. Enable it in Settings → Sandbox, then start a new session."
        );
        return;
      }

      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch {
          return;
        }
      }

      const res = await browserApiFetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
          model: selectedModel,
          reasoningEffort,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(visualVerificationRequested ? { visualVerification: {} } : {}),
        }),
      });

      if (res.ok) {
        sessionAttachments.clearAttachments();
        mutate(isUnarchivedSessionListKey);
        mutate(isSessionInboxKey);
        router.push(`/session/${sessionId}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send prompt");
        setCreating(false);
      }
    } catch (_error) {
      setError("Failed to create session");
    } finally {
      submitInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <HomeContent
      isAuthenticated={!!session}
      picker={picker}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={handleReasoningEffortChange}
      prompt={prompt}
      handlePromptChange={handlePromptChange}
      visualVerificationRequested={visualVerificationRequested}
      setVisualVerificationRequested={setVisualVerificationRequested}
      visualVerificationAvailable={pendingVisualVerificationAvailable !== false}
      attachments={{
        items: sessionAttachments.attachments,
        error: sessionAttachments.attachmentError,
        isUploading: sessionAttachments.isUploading,
        onAdd: handleAddFiles,
        onRemove: sessionAttachments.removeAttachment,
      }}
      creating={creating}
      isCreatingSession={isCreatingSession}
      error={error}
      handleSubmit={handleSubmit}
      modelOptions={resolvedModelOptions}
      runtimeEffortOptions={runtimeEffortOptions}
      runtimeHarnessOptions={runtimeDraft.data?.options.harnesses}
      runtimeCommands={runtimeDraft.data?.options.commands}
      runtimeLaunchable={runtimeLaunchable}
      runtimeResolving={runtimeDraft.loading || runtimeDraft.validating}
      runtimeHarnessOption={selectedRuntimeHarnessOption}
      runtimeEffectiveSettings={runtimeDraft.data?.effective.settings}
      runtimeSettings={runtimeSettings}
      setRuntimeSettings={setRuntimeSettings}
      skillSelection={skillSelection}
      setSkillSelection={setSkillSelection}
      skillPreviewTarget={currentSkillPreviewTarget}
      skillPreview={skillPreview}
      skillPreviewLoading={skillPreviewLoading}
      skillSuggestions={skillSuggestions}
      agentHarness={agentHarness}
      effectiveAgentHarness={displayedEffectiveAgentHarness}
      setAgentHarness={setAgentHarness}
    />
  );
}

function HomeContent({
  isAuthenticated,
  picker,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  prompt,
  handlePromptChange,
  visualVerificationRequested,
  setVisualVerificationRequested,
  visualVerificationAvailable,
  attachments,
  creating,
  isCreatingSession,
  error,
  handleSubmit,
  modelOptions,
  runtimeEffortOptions,
  runtimeHarnessOptions,
  runtimeCommands,
  runtimeLaunchable,
  runtimeResolving,
  runtimeHarnessOption,
  runtimeEffectiveSettings,
  runtimeSettings,
  setRuntimeSettings,
  skillSelection,
  setSkillSelection,
  skillPreviewTarget,
  skillPreview,
  skillPreviewLoading,
  skillSuggestions,
  agentHarness,
  effectiveAgentHarness,
  setAgentHarness,
}: {
  isAuthenticated: boolean;
  picker: SessionTargetSelection;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  reasoningEffort: string | undefined;
  setReasoningEffort: (value: string | undefined) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  visualVerificationRequested: boolean;
  setVisualVerificationRequested: (value: boolean) => void;
  visualVerificationAvailable: boolean;
  attachments: {
    items: ReturnType<typeof useSessionAttachments>["attachments"];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  creating: boolean;
  isCreatingSession: boolean;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
  modelOptions: ModelCategory[];
  runtimeEffortOptions?: RuntimeEffortOption[];
  runtimeHarnessOptions?: RuntimeHarnessOption[];
  runtimeCommands?: RuntimeCommandOption[];
  runtimeLaunchable: boolean;
  runtimeResolving: boolean;
  runtimeHarnessOption?: RuntimeHarnessOption;
  runtimeEffectiveSettings?: Record<string, ResolvedRuntimeValue<unknown>>;
  runtimeSettings: Record<string, unknown>;
  setRuntimeSettings: (value: Record<string, unknown>) => void;
  skillSelection: SessionSkillSelection;
  setSkillSelection: (value: SessionSkillSelection) => void;
  skillPreviewTarget: Omit<SkillResolutionPreviewInput, "selection"> | null;
  skillPreview: SkillResolutionPreviewResponse | null;
  skillPreviewLoading: boolean;
  skillSuggestions: PromptSkillSuggestionSource;
  agentHarness: AgentHarness | null;
  effectiveAgentHarness: AgentHarness;
  setAgentHarness: (value: AgentHarness | null) => void;
}) {
  const { isOpen } = useSidebarContext();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsLocked = creating || attachments.isUploading;
  const {
    isDraggingOver,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = useAttachmentDropZone({ locked: attachmentsLocked, onAdd: attachments.onAdd });
  const { sessionTarget, selectedRepo, repos, loadingRepos } = picker;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to {APP_NAME}</h1>
            {isAuthenticated ? (
              <p className="text-muted-foreground">
                Ask a question or describe what you want to build
              </p>
            ) : (
              <p className="text-muted-foreground">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

              <div
                className={`border border-border bg-input ${isDraggingOver ? "ring-2 ring-accent" : ""}`}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <AttachmentPreviewStrip
                  items={attachments.items}
                  error={attachments.error}
                  onRemove={attachments.onRemove}
                  disabled={attachmentsLocked}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                {/* Text input area */}
                <div className="relative">
                  <PromptSkillTextarea
                    ref={inputRef}
                    value={prompt}
                    suggestions={skillSuggestions}
                    commands={runtimeCommands}
                    onValueChange={handlePromptChange}
                    onKeyDown={handleKeyDown}
                    maxLength={MAX_WEB_PROMPT_CHARS}
                    disabled={creating}
                    placeholder="What do you want to build?"
                    autoComplete="off"
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {isCreatingSession && (
                      <span className="whitespace-nowrap text-xs text-accent">
                        Warming sandbox...
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachmentsLocked}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title="Attach images"
                      aria-label="Attach images"
                    >
                      <PaperclipIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && attachments.items.length === 0) ||
                        attachmentsLocked ||
                        !runtimeLaunchable ||
                        runtimeResolving
                      }
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                      aria-label={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                    >
                      {creating ? (
                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <SendIcon className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Footer row with target and model selectors */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                  {/* Left side - Target selector + Model selector */}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    <SessionTargetPicker {...picker.pickerProps} disabled={creating} />

                    <AgentHarnessSelector
                      value={agentHarness}
                      onChange={setAgentHarness}
                      inheritLabel={`Target default (${getAgentHarnessLabel(effectiveAgentHarness)})`}
                      showPrefix
                      disabled={creating || runtimeResolving}
                      runtimeOptions={runtimeHarnessOptions}
                    />

                    <RuntimeSettingsPopover
                      harness={runtimeHarnessOption}
                      effective={runtimeEffectiveSettings}
                      values={runtimeSettings}
                      onChange={setRuntimeSettings}
                      disabled={creating || runtimeResolving}
                    />

                    {/* Model selector */}
                    <Combobox
                      id="draft-runtime-model-selector"
                      value={selectedModel}
                      onChange={(value) => setSelectedModel(value)}
                      items={
                        modelOptions.map((group) => ({
                          category: group.category,
                          options: group.models.map((model) => ({
                            value: model.id,
                            label: model.name,
                            description: model.description,
                          })),
                        })) as ComboboxGroup[]
                      }
                      direction="up"
                      dropdownWidth="w-56"
                      disabled={creating || runtimeResolving || modelOptions.length === 0}
                      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <ModelIcon className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[9rem] sm:max-w-none">
                        {formatModelNameLower(selectedModel)}
                      </span>
                    </Combobox>

                    {/* Reasoning effort pills */}
                    <ReasoningEffortPills
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      onSelect={setReasoningEffort}
                      disabled={creating || runtimeResolving}
                      options={runtimeEffortOptions}
                    />

                    <SessionSkillSelector
                      value={skillSelection}
                      onChange={setSkillSelection}
                      target={skillPreviewTarget}
                      preview={skillPreview}
                      previewLoading={skillPreviewLoading}
                      disabled={creating}
                    />

                    <VisualVerificationToggle
                      checked={visualVerificationRequested}
                      onChange={setVisualVerificationRequested}
                      available={visualVerificationAvailable}
                      disabled={creating}
                    />
                  </div>

                  {/* Right side - Agent label */}
                  <span className="hidden sm:inline text-sm text-muted-foreground">
                    build agent
                  </span>
                </div>
              </div>

              {/* Secrets disclosure per session target (design §7.4) */}
              {sessionTarget?.kind === "environment" && (
                <p className="mt-3 text-xs text-muted-foreground text-center">
                  Sessions from this environment use global secrets plus the environment&apos;s
                  secrets.
                </p>
              )}
              {sessionTarget?.kind === "repos" && (
                <p className="mt-3 text-xs text-muted-foreground text-center">
                  Ad-hoc sessions use global secrets plus the selected repositories&apos; secrets,
                  and don&apos;t get prebuilt images —{" "}
                  <Link href="/settings?tab=environments" className="text-accent hover:underline">
                    save this set as an environment
                  </Link>
                  .
                </p>
              )}

              {selectedRepo && (
                <div className="mt-3 text-center">
                  <Link
                    href="/settings"
                    className="text-xs text-muted-foreground hover:text-foreground transition"
                  >
                    Manage secrets and settings
                  </Link>
                </div>
              )}

              {repos.length === 0 && !loadingRepos && (
                <p className="mt-3 text-sm text-muted-foreground text-center">
                  No repositories found. You can start without a repository or grant repository
                  access in settings.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
