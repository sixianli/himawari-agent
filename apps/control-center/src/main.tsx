import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ControlCenterApp } from "./app.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("CONTROL_CENTER_ROOT_MISSING");
}

createRoot(root).render(
  <StrictMode>
    <ControlCenterApp />
  </StrictMode>,
);
