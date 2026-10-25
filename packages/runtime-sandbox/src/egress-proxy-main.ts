import { openNetworkEgress } from "./network-egress.ts";

const [deadlineText, portText] = process.argv.slice(2);
const deadlineEpoch = Number(deadlineText);
const port = Number(portText);
const token = process.env["HIMAWARI_EGRESS_TOKEN"] ?? "";
const targets = (process.env["HIMAWARI_EGRESS_TARGETS"] ?? "").split(",").filter(Boolean);
if (
  !Number.isInteger(deadlineEpoch) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  targets.length === 0
) {
  process.stderr.write("EGRESS_ARGUMENTS_INVALID\n");
  process.exit(2);
}

const egress = await openNetworkEgress(targets, async () => {}, { host: "0.0.0.0", port, token });
let finishing = false;
function finish() {
  if (finishing) return;
  finishing = true;
  void egress.close().finally(() => process.exit(0));
}
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
function checkDeadline() {
  if (Date.now() / 1000 >= deadlineEpoch) finish();
  else setTimeout(checkDeadline, 1000);
}
checkDeadline();
