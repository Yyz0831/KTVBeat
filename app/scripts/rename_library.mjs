// Rename committed song directories without changing song IDs or file bytes.
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { APP, DATA, loadCatalog } from "../player/catalog.mjs";
import {
  songDirectoryName,
  availableLibraryDirectory,
} from "../player/library-storage.mjs";
async function hashes(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile())
      throw new Error(`Unexpected directory entry: ${entry.name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      path.join(directory, entry.name),
    ))
      hash.update(chunk);
    result[entry.name] = hash.digest("hex");
  }
  return result;
}
const filename = path.join(APP, "records/library-directory-renames.json");
let record;
try {
  record = JSON.parse(await readFile(filename, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  record = { runs: [] };
}
const run = { at: new Date().toISOString(), entries: [], complete: false };
record.runs.push(run);
async function save() {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename + ".tmp", JSON.stringify(record, null, 2) + "\n");
  await rename(filename + ".tmp", filename);
}
for (const song of loadCatalog()) {
  const source = path.dirname(song.lyricsFile),
    base = songDirectoryName(song),
    name = path.basename(source);
  // Keep a previously assigned collision suffix when re-running this migration.
  if (
    name === base ||
    (name.startsWith(base + " (") &&
      /^\d+\)$/.test(name.slice(base.length + 2)))
  )
    continue;
  const target = await availableLibraryDirectory(
    path.join(DATA, "library"),
    song,
  );
  const entry = {
    id: song.id,
    from: source,
    to: target,
    sha256: await hashes(source),
    complete: false,
  };
  run.entries.push(entry);
  await save();
  await rename(source, target);
  const after = await hashes(target);
  for (const [file, hash] of Object.entries(entry.sha256))
    if (after[file] !== hash) throw new Error(`Changed bytes: ${file}`);
  entry.complete = true;
  await save();
  console.log(`${path.basename(source)} -> ${path.basename(target)}`);
}
run.complete = true;
await save();
console.log(`Verified ${run.entries.length} renamed directories.`);
