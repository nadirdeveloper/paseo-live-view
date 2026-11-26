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

export function toneColor(tone: "accent" | "success" | "warning" | "danger" | "muted", theme: Theme): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}
