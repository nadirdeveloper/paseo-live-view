/** Which Lucide icon and colour tone to show for a file or folder. */
export type Tone = "accent" | "success" | "warning" | "danger" | "muted";
export type IconChoice = { icon: string; tone: Tone };

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "Cargo.lock", "poetry.lock"]);

const BY_EXTENSION: Record<string, IconChoice> = {
  js: { icon: "FileCode", tone: "warning" },
  jsx: { icon: "FileCode", tone: "warning" },
  mjs: { icon: "FileCode", tone: "warning" },
  cjs: { icon: "FileCode", tone: "warning" },
  ts: { icon: "FileCode", tone: "accent" },
  tsx: { icon: "FileCode", tone: "accent" },
  py: { icon: "FileCode", tone: "success" },
  json: { icon: "Braces", tone: "warning" },
  yaml: { icon: "Settings", tone: "muted" },
  yml: { icon: "Settings", tone: "muted" },
  toml: { icon: "Settings", tone: "muted" },
  css: { icon: "Paintbrush", tone: "accent" },
  scss: { icon: "Paintbrush", tone: "danger" },
  html: { icon: "CodeXml", tone: "danger" },
  htm: { icon: "CodeXml", tone: "danger" },
  md: { icon: "FileText", tone: "accent" },
  txt: { icon: "FileText", tone: "muted" },
  png: { icon: "Image", tone: "success" },
  jpg: { icon: "Image", tone: "success" },
  jpeg: { icon: "Image", tone: "success" },
  gif: { icon: "Image", tone: "success" },
  svg: { icon: "Image", tone: "warning" },
  ico: { icon: "Image", tone: "success" },
  sh: { icon: "SquareTerminal", tone: "success" },
  bash: { icon: "SquareTerminal", tone: "success" },
  zsh: { icon: "SquareTerminal", tone: "success" },
};

export function fileIcon(name: string): IconChoice {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (LOCKFILES.has(base)) return { icon: "Lock", tone: "muted" };
  if (base === ".gitignore" || base.startsWith(".env")) return { icon: "Settings", tone: "muted" };
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { icon: "File", tone: "muted" };
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? { icon: "File", tone: "muted" };
}

export function folderIcon(open: boolean): IconChoice {
  return { icon: open ? "FolderOpen" : "Folder", tone: "accent" };
}
