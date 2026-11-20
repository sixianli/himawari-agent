import * as activity from "./activity.js";
import * as authorization from "./authorization.js";
import * as background from "./background.js";
import * as chat from "./chat.js";
import { trustedPromptTexts } from "./entry.js";
import * as evaluation from "./eval.js";
import * as mail from "./mail.js";
import * as memory from "./memory.js";
import * as perception from "./perception.js";
import * as review from "./review.js";
import * as runtime from "./runtime.js";
import * as think from "./think.js";
import * as tools from "./tools.js";

export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [
    activity,
    authorization,
    background,
    chat,
    evaluation,
    mail,
    memory,
    perception,
    review,
    runtime,
    think,
    tools,
  ].flatMap((module) => Object.values(module)),
);
