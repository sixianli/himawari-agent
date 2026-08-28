import { useCallback, useEffect, useState } from "react";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "./control-center-inventory.js";

export type ControlCenterSurfaceId = (typeof CONTROL_CENTER_SURFACE_INVENTORY)[number]["id"];
export type ControlCenterMobileView = "list" | "content" | "details";

export interface ControlCenterRouteState {
  readonly afterCursor: string | null;
  readonly objectId: string | null;
  readonly status: string | null;
  readonly surfaceId: ControlCenterSurfaceId;
  readonly view: ControlCenterMobileView;
}

export type ControlCenterRouteMatch =
  | { readonly kind: "matched"; readonly state: ControlCenterRouteState }
  | { readonly kind: "not_found"; readonly pathname: string };

const MACHINE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS_VALUE = /^[a-z][a-z0-9_-]{0,63}$/;
const routeBySurface = new Map(
  CONTROL_CENTER_SURFACE_INVENTORY.map((surface) => [surface.id, surface.route]),
);
const surfaceByRoute = [...routeBySurface.entries()].sort(
  (left, right) => right[1].length - left[1].length,
);

function valueOrNull(value: string | null, pattern: RegExp): string | null {
  return value && pattern.test(value) ? value : null;
}

export function parseControlCenterUrl(input: string | URL): ControlCenterRouteMatch {
  const url = typeof input === "string" ? new URL(input, "https://control-center.invalid") : input;
  if (url.pathname === "/") {
    return {
      kind: "matched",
      state: {
        afterCursor: valueOrNull(url.searchParams.get("cursor"), MACHINE_VALUE),
        objectId: valueOrNull(url.searchParams.get("selected"), MACHINE_VALUE),
        status: valueOrNull(url.searchParams.get("status"), STATUS_VALUE),
        surfaceId: "threads",
        view: readView(url.searchParams.get("view")),
      },
    };
  }
  for (const [surfaceId, route] of surfaceByRoute) {
    if (url.pathname !== route && !url.pathname.startsWith(`${route}/`)) continue;
    const suffix = url.pathname.slice(route.length).replace(/^\//, "");
    let objectId: string | null = null;
    if (suffix) {
      try {
        objectId = valueOrNull(decodeURIComponent(suffix), MACHINE_VALUE);
      } catch {
        return { kind: "not_found", pathname: url.pathname };
      }
      if (!objectId || suffix.includes("/")) return { kind: "not_found", pathname: url.pathname };
    }
    return {
      kind: "matched",
      state: {
        afterCursor: valueOrNull(url.searchParams.get("cursor"), MACHINE_VALUE),
        objectId: objectId ?? valueOrNull(url.searchParams.get("selected"), MACHINE_VALUE),
        status: valueOrNull(url.searchParams.get("status"), STATUS_VALUE),
        surfaceId,
        view: readView(url.searchParams.get("view")),
      },
    };
  }
  return { kind: "not_found", pathname: url.pathname };
}

function readView(value: string | null): ControlCenterMobileView {
  return value === "list" || value === "details" ? value : "content";
}

export function controlCenterHref(state: ControlCenterRouteState): string {
  const route = routeBySurface.get(state.surfaceId);
  if (!route) throw new Error("CONTROL_CENTER_ROUTE_INVALID");
  const pathname = state.objectId ? `${route}/${encodeURIComponent(state.objectId)}` : route;
  const search = new URLSearchParams();
  if (state.afterCursor) search.set("cursor", state.afterCursor);
  if (state.status) search.set("status", state.status);
  if (state.view !== "content") search.set("view", state.view);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function routeForSurface(
  surfaceId: ControlCenterSurfaceId,
  current?: Partial<ControlCenterRouteState>,
): ControlCenterRouteState {
  return {
    afterCursor: current?.afterCursor ?? null,
    objectId: current?.objectId ?? null,
    status: current?.status ?? null,
    surfaceId,
    view: current?.view ?? "content",
  };
}

function readCurrentControlCenterUrl(): ControlCenterRouteMatch {
  return parseControlCenterUrl(window.location.href);
}

export function useControlCenterRouter() {
  const [match, setMatch] = useState<ControlCenterRouteMatch>(readCurrentControlCenterUrl);
  useEffect(() => {
    const onPopState = () => setMatch(readCurrentControlCenterUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((state: ControlCenterRouteState, replace = false) => {
    const href = controlCenterHref(state);
    window.history[replace ? "replaceState" : "pushState"](null, "", href);
    setMatch({ kind: "matched", state });
  }, []);
  return { match, navigate };
}
