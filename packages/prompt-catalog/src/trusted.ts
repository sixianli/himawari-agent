import * as activity from "./activity.js";
import * as authorization from "./authorization.js";
import * as background from "./background.js";
import * as chat from "./chat.js";
import { trustedPromptTexts } from "./entry.js";
import * as evaluation from "./eval.js";
import * as inbox from "./inbox.js";
import * as memory from "./memory.js";
import * as perception from "./perception.js";
import * as review from "./review.js";
import * as runtime from "./runtime.js";
import * as subthreads from "./subthreads.js";
import * as tools from "./tools.js";

export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [
    activity,
    authorization,
    background,
    chat,
    evaluation,
    inbox,
    memory,
    perception,
    review,
    runtime,
    subthreads,
    tools,
  ].flatMap((module) => Object.values(module)),
);
