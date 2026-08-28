import type { ReactNode } from "react";
import {
  evaluateGovernedActionGate,
  type GovernedActionGateInput,
} from "../accessibility/governed-action.js";
import { ModalDialog } from "./overlays.js";
import { ActionButton, Banner, RiskIndicator } from "./primitives.js";

export interface GovernedActionDialogProps extends GovernedActionGateInput {
  readonly acknowledgementLabel: string;
  readonly blockerLabels: Readonly<Record<string, string>>;
  readonly cancelLabel: string;
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly confirmLabel: string;
  readonly onAcknowledgementChange: (acknowledged: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly riskLabel: string;
  readonly title: ReactNode;
  readonly unavailableTitle: string;
}

export function GovernedActionDialog({
  acknowledgementLabel,
  blockerLabels,
  cancelLabel,
  children,
  closeLabel,
  confirmLabel,
  onAcknowledgementChange,
  onCancel,
  onConfirm,
  open,
  riskLabel,
  title,
  unavailableTitle,
  ...gateInput
}: GovernedActionDialogProps) {
  const gate = evaluateGovernedActionGate(gateInput);
  return (
    <ModalDialog closeLabel={closeLabel} onClose={onCancel} open={open} title={title}>
      <RiskIndicator label={riskLabel} level={gateInput.risk} />
      {children}
      {gate.blockers.length > 0 ? (
        <Banner title={unavailableTitle} tone="warning">
          <ul>
            {gate.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabels[blocker] ?? blocker}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <label className="acknowledgement">
        <input
          checked={gateInput.acknowledged}
          onChange={(event) => onAcknowledgementChange(event.target.checked)}
          type="checkbox"
        />
        <span>{acknowledgementLabel}</span>
      </label>
      <div className="actions">
        <ActionButton onClick={onCancel} variant="secondary">
          {cancelLabel}
        </ActionButton>
        <ActionButton
          disabled={!gate.allowed}
          onClick={() => {
            if (evaluateGovernedActionGate(gateInput).allowed) onConfirm();
          }}
          variant={gateInput.destructive ? "danger" : "primary"}
        >
          {confirmLabel}
        </ActionButton>
      </div>
    </ModalDialog>
  );
}
