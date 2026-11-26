import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";

export type Theme = PluginTheme;

export const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
