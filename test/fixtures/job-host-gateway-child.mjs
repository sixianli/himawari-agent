process.stderr.write("child-ready\n");
const keepAlive = setInterval(() => {}, 1000);
process.on("message", (message) => {
  if (message?.type === "ping")
    process.send({ type: "pong", pid: process.pid, uid: process.getuid(), echo: message.echo });
  if (message?.type === "exit") {
    clearInterval(keepAlive);
    process.exit(3);
  }
});
process.on("disconnect", () => {
  if (process.argv.includes("--ignore-disconnect")) return;
  clearInterval(keepAlive);
  process.exit(0);
});
