export type TreeNode = { name: string; path: string; children?: TreeNode[] };

type Draft = { name: string; path: string; dirs: Map<string, Draft>; files: TreeNode[] };

function finalize(draft: Draft): TreeNode[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const dirs = [...draft.dirs.values()].sort(byName).map((d) => ({ name: d.name, path: d.path, children: finalize(d) }));
  return [...dirs, ...draft.files.sort(byName)];
}

/** Nested tree from POSIX paths relative to `root`; folders first, then files, A to Z. */
export function buildTree(paths: string[], root: string): TreeNode[] {
  const top: Draft = { name: "", path: root, dirs: new Map(), files: [] };
  for (const relative of paths) {
    const parts = relative.split("/").filter(Boolean);
    let node = top;
    for (const dir of parts.slice(0, -1)) {
      let child = node.dirs.get(dir);
      if (!child) {
        child = { name: dir, path: `${node.path}/${dir}`, dirs: new Map(), files: [] };
        node.dirs.set(dir, child);
      }
      node = child;
    }
    const name = parts[parts.length - 1];
    if (name) node.files.push({ name, path: `${node.path}/${name}` });
  }
  return finalize(top);
}
