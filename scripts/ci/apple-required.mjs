const needs = JSON.parse(process.env.APPLE_NEEDS ?? "{}");
const result = (job) => needs[job]?.result ?? "missing";

if (result("changes") !== "success") {
  console.error(`APPLE_REQUIRED_FAILED changes=${result("changes")}`);
  process.exit(1);
}
const client = needs.changes.outputs?.client === "true";
if (client) {
  const failed = ["iphone", "mac"].filter((job) => result(job) !== "success");
  if (failed.length > 0) {
    console.error(
      `APPLE_REQUIRED_FAILED ${failed.map((job) => `${job}=${result(job)}`).join(" ")}`,
    );
    process.exit(1);
  }
}
console.log(`APPLE_REQUIRED_PASSED client=${client}`);
