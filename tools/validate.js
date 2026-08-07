const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "content/zotero-ai.js",
  "content/search.xhtml",
  "content/search.js",
  "content/search.css",
  "content/preferences-pane.xhtml",
  "content/preferences-pane.js",
  "content/preferences-pane.css",
  "content/icons/file-text.svg",
  "content/icons/search-quote.svg",
  "content/icons/message-circle-question.svg"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const file of requiredFiles) {
  assert(fs.existsSync(path.join(root, file)), `Missing ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert(manifest.manifest_version === 2, "manifest_version must be 2");
assert(manifest.applications?.zotero?.id, "manifest must declare applications.zotero.id");
assert(
  /^https:\/\//.test(manifest.applications.zotero.update_url || ""),
  "manifest must declare applications.zotero.update_url as an https URL"
);
assert(
  /^\d+\.\d+\.\*$/.test(manifest.applications.zotero.strict_max_version || ""),
  "applications.zotero.strict_max_version must use x.y.* format, for example 9.0.*"
);

const packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert(packageJSON.version === manifest.version, "package.json version must match manifest.json version");

for (const file of ["bootstrap.js", "content/zotero-ai.js", "content/search.js", "content/preferences-pane.js"]) {
  childProcess.execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit"
  });
}

for (const file of requiredFiles.concat(["README.md"]).filter((name) => /\.(js|xhtml|md)$/.test(name))) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert(!/(\u951b|\u9239|\u940e|\u7d31\u3120|\u599d\u2033|\u93bd\u6a0a|\u7487\u5cf0|\u934f\u70b5)/.test(text), `${file} appears to contain mojibake`);
}

for (const file of ["content/search.xhtml", "content/preferences-pane.xhtml"]) {
  const xml = fs.readFileSync(path.join(root, file), "utf8");
  childProcess.execFileSync(process.execPath, [
    "-e",
    "const fs=require('fs'); const s=fs.readFileSync(process.argv[1],'utf8'); let q=null; for (let i=0;i<s.length;i++){ const c=s[i]; if(!q && (c==='\"'||c===\"'\")){q=c; continue;} if(q && c===q){q=null; continue;} } if(q) throw new Error('Unclosed XML attribute quote in '+process.argv[1]);",
    path.join(root, file)
  ], {
    stdio: "inherit"
  });
}

const xpiPath = path.join(root, "dist", `zotero-ai-assistant-${manifest.version}.xpi`);
if (fs.existsSync(xpiPath)) {
  // Zotero's add-on loader resolves entries with forward slashes (rootURI +
  // "content/..."). A Windows-built ZIP with backslash separators has no
  // matching entries, so the plugin fails to load. Guard against that here.
  const names = childProcess.execFileSync("tar", ["-tf", xpiPath], {
    encoding: "utf8"
  }).split(/\r?\n/).filter(Boolean);
  assert(names.length > 0, `${xpiPath} contains no entries`);
  const backslashed = names.filter((name) => name.includes("\\"));
  assert(
    backslashed.length === 0,
    `XPI entries must use forward slashes, found backslashes in: ${backslashed.join(", ")}`
  );
  console.log(`XPI entry paths OK (${names.length} entries)`);
}

console.log("Validation passed");
