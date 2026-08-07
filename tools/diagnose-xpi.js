const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;

const CONFIG = {
  xpiPath: process.env.ZOTERO_AI_XPI || path.join(root, "dist", `zotero-ai-assistant-${manifestVersion}.xpi`),
  zoteroVersion: process.env.ZOTERO_VERSION || "9.0.0"
};

function fail(message) {
  throw new Error(message);
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (readUInt32(buffer, i) === 0x06054b50) {
      return i;
    }
  }
  fail("ZIP end-of-central-directory record not found.");
}

function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = readUInt16(buffer, eocd + 10);
  const centralDirOffset = readUInt32(buffer, eocd + 16);
  const entries = [];
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      fail(`Bad central-directory header at offset ${offset}.`);
    }

    const method = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return { buffer, entries };
}

function readEntry(zip, entryName) {
  const entry = zip.entries.find((candidate) => candidate.name === entryName);
  if (!entry) {
    return null;
  }

  const local = entry.localHeaderOffset;
  if (readUInt32(zip.buffer, local) !== 0x04034b50) {
    fail(`Bad local header for ${entryName}.`);
  }
  const fileNameLength = readUInt16(zip.buffer, local + 26);
  const extraLength = readUInt16(zip.buffer, local + 28);
  const dataStart = local + 30 + fileNameLength + extraLength;
  const data = zip.buffer.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) {
    return data;
  }
  if (entry.method === 8) {
    return zlib.inflateRawSync(data);
  }
  fail(`Unsupported ZIP compression method ${entry.method} for ${entryName}.`);
}

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)(?:\.(\d+|\*))?/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === "*" ? Infinity : Number(match[3] || 0),
    wildcardPatch: match[3] === "*"
  };
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] < b[key]) {
      return -1;
    }
    if (a[key] > b[key]) {
      return 1;
    }
  }
  return 0;
}

function inRange(version, min, max) {
  const target = parseVersion(version);
  const lower = parseVersion(min);
  const upper = parseVersion(max);
  if (!target || !lower || !upper) {
    return false;
  }
  return compareVersions(target, lower) >= 0 && compareVersions(target, upper) <= 0;
}

function printResult(label, ok, detail) {
  console.log(`${ok ? "OK " : "BAD"} ${label}${detail ? `: ${detail}` : ""}`);
}

function main() {
  const zipPath = path.resolve(CONFIG.xpiPath);
  console.log(`XPI: ${zipPath}`);
  console.log(`Assumed Zotero version: ${CONFIG.zoteroVersion}`);

  if (!fs.existsSync(zipPath)) {
    fail("XPI file does not exist.");
  }

  const zip = readZipEntries(zipPath);
  const manifestBuffer = readEntry(zip, "manifest.json");
  printResult("manifest at ZIP root", !!manifestBuffer);
  if (!manifestBuffer) {
    const nested = zip.entries.find((entry) => /\/manifest\.json$/.test(entry.name));
    if (nested) {
      console.log(`Found nested manifest instead: ${nested.name}`);
    }
    return;
  }

  const manifest = JSON.parse(manifestBuffer.toString("utf8"));
  const zotero = manifest.applications?.zotero;

  printResult("manifest_version", manifest.manifest_version === 2, String(manifest.manifest_version));
  printResult("plugin id", !!zotero?.id, zotero?.id || "missing");
  printResult("update_url", /^https:\/\//.test(zotero?.update_url || ""), zotero?.update_url || "missing");
  printResult("strict_min_version", !!zotero?.strict_min_version, zotero?.strict_min_version || "missing");
  printResult("strict_max_version", /^\d+\.\d+\.\*$/.test(zotero?.strict_max_version || ""), zotero?.strict_max_version || "missing");

  if (zotero?.strict_min_version && zotero?.strict_max_version) {
    const compatible = inRange(CONFIG.zoteroVersion, zotero.strict_min_version, zotero.strict_max_version);
    printResult("version range match", compatible, `${zotero.strict_min_version} <= ${CONFIG.zoteroVersion} <= ${zotero.strict_max_version}`);

    const max = parseVersion(zotero.strict_max_version);
    if (max?.wildcardPatch) {
      console.log(`NOTE strict_max_version ${zotero.strict_max_version} only covers ${max.major}.${max.minor}.x.`);
      console.log("NOTE If your Zotero version is 9.1.x, change strict_max_version to 9.1.* or a wider supported line.");
    }
  }

  console.log(`ZIP entries: ${zip.entries.length}`);
  console.log(zip.entries.map((entry) => ` - ${entry.name}`).join("\n"));
}

main();
