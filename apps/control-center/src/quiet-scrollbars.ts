export function installQuietScrollbars(target: Document, hideAfterMilliseconds = 900): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event) => {
    const element =
      event.target instanceof Element ? event.target : (target.scrollingElement ?? undefined);
    if (!element) return;
    element.setAttribute("data-scrolling", "");
    clearTimeout(timers.get(element));
    timers.set(
      element,
      setTimeout(() => {
        element.removeAttribute("data-scrolling");
        timers.delete(element);
      }, hideAfterMilliseconds),
    );
  };
  target.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    target.removeEventListener("scroll", onScroll, { capture: true });
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
