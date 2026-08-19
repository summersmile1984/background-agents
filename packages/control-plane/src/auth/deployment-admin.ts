import { UserStore } from "../db/user-store";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

type AdminIdentity =
  | { kind: "user"; value: string }
  | { kind: "github"; value: string }
  | { kind: "email"; value: string };

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function explicitAdminIdentities(value: string | undefined): AdminIdentity[] {
  return csv(value).flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) return [];
    const kind = entry.slice(0, separator).toLowerCase();
    const identityValue = entry.slice(separator + 1).trim();
    if (!identityValue || (kind !== "user" && kind !== "github" && kind !== "email")) return [];
    return [{ kind, value: identityValue.toLowerCase() } as AdminIdentity];
  });
}

function configuredAdminIdentities(env: Env): AdminIdentity[] {
  const explicit = explicitAdminIdentities(env.DEPLOYMENT_ADMIN_IDENTITIES);
  if (explicit.length > 0) return explicit;

  // Personal/single-tenant deployments already configure exact admission
  // identities. Reuse only exact allowlists; domain/org/open admission never
  // grants deployment-admin rights implicitly.
  return [
    ...csv(env.ALLOWED_USERS).map(
      (value): AdminIdentity => ({ kind: "github", value: value.toLowerCase() })
    ),
    ...csv(env.ALLOWED_EMAILS).map(
      (value): AdminIdentity => ({ kind: "email", value: value.toLowerCase() })
    ),
  ];
}

export async function isDeploymentAdmin(
  db: SqlDatabase,
  env: Env,
  userId: string
): Promise<boolean> {
  const configured = configuredAdminIdentities(env);
  if (configured.length === 0) return false;
  if (configured.some((identity) => identity.kind === "user" && identity.value === userId)) {
    return true;
  }

  const userStore = new UserStore(db);
  const [user, identities] = await Promise.all([
    userStore.getUserById(userId),
    userStore.getIdentitiesForUser(userId),
  ]);
  if (
    user?.emailVerified &&
    user.email &&
    configured.some(
      (identity) => identity.kind === "email" && identity.value === user.email!.toLowerCase()
    )
  ) {
    return true;
  }
  return identities.some(
    (identity) =>
      identity.provider === "github" &&
      identity.providerLogin &&
      configured.some(
        (configuredIdentity) =>
          configuredIdentity.kind === "github" &&
          configuredIdentity.value === identity.providerLogin!.toLowerCase()
      )
  );
}
