export function runnerTracking(source = process.env) {
  const id = source.RUNNER_TRACKING_ID;
  return typeof id === "string" && id !== "" ? { RUNNER_TRACKING_ID: id } : {};
}
