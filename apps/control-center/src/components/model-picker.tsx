import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  const [choosing, setChoosing] = useState(false);
  const model = models.find((item) => item.ref === modelRef);
  const levels = model?.thinkingLevels ?? [];
  const label = (level: string) => message(`review.effort.${level}` as MessageId);
  const index = Math.max(0, levels.indexOf(thinkingLevel));
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !event.composedPath().includes(ref.current)
      ) {
        ref.current.open = false;
        setChoosing(false);
      }
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);
  return (
    <details
      className="model-picker"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          setChoosing(false);
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={message("chat.model")}>
        <span className="model-name">{model?.name}</span>
        {levels.length > 1 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="depth-label">{label(thinkingLevel)}</span>
          </>
        ) : null}
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="model-panel">
        {choosing && models.length > 1 ? (
          <>
            <ActionButton variant="quiet" onClick={() => setChoosing(false)}>
              {message("chat.model")}
            </ActionButton>
            <div className="model-options">
              {models.map((item) => (
                <ActionButton
                  key={item.ref}
                  variant="quiet"
                  aria-pressed={item.ref === modelRef}
                  onClick={() => {
                    onModelChange(item.ref);
                    setChoosing(false);
                  }}
                >
                  <span>{item.name}</span>
                  {item.ref === modelRef ? "✓" : null}
                </ActionButton>
              ))}
            </div>
          </>
        ) : (
          <>
            {models.length > 1 ? (
              <ActionButton
                className="picker-model-name"
                variant="quiet"
                onClick={() => setChoosing(true)}
              >
                {model?.name} ⌄
              </ActionButton>
            ) : (
              <div className="picker-model-name">{model?.name}</div>
            )}
            {levels.length > 1 ? (
              <>
                <div
                  className="effort-track"
                  style={
                    {
                      "--effort-progress": `${(index / (levels.length - 1)) * 100}%`,
                    } as CSSProperties
                  }
                >
                  <input
                    type="range"
                    min={0}
                    max={levels.length - 1}
                    step={1}
                    value={index}
                    aria-label={message("chat.depth")}
                    aria-valuetext={label(thinkingLevel)}
                    onChange={(event) => {
                      const level = levels[Number(event.target.value)];
                      if (level) onThinkingChange(level);
                    }}
                  />
                  <div className="effort-marks" aria-hidden="true">
                    {levels.map((level, i) => (
                      <i key={level} className={i === index ? "selected" : ""} />
                    ))}
                  </div>
                </div>
                <div className="effort-labels" aria-hidden="true">
                  {levels.map((level, i) => (
                    <span key={level} className={i === index ? "selected" : ""}>
                      {label(level)}
                    </span>
                  ))}
                </div>
                <p className="effort-description">
                  {message(`review.effortDescription.${thinkingLevel}` as MessageId)}
                </p>
              </>
            ) : (
              <p className="effort-description">{message("review.effortUnavailable")}</p>
            )}
            <p className="picker-footer">↳ {message("chat.pendingModel")}</p>
          </>
        )}
      </div>
    </details>
  );
}
