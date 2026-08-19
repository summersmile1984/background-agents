import { defineRoutes, SCM_AGNOSTIC_SANDBOX_ROUTE } from "./shared";

/**
 * Host-side model relays call this endpoint before replacing the per-session
 * sandbox token with a provider credential. Authentication is the entire
 * operation: a 204 means the token still belongs to this session.
 */
export const sessionModelRelayAuthRoutes = defineRoutes(SCM_AGNOSTIC_SANDBOX_ROUTE, [
  {
    method: "POST",
    pattern: /^\/sessions\/(?<id>[^/]+)\/model-relay-auth$/,
    handler: async () => new Response(null, { status: 204 }),
  },
]);
