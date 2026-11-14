const panel = document.querySelector(".panel");
const card = document.querySelector(".card");
const field = document.querySelector(".field");
const note = document.querySelector(".note");
const send = document.querySelector(".send");
const sentRequest = document.querySelector(".sent-request");
const outcome = document.querySelector(".outcome");
const outcomeText = document.querySelector(".outcome-text");
const doneMark = document.querySelector(".done");
const followUp = document.querySelector(".follow-up");

let page = null;
let textRead = false;
let kept = true;
let words = {};

const ask = (message) =>
  browser.runtime.sendMessage(message).then(
    (reply) => reply ?? { phase: "unreachable" },
    () => ({ phase: "unreachable" }),
  );

const isWebAddress = (url) => typeof url === "string" && /^https?:/iu.test(url);

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

function showCard() {
  card.hidden = page === null;
  if (page === null) return;
  card.querySelector(".card-title").textContent = page.title || hostOf(page.url) || page.url;
  card.querySelector(".card-subtitle").textContent = !textRead
    ? words["sheet.textUnreadable"]
    : [hostOf(page.url), kept ? words["sheet.fullPage"] : ""].filter(Boolean).join(" · ");
}

function showEditing() {
  panel.dataset.phase = "editing";
  showCard();
  field.hidden = false;
  note.hidden = false;
  note.textContent = words[textRead ? "sheet.note.page" : "sheet.note.urlOnly"] ?? "";
  send.hidden = false;
  send.textContent = words[textRead ? "sheet.send" : "sheet.sendUrl"] ?? "";
  outcome.hidden = true;
}

function showOutcome(reply) {
  panel.dataset.phase = reply.phase;
  kept = reply.kept !== false;
  const request = field.value.trim();
  field.hidden = true;
  send.hidden = true;
  showCard();
  note.hidden = page === null || !textRead;
  sentRequest.hidden = !(reply.done === true && request.length > 0);
  sentRequest.textContent = request;
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
  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch {
    return { page: null, textRead: false };
  }
  if (!tab) return { page: null, textRead: false };
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page.js"],
    });
    const value = result?.result;
    if (value && isWebAddress(value.url)) return { page: value, textRead: true };
  } catch {}
  return isWebAddress(tab.url)
    ? { page: { url: tab.url, title: tab.title ?? "", text: "" }, textRead: false }
    : { page: null, textRead: false };
}

field.addEventListener("input", () => {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
});

send.addEventListener("click", async () => {
  send.disabled = true;
  field.disabled = true;
  send.textContent = words["sheet.sending"] ?? "";
  panel.dataset.phase = "sending";
  showOutcome(await ask({ kind: "hand", page, request: field.value }));
});

const [opening, read] = await Promise.all([ask({ kind: "open" }), readPage()]);
words = opening.words ?? {};
applyWords();
page = read.page;
textRead = read.textRead;
if (opening.phase !== "editing") showOutcome(opening);
else if (page === null) showOutcome(await ask({ kind: "hand", page: null }));
else showEditing();
