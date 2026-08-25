import app from "./app";
import { consumeFeishuCompletions } from "./completion/consumer";

export default {
  fetch: app.fetch,
  queue: consumeFeishuCompletions,
};
