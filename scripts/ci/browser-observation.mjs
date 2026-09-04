const observedTypes = new Set(["document", "script", "stylesheet", "fetch", "xhr", "eventsource"]);

function publicUrl(value) {
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:"
    ? `${url.origin}${url.pathname}`
    : url.protocol;
}

/** Evidence only: listeners never classify a browser failure or alter a request. */
export function createBrowserObservation({ redact = (value) => value, limit = 2000 } = {}) {
  const started = performance.now();
  const pages = new WeakMap();
  const requests = new WeakMap();
  const events = [];
  const errors = [];
  let pageSequence = 0;
  let requestSequence = 0;
  let dropped = 0;
  let droppedErrors = 0;

  const append = (event) => {
    const entry = { timeMs: performance.now() - started, ...event };
    if (events.length < limit) events.push(entry);
    else dropped += 1;
    if (entry.type === "pageerror") {
      if (errors.length < 50) errors.push(entry);
      else droppedErrors += 1;
    }
  };

  function watchPage(page) {
    const existing = pages.get(page);
    if (existing) return existing.id;
    const state = { id: ++pageSequence, epoch: 0 };
    pages.set(page, state);

    const requestEvent = (type, request, status = null) => {
      const resourceType = request.resourceType();
      if (!observedTypes.has(resourceType)) return;
      let identity = requests.get(request);
      if (!identity) {
        identity = {
          requestId: ++requestSequence,
          pageId: state.id,
          // A listener attached after request initiation cannot infer its document.
          epoch: type === "request" ? state.epoch : null,
          url: publicUrl(request.url()),
          method: request.method(),
          resourceType,
        };
        requests.set(request, identity);
      }
      append({
        type,
        ...identity,
        status,
        failure: type === "requestfailed" ? redact(request.failure()?.errorText ?? "") : null,
        message: null,
      });
    };
    page.on("request", (request) => requestEvent("request", request));
    page.on("response", (response) =>
      requestEvent("response", response.request(), response.status()),
    );
    page.on("requestfinished", (request) => requestEvent("requestfinished", request));
    page.on("requestfailed", (request) => requestEvent("requestfailed", request));
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      state.epoch += 1;
      append({
        type: "framenavigated",
        pageId: state.id,
        epoch: state.epoch,
        requestId: null,
        url: publicUrl(frame.url()),
        method: null,
        resourceType: "document",
        status: null,
        failure: null,
        message: null,
      });
    });
    page.on("pageerror", (error) => {
      append({
        type: "pageerror",
        pageId: state.id,
        epoch: state.epoch,
        requestId: null,
        url: publicUrl(page.url()),
        method: null,
        resourceType: null,
        status: null,
        failure: null,
        message: redact(error.message),
      });
    });
    return state.id;
  }

  return {
    watchPage,
    snapshot: () => ({
      schemaVersion: 1,
      events: events.map((entry) => ({ ...entry })),
      dropped,
      errors: errors.map((entry) => ({ ...entry })),
      droppedErrors,
    }),
  };
}
