export interface ViewportMeasure {
  readonly layoutHeight: number;
  readonly visualHeight: number;
  readonly visualOffsetTop: number;
  readonly scale: number;
}

export interface ViewportState {
  readonly keyboardOpen: boolean;
  readonly height: number;
  readonly shift: number;
}

export const keyboardMinimumHeight = 120;

export function viewportState(measure: ViewportMeasure): ViewportState {
  const covered = measure.layoutHeight - measure.visualHeight - measure.visualOffsetTop;
  const keyboardOpen =
    measure.scale <= 1.01 &&
    measure.layoutHeight - measure.visualHeight >= keyboardMinimumHeight &&
    covered >= -1;
  return {
    keyboardOpen,
    height: keyboardOpen ? Math.round(measure.visualHeight) : Math.round(measure.layoutHeight),
    shift: keyboardOpen ? Math.max(0, Math.round(measure.visualOffsetTop)) : 0,
  };
}

export function installViewportSync(target: Window): () => void {
  const visual = target.visualViewport;
  if (!visual) return () => undefined;
  const root = target.document.documentElement;
  const apply = () => {
    const state = viewportState({
      layoutHeight: target.innerHeight,
      visualHeight: visual.height,
      visualOffsetTop: visual.offsetTop,
      scale: visual.scale,
    });
    if (state.keyboardOpen) {
      root.setAttribute("data-keyboard", "open");
      root.style.setProperty("--app-height", `${state.height}px`);
      root.style.setProperty("--app-shift", `${state.shift}px`);
      if (target.scrollY !== 0) target.scrollTo(0, 0);
      return;
    }
    root.removeAttribute("data-keyboard");
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--app-shift");
  };
  visual.addEventListener("resize", apply);
  visual.addEventListener("scroll", apply);
  apply();
  return () => {
    visual.removeEventListener("resize", apply);
    visual.removeEventListener("scroll", apply);
    root.removeAttribute("data-keyboard");
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--app-shift");
  };
}
