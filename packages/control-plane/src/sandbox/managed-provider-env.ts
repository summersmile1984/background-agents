const CONTROL_PLANE_OAUTH_KEYS = new Set([
  "OPENAI_OAUTH_REFRESH_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "OPENAI_OAUTH_ACCOUNT_ID",
  "OPENAI_OAUTH_MANAGED",
  "XAI_OAUTH_REFRESH_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "XAI_OAUTH_MANAGED",
]);

/** Native harness login material must never be baked into a reusable repository image. */
const HARNESS_CREDENTIAL_KEYS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT",
  "CODEX_AUTH_JSON",
  "CODEX_ACCESS_TOKEN",
  "CODEX_ACCESS_TOKEN_EXPIRES_AT",
]);

interface ManagedProviderEnvOptions {
  exposedSecrets: Record<string, string>;
  brokerSecrets: Record<string, string>;
}

export function prepareManagedProviderEnv({
  exposedSecrets,
  brokerSecrets,
}: ManagedProviderEnvOptions): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(exposedSecrets).filter(([key]) => !CONTROL_PLANE_OAUTH_KEYS.has(key))
  );
  if (brokerSecrets.OPENAI_OAUTH_REFRESH_TOKEN) env.OPENAI_OAUTH_MANAGED = "1";
  if (brokerSecrets.XAI_OAUTH_REFRESH_TOKEN) env.XAI_OAUTH_MANAGED = "1";
  return env;
}

export function stripHarnessCredentialsForImageBuild(
  environment: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !HARNESS_CREDENTIAL_KEYS.has(key))
  );
}
