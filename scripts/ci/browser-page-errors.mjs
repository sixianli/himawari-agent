const webKitCancelledApiFetch =
  /^(?:(?:Fetch API|EventSource) cannot load https?:\/)?\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\/\S+ due to access control checks\.$/;

export function isWebKitCancelledApiFetch(message) {
  return webKitCancelledApiFetch.test(message);
}
