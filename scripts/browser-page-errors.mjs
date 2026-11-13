const webkitBlockedFetchMessage = /^\/(?<host>[^/\s]+)\/\S* due to access control checks\.$/u;

function blockedSameOriginFetch(page, message) {
  const host = webkitBlockedFetchMessage.exec(message)?.groups?.host;
  if (!host) return false;
  try {
    const url = new URL(page.url());
    return url.port !== "" && url.host === host;
  } catch {
    return false;
  }
}

export function watchPageErrors(page, onError) {
  let replacing;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) replacing = request;
  });
  page.on("requestfailed", (request) => {
    if (request === replacing) replacing = undefined;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) replacing = undefined;
  });
  page.on("pageerror", (error) => {
    if (replacing && blockedSameOriginFetch(page, error.message)) return;
    onError(error);
  });
}

export function collectPageErrors(page, errors = []) {
  watchPageErrors(page, (error) => errors.push(error.message));
  return errors;
}
