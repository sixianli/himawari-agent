import { useEffect, useRef } from "react";
import type { AvailableModel } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { ActionButton } from "./primitives.js";

export function ModelPicker({
  models,
  modelRef,
  thinkingLevel,
  onModelChange,
  onThinkingChange,
  message,
}: {
  readonly models: readonly AvailableModel[];
  readonly modelRef: string;
  readonly thinkingLevel: string;
  readonly onModelChange: (ref: string) => void;
  readonly onThinkingChange: (level: string) => void;
  readonly message: (id: MessageId) => string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const model = models.find((item) => item.ref === modelRef);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target))
        ref.current.open = false;
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, []);
  return (
    <details
      className="model-picker"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={message("chat.model")} title={message("chat.pendingModel")}>
        <span className="model-name" title={model?.name}>
          {model?.name}
        </span>{" "}
        <span aria-hidden="true">⌄</span>
        <span className="depth-label">{thinkingLevel}</span>
      </summary>
      <div className="model-panel">
        <fieldset>
          <legend>{message("chat.model")}</legend>
          {models.map((item) => (
            <ActionButton
              key={item.ref}
              variant="quiet"
              aria-pressed={modelRef === item.ref}
              onClick={() => onModelChange(item.ref)}
            >
              <span>
                {item.name}
                <small>{item.provider}</small>
              </span>
              <span aria-hidden="true">{modelRef === item.ref ? "✓" : ""}</span>
            </ActionButton>
          ))}
        </fieldset>
        <fieldset>
          <legend>{message("chat.depth")}</legend>
          <div className="depth-choices">
            {(model?.thinkingLevels ?? []).map((level) => (
              <ActionButton
                key={level}
                variant="quiet"
                aria-pressed={thinkingLevel === level}
                onClick={() => onThinkingChange(level)}
              >
                {level}
              </ActionButton>
            ))}
          </div>
        </fieldset>
        <p>{message("chat.pendingModel")}</p>
      </div>
    </details>
  );
}
