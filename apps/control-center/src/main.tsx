import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ControlCenterApp } from "./app.js";
import { installQuietScrollbars } from "./quiet-scrollbars.js";
import "./styles.css";
import "./chat-layout.css";
import "./review-v4.css";
import "./proactive.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("CONTROL_CENTER_ROOT_MISSING");
}

installQuietScrollbars(document);

createRoot(root).render(
  <StrictMode>
    <ControlCenterApp />
  </StrictMode>,
);
