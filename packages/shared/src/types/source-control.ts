import { z } from "zod";

export const SOURCE_CONTROL_PROVIDERS = ["github", "gitea", "gitlab", "bitbucket"] as const;
export const sourceControlProviderNameSchema = z.enum(SOURCE_CONTROL_PROVIDERS);
export type SourceControlProviderName = z.infer<typeof sourceControlProviderNameSchema>;

export const SCM_CONNECTION_AUTH_MODES = ["github_app", "pat", "oauth"] as const;
export const scmConnectionAuthModeSchema = z.enum(SCM_CONNECTION_AUTH_MODES);
export type ScmConnectionAuthMode = z.infer<typeof scmConnectionAuthModeSchema>;

export const SCM_CREDENTIAL_SOURCES = ["worker_binding", "encrypted_d1"] as const;
export const scmCredentialSourceSchema = z.enum(SCM_CREDENTIAL_SOURCES);
export type ScmCredentialSource = z.infer<typeof scmCredentialSourceSchema>;

export const SCM_CONNECTION_HEALTH = ["unknown", "healthy", "degraded", "disabled"] as const;
export const scmConnectionHealthSchema = z.enum(SCM_CONNECTION_HEALTH);
export type ScmConnectionHealth = z.infer<typeof scmConnectionHealthSchema>;

export const sourceControlCapabilitiesSchema = z.object({
  listRepositories: z.boolean(),
  listBranches: z.boolean(),
  createPullRequest: z.boolean(),
  draftPullRequest: z.boolean(),
  userOAuth: z.boolean(),
  webhooks: z.boolean(),
  commitSigning: z.boolean(),
  repositoryById: z.boolean(),
});
export type SourceControlCapabilities = z.infer<typeof sourceControlCapabilitiesSchema>;

export const EMPTY_SOURCE_CONTROL_CAPABILITIES: SourceControlCapabilities = Object.freeze({
  listRepositories: false,
  listBranches: false,
  createPullRequest: false,
  draftPullRequest: false,
  userOAuth: false,
  webhooks: false,
  commitSigning: false,
  repositoryById: false,
});

export const sourceControlConnectionSummarySchema = z.object({
  id: z.string().min(1),
  provider: sourceControlProviderNameSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  authMode: scmConnectionAuthModeSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  health: scmConnectionHealthSchema,
  version: z.string().nullable(),
  lastCheckedAt: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.string().nullable(),
  capabilities: sourceControlCapabilitiesSchema,
});
export type SourceControlConnectionSummary = z.infer<typeof sourceControlConnectionSummarySchema>;

export const sourceControlConnectionDetailsSchema = sourceControlConnectionSummarySchema.extend({
  apiBaseUrl: z.string().url(),
  cloneBaseUrl: z.string().url(),
  username: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
  credentialConfigured: z.boolean(),
});
export type SourceControlConnectionDetails = z.infer<typeof sourceControlConnectionDetailsSchema>;

export const sourceControlConnectionProbeSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  checkedAt: z.number().int().nonnegative(),
  version: z.string().nullable(),
  serviceUser: z.string().nullable(),
  visibleRepositoryCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});
export type SourceControlConnectionProbe = z.infer<typeof sourceControlConnectionProbeSchema>;

export const REPOSITORY_RESOLUTION_STATUSES = ["resolved", "unresolved", "removed"] as const;
export const repositoryResolutionStatusSchema = z.enum(REPOSITORY_RESOLUTION_STATUSES);
export type RepositoryResolutionStatus = z.infer<typeof repositoryResolutionStatusSchema>;

export const sourceControlRepositoryIdentitySchema = z.object({
  repositoryKey: z.string().min(1),
  connectionId: z.string().min(1),
  externalId: z.string().min(1).nullable(),
  owner: z.string().min(1),
  name: z.string().min(1),
  resolutionStatus: repositoryResolutionStatusSchema,
});
export type SourceControlRepositoryIdentity = z.infer<typeof sourceControlRepositoryIdentitySchema>;

export const sourceControlRepositoryCatalogItemSchema =
  sourceControlRepositoryIdentitySchema.extend({
    externalId: z.string().min(1),
    resolutionStatus: z.literal("resolved"),
    fullName: z.string().min(1),
    webUrl: z.string().url(),
    cloneUrl: z.string().url(),
    defaultBranch: z.string().min(1),
    private: z.boolean(),
    archived: z.boolean(),
    connection: sourceControlConnectionSummarySchema.pick({
      id: true,
      provider: true,
      displayName: true,
      baseUrl: true,
    }),
  });
export type SourceControlRepositoryCatalogItem = z.infer<
  typeof sourceControlRepositoryCatalogItemSchema
>;
