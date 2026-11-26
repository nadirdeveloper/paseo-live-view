import { expect, test } from "vitest";
import { buildTree } from "./fileTree";

test("folders come first, then files, each A to Z, with absolute paths", () => {
  const tree = buildTree(["b.txt", "a/z.js", "a/y.js", "c/d/e.md"], "/w");
  expect(tree.map((n) => n.name)).toEqual(["a", "c", "b.txt"]);
  expect(tree[0].children?.map((n) => n.name)).toEqual(["y.js", "z.js"]);
  expect(tree[0].path).toBe("/w/a");
  expect(tree[1].children?.[0].children?.[0]).toEqual({ name: "e.md", path: "/w/c/d/e.md" });
  expect(tree[2]).toEqual({ name: "b.txt", path: "/w/b.txt" });
});

test("an empty list gives an empty tree", () => {
  expect(buildTree([], "/w")).toEqual([]);
});
