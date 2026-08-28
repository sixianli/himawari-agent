import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { evaluateGovernedActionGate } from "../src/accessibility/governed-action.js";
import {
  ActionButton,
  ActionMenu,
  DataTable,
  DiffView,
  Field,
  type FieldProps,
  GovernedActionDialog,
  type GovernedActionDialogProps,
  nextRovingIndex,
  RiskIndicator,
  SemanticList,
  StatusRegion,
  Tabs,
  ThrottledStatusRegion,
  VirtualizedList,
} from "../src/components/index.js";

describe("semantic control-center components", () => {
  it("renders native controls with accessible name, description and state", () => {
    const fieldProps: FieldProps = {
      children: h("input"),
      error: "Required",
      hint: "Stable ID",
      label: "Thread ID",
      required: true,
    };
    const markup = renderToStaticMarkup(
      h(
        "main",
        null,
        h(ActionButton, { pending: true }, "Save"),
        h(Field, fieldProps),
        h(StatusRegion, null, "Accepted"),
        h(ThrottledStatusRegion, null, "Streaming update"),
        h(RiskIndicator, { label: "Critical risk", level: "critical" }),
      ),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Thread ID");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("-hint");
    expect(markup).toContain("-error");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-risk="critical"');
    expect(markup).toContain("‼");
  });

  it("renders table, list, diff and virtualized position semantics", () => {
    const rows = [{ name: "gateway" }];
    const markup = renderToStaticMarkup(
      h(
        "main",
        null,
        h(DataTable<{ name: string }>, {
          caption: "Health components",
          columns: [{ header: "Name", id: "name", render: (row) => row.name }],
          getRowId: (row) => row.name,
          rows,
        }),
        h(SemanticList<string>, {
          empty: "No records",
          getId: (item) => item,
          items: [],
          label: "Records",
          renderItem: (item) => item,
        }),
        h(DiffView, {
          addedLabel: "Added",
          label: "Revision diff",
          lines: [{ id: "line-1", kind: "added", text: "scope:thread" }],
          removedLabel: "Removed",
          unchangedLabel: "Unchanged",
        }),
        h(VirtualizedList<string>, {
          activeIndex: 41,
          getId: (item) => item,
          getLabel: (item) => `Event ${item}`,
          items: ["event-41", "event-42"],
          label: "Events",
          onActiveIndexChange: vi.fn(),
          renderItem: (item) => item,
          totalCount: 200,
          windowStart: 40,
        }),
      ),
    );

    expect(markup).toContain("<caption>Health components</caption>");
    expect(markup).toContain('<th scope="col">Name</th>');
    expect(markup).toContain("No records");
    expect(markup).toContain("Added: ");
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-posinset="41"');
    expect(markup).toContain('aria-setsize="200"');
  });

  it("fixes arrow, Home and End behavior for menus, tabs and virtual lists", () => {
    expect(nextRovingIndex(0, 3, "ArrowLeft", "horizontal")).toBe(2);
    expect(nextRovingIndex(2, 3, "ArrowRight", "horizontal")).toBe(0);
    expect(nextRovingIndex(1, 3, "ArrowUp", "vertical")).toBe(0);
    expect(nextRovingIndex(1, 3, "ArrowDown", "vertical")).toBe(2);
    expect(nextRovingIndex(1, 3, "Home", "vertical")).toBe(0);
    expect(nextRovingIndex(1, 3, "End", "vertical")).toBe(2);

    const markup = renderToStaticMarkup(
      h(
        "main",
        null,
        h(ActionMenu, {
          items: [{ id: "open", label: "Open", onSelect: vi.fn() }],
          label: "Actions",
        }),
        h(Tabs, {
          activeId: "first",
          label: "Settings",
          onChange: vi.fn(),
          tabs: [
            { id: "first", label: "First", panel: "First panel" },
            { id: "second", label: "Second", panel: "Second panel" },
          ],
        }),
      ),
    );
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tabpanel"');
  });
});

describe("governed action UI gate", () => {
  const allowed = {
    acknowledged: true,
    authorizationRef: "authorization-01",
    currentRevision: 7,
    destructive: true,
    expectedRevision: 7,
    recentAuthenticationRef: "recent-auth-01",
    risk: "critical" as const,
  };

  it("cannot confirm without authorization, recent auth, matching revision and acknowledgement", () => {
    expect(evaluateGovernedActionGate(allowed)).toEqual({ allowed: true, blockers: [] });
    expect(
      evaluateGovernedActionGate({
        ...allowed,
        acknowledged: false,
        authorizationRef: null,
        currentRevision: 8,
        recentAuthenticationRef: null,
      }),
    ).toEqual({
      allowed: false,
      blockers: [
        "authorization_required",
        "recent_authentication_required",
        "revision_conflict",
        "explicit_acknowledgement_required",
      ],
    });
  });

  it("renders every blocker and keeps confirmation disabled", () => {
    const dialogProps: GovernedActionDialogProps = {
      ...allowed,
      acknowledged: false,
      acknowledgementLabel: "I understand",
      authorizationRef: null,
      blockerLabels: {
        authorization_required: "Authorization required",
        explicit_acknowledgement_required: "Acknowledgement required",
        recent_authentication_required: "Recent authentication required",
        revision_conflict: "Revision conflict",
      },
      cancelLabel: "Cancel",
      children: "Review the impact.",
      closeLabel: "Close",
      confirmLabel: "Confirm",
      currentRevision: 8,
      onAcknowledgementChange: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      open: true,
      recentAuthenticationRef: null,
      riskLabel: "Critical",
      title: "Delete permanently",
      unavailableTitle: "Action unavailable",
    };
    const markup = renderToStaticMarkup(h(GovernedActionDialog, dialogProps));
    expect(markup).toContain("Authorization required");
    expect(markup).toContain("Recent authentication required");
    expect(markup).toContain("Revision conflict");
    expect(markup).toContain("Acknowledgement required");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Confirm<\/button>/);
  });
});
