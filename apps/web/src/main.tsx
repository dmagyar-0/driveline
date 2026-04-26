import "./styles/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  isWebCodecsSupported,
  renderUnsupportedSplash,
} from "./unsupportedSplash";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

if (!isWebCodecsSupported()) {
  renderUnsupportedSplash(root);
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
