const webkitCancelledFetchMessage = / due to access control checks\.$/u;

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
    if (replacing && webkitCancelledFetchMessage.test(error.message)) return;
    onError(error);
  });
}

export function collectPageErrors(page, errors = []) {
  watchPageErrors(page, (error) => errors.push(error.message));
  return errors;
}
