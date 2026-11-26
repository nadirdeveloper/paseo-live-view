import { expect, test } from "vitest";
import { fileIcon, folderIcon } from "./icons";

test("code files", () => {
  expect(fileIcon("script.js")).toEqual({ icon: "FileCode", tone: "warning" });
  expect(fileIcon("a.ts")).toEqual({ icon: "FileCode", tone: "accent" });
});

test("data, styles, pages, docs, images, shell and lockfiles", () => {
  expect(fileIcon("package.json").icon).toBe("Braces");
  expect(fileIcon("styles.css").icon).toBe("Paintbrush");
  expect(fileIcon("index.html").icon).toBe("CodeXml");
  expect(fileIcon("README.md").icon).toBe("FileText");
  expect(fileIcon("logo.png").icon).toBe("Image");
  expect(fileIcon("a.svg").icon).toBe("Image");
  expect(fileIcon("run.sh").icon).toBe("SquareTerminal");
  expect(fileIcon("pnpm-lock.yaml").icon).toBe("Lock");
});

test("unknown files get a plain icon", () => {
  expect(fileIcon("Makefile")).toEqual({ icon: "File", tone: "muted" });
});

test("folders", () => {
  expect(folderIcon(true).icon).toBe("FolderOpen");
  expect(folderIcon(false).icon).toBe("Folder");
});
