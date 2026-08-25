import { Hono } from "hono";
import type { Env } from "../types";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/healthz", (c) => c.json({ ok: true, service: "feishu-bot" }));
