import React from "react";
import App from "./App.jsx";
import "./index.css";

import { createRoot } from "react-dom/client";
const container = document.getElementById("root");
if (!container) throw new Error("No root element found");
const root = createRoot(container); // createRoot(container!) if you use TypeScript
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
