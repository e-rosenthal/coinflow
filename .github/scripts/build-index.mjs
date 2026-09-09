import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const EXCLUDED = [/^\.github\//, /^README\.md$/, /^index\.html$/, /^file-index\.json$/, /^\.nojekyll$/];
const TEXT_MAX_BYTES = 2_000_000;

const TYPE_LABELS = {
  ".html": "HTML page", ".htm": "HTML page", ".md": "Markdown document",
  ".css": "Stylesheet", ".js": "JavaScript", ".mjs": "JavaScript module",
  ".ts": "TypeScript", ".json": "JSON data", ".csv": "CSV data",
  ".py": "Python script", ".sh": "Shell script", ".yml": "YAML config",
  ".yaml": "YAML config", ".pdf": "PDF document", ".png": "Image",
  ".jpg": "Image", ".jpeg": "Image", ".gif": "Image", ".svg": "Vector image",
  ".txt": "Text file",
};

const VIEWABLE = new Set([".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".txt"]);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const decode = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const tidy = (s) => {
  if (!s) return null;
  const clean = decode(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 200 ? clean.slice(0, 197).trimEnd() + "…" : clean;
};

function describe(file) {
  const ext = path.extname(file).toLowerCase();
  let body = "";
  try {
    if (statSync(file).size > TEXT_MAX_BYTES) return null;
    body = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  if (ext === ".html" || ext === ".htm") {
    return tidy(body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1])
      ?? tidy(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
      ?? tidy(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  }
  if (ext === ".md") {
    const lines = body.split("\n").map((l) => l.trim());
    const para = lines.find((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("<"));
    return tidy(para) ?? tidy(lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, ""));
  }
  if ([".js", ".mjs", ".ts", ".css"].includes(ext)) {
    return tidy(body.match(/\/\*\*?\s*([\s\S]*?)\*\//)?.[1]?.replace(/^\s*\*\s?/gm, ""))
      ?? tidy(body.match(/^\/\/\s*(.+)$/m)?.[1]);
  }
  if ([".py", ".sh", ".yml", ".yaml"].includes(ext)) {
    return tidy(body.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/)?.[1])
      ?? tidy(body.match(/^#(?!!)\s*(.+)$/m)?.[1]);
  }
  return null;
}

const overrides = existsSync("descriptions.json")
  ? JSON.parse(readFileSync("descriptions.json", "utf8"))
  : {};

const files = git("ls-files").split("\n").filter(Boolean)
  .filter((f) => !EXCLUDED.some((re) => re.test(f)));

const entries = files.map((file) => {
  const ext = path.extname(file).toLowerCase();
  return {
    path: file,
    name: path.basename(file),
    ext,
    kind: TYPE_LABELS[ext] ?? (ext ? ext.slice(1).toUpperCase() + " file" : "File"),
    viewable: VIEWABLE.has(ext),
    size: statSync(file).size,
    updated: git("log", "-1", "--format=%cs", "--", file),
    description: overrides[file] ?? describe(file) ?? null,
  };
});

const root = { name: "", path: "", folders: {}, files: [] };
for (const entry of entries) {
  const parts = entry.path.split("/");
  let node = root;
  for (const segment of parts.slice(0, -1)) {
    node.folders[segment] ??= {
      name: segment,
      path: node.path ? `${node.path}/${segment}` : segment,
      folders: {}, files: [],
    };
    node = node.folders[segment];
  }
  node.files.push(entry);
}

const toTree = (node) => ({
  name: node.name,
  path: node.path,
  folders: Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name)).map(toTree),
  files: node.files.sort((a, b) => a.name.localeCompare(b.name)),
});

const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "e-rosenthal/coinflow").split("/");

writeFileSync("file-index.json", JSON.stringify({
  repo: { owner, name: repo, branch: process.env.GITHUB_REF_NAME ?? "main" },
  generated: new Date().toISOString(),
  count: entries.length,
  tree: toTree(root),
}, null, 2) + "\n");

const rows = entries.map((e) =>
  `| [${e.path}](${e.path}) | ${e.description ?? e.kind} | ${e.updated} |`
).join("\n");

writeFileSync("README.md", `# coinflow

Browse everything here: **https://${owner}.github.io/${repo}/**

Auto-generated index of every file in this repo, regenerated on each push by [.github/workflows/update-index.yml](.github/workflows/update-index.yml).

| File | Description | Last updated |
|------|-------------|--------------|
${rows}
`);

console.log(`Indexed ${entries.length} file(s).`);
