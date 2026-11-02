import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { AvailableModel } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { LineIcon } from "./answer-footer.js";
import { Glyph } from "./glyphs.js";
import { ActionButton } from "./primitives.js";

const PRIMARY_MODEL_COUNT = 3;
const SEARCH_THRESHOLD = 8;

const TIER_MESSAGES = {
  low: "chat.priceTier.low",
  mid: "chat.priceTier.mid",
  high: "chat.priceTier.high",
} as const satisfies Record<string, MessageId>;

const dollars = (value: number) =>
  value === 0
    ? "0"
    : value >= 10
      ? value.toFixed(0)
      : value >= 1
        ? value.toFixed(2)
        : value.toPrecision(2);

export function defaultThinkingLevel(levels: readonly string[]): string {
  return (
    ["medium", "low"].find((level) => levels.includes(level)) ??
    levels.find((level) => level !== "off") ??
    levels[0] ??
    "off"
  );
}

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
  readonly message: (id: MessageId, values?: Record<string, string | number>) => string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const model = models.find((item) => item.ref === modelRef);
  const levels = model?.thinkingLevels ?? [];
  const label = (level: string) => message(`review.effort.${level}` as MessageId);
  const modelName = (item: AvailableModel | undefined) =>
    item?.automatic ? message("chat.autoModel") : item?.name;
  const expanded =
    showAll || models.findIndex((item) => item.ref === modelRef) >= PRIMARY_MODEL_COUNT;
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? models.filter((item) => `${modelName(item)} ${item.model}`.toLowerCase().includes(needle))
    : models;
  const visible = expanded ? matching : models.slice(0, PRIMARY_MODEL_COUNT);
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
        <span className="model-name">{modelName(model)}</span>
        {levels.length > 1 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="depth-label">{label(thinkingLevel)}</span>
          </>
        ) : null}
        <span className="model-picker-chevron">
          <LineIcon name="chevron" />
        </span>
      </summary>
      <div className="model-panel">
        {choosing && models.length > 1 ? (
          <>
            <ActionButton variant="quiet" onClick={() => setChoosing(false)}>
              {message("chat.model")}
            </ActionButton>
            {expanded && models.length > SEARCH_THRESHOLD ? (
              <input
                className="model-search"
                type="search"
                value={query}
                placeholder={message("chat.searchModels")}
                aria-label={message("chat.searchModels")}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
            <div className="model-options">
              {visible.map((item) => (
                <ActionButton
                  key={item.ref}
                  variant="quiet"
                  aria-pressed={item.ref === modelRef}
                  onClick={() => {
                    onModelChange(item.ref);
                    setChoosing(false);
                  }}
                >
                  <span className="model-option-text">
                    <span className="model-option-name">{modelName(item)}</span>
                    {item.automatic ? (
                      <span className="model-option-price">{message("chat.autoModelHint")}</span>
                    ) : item.price ? (
                      <span className="model-option-price">
                        {message("chat.priceLine", {
                          input: `$${dollars(item.price.input)}`,
                          output: `$${dollars(item.price.output)}`,
                        })}
                      </span>
                    ) : null}
                  </span>
                  {item.priceTier ? (
                    <span className="model-tag" data-tier={item.priceTier}>
                      {message(TIER_MESSAGES[item.priceTier])}
                    </span>
                  ) : null}
                  {item.ref === modelRef ? <Glyph name="check" size={14} /> : null}
                </ActionButton>
              ))}
              {visible.length === 0 ? (
                <p className="effort-description">{message("chat.noModelMatch")}</p>
              ) : null}
              {!expanded && models.length > PRIMARY_MODEL_COUNT ? (
                <ActionButton
                  className="model-more"
                  variant="quiet"
                  onClick={() => setShowAll(true)}
                >
                  {message("chat.moreModels", { count: models.length - PRIMARY_MODEL_COUNT })}
                </ActionButton>
              ) : null}
            </div>
            {models.some((item) => item.priceTier) ? (
              <p className="picker-footer">{message("chat.priceNote")}</p>
            ) : null}
          </>
        ) : (
          <>
            {models.length > 1 ? (
              <ActionButton
                className="picker-model-name"
                variant="quiet"
                onClick={() => {
                  setQuery("");
                  setChoosing(true);
                }}
              >
                {modelName(model)}
                <Glyph name="down" size={14} />
              </ActionButton>
            ) : (
              <div className="picker-model-name">{modelName(model)}</div>
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
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
