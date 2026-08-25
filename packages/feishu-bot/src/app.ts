import { Hono } from "hono";
import { callbacksRouter } from "./callbacks";
import { cardActionRoutes } from "./routes/card-actions";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.route("/", healthRoutes);
app.route("/", eventRoutes);
app.route("/", cardActionRoutes);
app.route("/callbacks", callbacksRouter);

export default app;
