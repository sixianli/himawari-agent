browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return false;
  browser.runtime.sendNativeMessage("application.id", message).then(
    (reply) => sendResponse(reply),
    () => sendResponse({ phase: "unreachable" }),
  );
  return true;
});
