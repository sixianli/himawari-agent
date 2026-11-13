const panel = document.querySelector(".panel");
const card = document.querySelector(".card");
const field = document.querySelector(".field");
const note = document.querySelector(".note");
const send = document.querySelector(".send");
const outcome = document.querySelector(".outcome");
const outcomeText = document.querySelector(".outcome-text");
const doneMark = document.querySelector(".done");
const followUp = document.querySelector(".follow-up");

let page = null;
let words = {};

const ask = (message) =>
  browser.runtime.sendMessage(message).then(
    (reply) => reply ?? { phase: "unreachable" },
    () => ({ phase: "unreachable" }),
  );

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function applyWords() {
  for (const element of document.querySelectorAll("[data-word]")) {
    element.textContent = words[element.dataset.word] ?? "";
  }
  field.placeholder = words["sheet.placeholder"] ?? "";
  document.title = words["sheet.title"] ?? "";
}

function showEditing() {
  panel.dataset.phase = "editing";
  card.hidden = false;
  field.hidden = false;
  note.hidden = false;
  send.hidden = false;
  outcome.hidden = true;
  card.querySelector(".card-title").textContent = page.title || hostOf(page.url) || page.url;
  card.querySelector(".card-subtitle").textContent = [hostOf(page.url), words["sheet.fullPage"]]
    .filter(Boolean)
    .join(" · ");
}

function showOutcome(reply) {
  panel.dataset.phase = reply.phase;
  field.hidden = true;
  send.hidden = true;
  card.hidden = page === null;
  note.hidden = page === null;
  outcome.hidden = false;
  doneMark.toggleAttribute("hidden", reply.done !== true);
  outcomeText.textContent =
    reply.phase === "unreachable" ? browser.i18n.getMessage("unreachable") : (reply.line ?? "");
  followUp.hidden = !(reply.button && reply.link);
  followUp.textContent = reply.button ?? "";
  followUp.onclick = () => {
    browser.tabs.create({ url: reply.link });
    window.close();
  };
  if (typeof reply.closeAfterMs === "number") setTimeout(() => window.close(), reply.closeAfterMs);
}

async function readPage() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page.js"],
    });
    const value = result?.result;
    return value && typeof value.url === "string" && /^https?:/iu.test(value.url) ? value : null;
  } catch {
    return null;
  }
}

send.addEventListener("click", async () => {
  send.disabled = true;
  field.disabled = true;
  send.textContent = words["sheet.sending"] ?? "";
  panel.dataset.phase = "sending";
  showOutcome(await ask({ kind: "hand", page, request: field.value }));
});

const [opening, readResult] = await Promise.all([ask({ kind: "open" }), readPage()]);
words = opening.words ?? {};
applyWords();
page = readResult;
if (opening.phase !== "editing") showOutcome(opening);
else if (page === null) showOutcome(await ask({ kind: "hand", page: null }));
else showEditing();
