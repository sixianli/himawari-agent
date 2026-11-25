import * as background from "./background.js";
import * as chat from "./chat.js";
import { trustedPromptTexts } from "./entry.js";
import * as evaluation from "./eval.js";
import * as memory from "./memory.js";
import * as perception from "./perception.js";
import * as review from "./review.js";
import * as runtime from "./runtime.js";
import * as tools from "./tools.js";

export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
  [background, chat, evaluation, memory, perception, review, runtime, tools].flatMap(
    (module) => Object.values(module),
  ),
);
