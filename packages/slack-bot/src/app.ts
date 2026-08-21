import { Hono } from "hono";
import { callbacksRouter } from "./callbacks";
import { threadContextRoutes } from "./routes/thread-context";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { interactionRoutes } from "./routes/interactions";
import { commandRoutes } from "./routes/commands";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.route("/", healthRoutes);
app.route("/", eventRoutes);
app.route("/", interactionRoutes);
app.route("/", commandRoutes);
app.route("/callbacks", callbacksRouter);
app.route("/", threadContextRoutes);

export default app;
