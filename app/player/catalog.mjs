import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const APP = fileURLToPath(new URL("../", import.meta.url));
export const DATA = path.resolve(
  process.env.KTVBEAT_DATA || path.join(APP, "data"),
);
export const roles = ["instrumental", "lead", "backing"];
export function loadCatalog(data = DATA) {
  const root = path.join(data, "library");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .flatMap((d) => {
      try {
        const song = JSON.parse(
          readFileSync(path.join(root, d.name, "song.json"), "utf8"),
        );
        // Folder names are human-readable; URLs retain the immutable song ID.
        if (typeof song.id !== "string" || !/^[a-z0-9-]+$/.test(song.id))
          return [];
        return [
          {
            ...song,
            lyricsFile: path.join(root, d.name, "lyrics.json"),
            files: Object.fromEntries(
              roles.map((r) => [r, path.join(root, d.name, `${r}.flac`)]),
            ),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.order - b.order);
}
export function publicCatalog(data = DATA) {
  return loadCatalog(data).map(
    ({ id, title, artist, frames, duration, color, fallbackCount = 0 }) => ({
      id,
      title,
      artist,
      frames,
      duration,
      color,
      fallbackCount,
      lyricsUrl: `/api/lyrics/${id}`,
      tracks: Object.fromEntries(roles.map((r) => [r, `/audio/${id}/${r}`])),
    }),
  );
}
// Read-only snapshot retained for existing offline regression tests.
export const catalog = loadCatalog();
