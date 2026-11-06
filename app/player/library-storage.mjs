import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";

function cleanPart(value, fallback) {
  return (
    String(value || "")
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/_+/g, "_")
      .replace(/^[. _]+|[. _]+$/g, "") || fallback
  );
}

function truncate(value, maxBytes) {
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result.replace(/[. _]+$/g, "");
}

export function songDirectoryName({ title, artist }) {
  const song = cleanPart(title, "未命名歌曲");
  const authors =
    String(artist || "")
      .split(/[,，、;；/／&_]+/u)
      .map((part) => cleanPart(part, ""))
      .filter(Boolean)
      .join("_") || "未知歌手";
  const full = `${song}_${authors}`;
  if (Buffer.byteLength(full) <= 240) return full;
  // Leave room for a collision suffix within the filesystem's byte limit.
  const shortTitle = truncate(song, 120);
  return `${shortTitle}_${truncate(authors, 239 - Buffer.byteLength(shortTitle))}`;
}

const nameKey = (value) => value.normalize("NFC").toLowerCase();

export async function availableLibraryDirectory(root, song) {
  await mkdir(root, { recursive: true });
  const existing = new Set((await readdir(root)).map(nameKey));
  const base = songDirectoryName(song);
  let name = base;
  for (let index = 2; existing.has(nameKey(name)); index++) {
    name = `${base} (${index})`;
  }
  return path.join(root, name);
}

export async function commitLibrarySong(source, root, song) {
  const directory = await availableLibraryDirectory(root, song);
  // The queue has one writer; the complete result directory is published at once.
  await rename(source, directory);
  return directory;
}
