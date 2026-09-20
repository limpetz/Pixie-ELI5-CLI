#!/usr/bin/env node
import { runRepl } from "./ui.js";

runRepl().catch((err) => {
  console.error("Pixie crashed unexpectedly:", err);
  process.exit(1);
});
