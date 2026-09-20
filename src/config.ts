import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PixieConfig } from "./types.js";

/** Where Pixie keeps its setup file. Override with PIXIE_HOME for tests. */
export const PIXIE_HOME = process.env.PIXIE_HOME
  ? resolve(process.env.PIXIE_HOME)
  : join(homedir(), ".pixie");

export const CONFIG_PATH = join(PIXIE_HOME, "config.json");

export function loadConfig(): PixieConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as PixieConfig;
    if (!raw?.provider?.model || !raw?.workspace) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: PixieConfig): void {
  mkdirSync(PIXIE_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
