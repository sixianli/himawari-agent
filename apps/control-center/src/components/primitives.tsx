import {
  type AnchorHTMLAttributes,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";

export type ActionButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly pending?: boolean;
  readonly variant?: ActionButtonVariant;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  {
    children,
    className,
    disabled,
    pending = false,
    type = "button",
    variant = "primary",
    ...props
  },
  ref,
) {
  const classes = ["action-button", `action-button-${variant}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...props}
      aria-busy={pending || undefined}
      className={classes}
      disabled={disabled || pending}
      ref={ref}
      type={type}
    >
      {children}
    </button>
  );
});

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly current?: boolean;
}

export function AppLink({ children, className, current = false, ...props }: AppLinkProps) {
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      className={["app-link", className].filter(Boolean).join(" ")}
    >
      {children}
    </a>
  );
}

interface FieldControlProps {
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: AriaAttributes["aria-invalid"];
  readonly id?: string | undefined;
}

export interface FieldProps {
  readonly children: ReactElement<FieldControlProps>;
  readonly error?: ReactNode;
  readonly hint?: ReactNode;
  readonly label: ReactNode;
  readonly required?: boolean;
}

export function Field({ children, error, hint, label, required = false }: FieldProps) {
  const generatedId = useId();
  const controlId = children.props.id ?? `field-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId]
    .filter(Boolean)
    .join(" ");
  const control = cloneElement(children, {
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error
      ? { "aria-invalid": true }
      : children.props["aria-invalid"] !== undefined
        ? { "aria-invalid": children.props["aria-invalid"] }
        : {}),
    id: controlId,
  });
  return (
    <div className="field">
      <label htmlFor={controlId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {control}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface StatusRegionProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly urgent?: boolean;
}

export function StatusRegion({ children, className, urgent = false }: StatusRegionProps) {
  return (
    <div
      aria-atomic="true"
      aria-live={urgent ? "assertive" : "polite"}
      className={["status-region", className].filter(Boolean).join(" ")}
      role={urgent ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export interface ThrottledStatusRegionProps extends StatusRegionProps {
  readonly intervalMilliseconds?: number;
}

export function ThrottledStatusRegion({
  children,
  intervalMilliseconds = 500,
  ...statusProps
}: ThrottledStatusRegionProps) {
  const [announced, setAnnounced] = useState(children);
  useEffect(() => {
    const boundedInterval = Math.min(2_000, Math.max(100, intervalMilliseconds));
    const timer = window.setTimeout(() => setAnnounced(children), boundedInterval);
    return () => window.clearTimeout(timer);
  }, [children, intervalMilliseconds]);
  return <StatusRegion {...statusProps}>{announced}</StatusRegion>;
}

export interface BannerProps {
  readonly children: ReactNode;
  readonly title: ReactNode;
  readonly tone?: "info" | "warning" | "danger" | "success";
}

export function Banner({ children, title, tone = "info" }: BannerProps) {
  const urgent = tone === "danger";
  return (
    <section
      aria-labelledby={undefined}
      className={`banner banner-${tone}`}
      role={urgent ? "alert" : "status"}
    >
      <strong>{title}</strong>
      <div>{children}</div>
    </section>
  );
}

export interface ToastMessage {
  readonly id: string;
  readonly message: ReactNode;
  readonly tone: "info" | "warning" | "danger" | "success";
}

export interface ToastRegionProps {
  readonly label: string;
  readonly messages: readonly ToastMessage[];
  readonly onDismiss: (id: string) => void;
  readonly dismissLabel: string;
}

export function ToastRegion({ dismissLabel, label, messages, onDismiss }: ToastRegionProps) {
  return (
    <section
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions"
      className="toast-region"
    >
      {messages.map((message) => (
        <output className={`toast toast-${message.tone}`} key={message.id}>
          <span>{message.message}</span>
          <ActionButton
            aria-label={dismissLabel}
            onClick={() => onDismiss(message.id)}
            variant="quiet"
          >
            ×
          </ActionButton>
        </output>
      ))}
    </section>
  );
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskIndicatorProps {
  readonly label: string;
  readonly level: RiskLevel;
}

export function RiskIndicator({ label, level }: RiskIndicatorProps) {
  const symbol =
    level === "critical" ? "‼" : level === "high" ? "!" : level === "medium" ? "◆" : "●";
  return (
    <span className={`risk-indicator risk-${level}`} data-risk={level}>
      <span aria-hidden="true">{symbol}</span>
      <span>{label}</span>
    </span>
  );
}

export interface DiffLine {
  readonly id: string;
  readonly kind: "added" | "removed" | "unchanged";
  readonly text: string;
}

export interface DiffViewProps {
  readonly addedLabel: string;
  readonly label: string;
  readonly lines: readonly DiffLine[];
  readonly removedLabel: string;
  readonly unchangedLabel: string;
}

export function DiffView({
  addedLabel,
  label,
  lines,
  removedLabel,
  unchangedLabel,
}: DiffViewProps) {
  const labels = { added: addedLabel, removed: removedLabel, unchanged: unchangedLabel };
  return (
    <figure aria-label={label} className="diff-view">
      <pre>
        {lines.map((line) => (
          <span className={`diff-line diff-${line.kind}`} key={line.id}>
            <span className="visually-hidden">{labels[line.kind]}: </span>
            <span aria-hidden="true">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "} {line.text}
            </span>
          </span>
        ))}
      </pre>
    </figure>
  );
}
