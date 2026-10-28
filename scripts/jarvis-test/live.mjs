const key = process.env["AI_GATEWAY_API_KEY"];
if (!key || key.trim().length === 0) {
  console.error(
    "JARVIS_LIVE_KEY_REQUIRED：真模型层需要环境变量 AI_GATEWAY_API_KEY（单独的低额度 AI Gateway 密钥）。",
  );
  process.exit(2);
}
console.error(
  "JARVIS_LIVE_NOT_IMPLEMENTED：真模型层在第二个 PR 里实现，现在只有确定性层（npm run eval:jarvis）。",
);
process.exit(2);
