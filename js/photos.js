// Read location and date from photos (exifr, loaded as a global from the CDN), then forget the photo.
// Only the matched city and the date are returned; the image and its exact GPS are not kept.
import { nearestCity } from "./cities.js";
import { isoDate } from "./visits.js";

/**
 * @returns {Promise<{placed: {city, date}[], unplaced: {date, approx}[], failed: number}>}
 */
export async function readPhotos(files, onProgress = () => {}) {
  const placed = [], unplaced = [];
  let failed = 0, done = 0;
  for (const file of files) {
    try {
      const [gps, tags] = await Promise.all([
        exifr.gps(file).catch(() => null),
        exifr.parse(file, ["DateTimeOriginal", "CreateDate"]).catch(() => null),
      ]);
      const taken = tags?.DateTimeOriginal || tags?.CreateDate;
      const date = isoDate(taken instanceof Date && !isNaN(taken) ? taken : new Date(file.lastModified));
      const approx = !(taken instanceof Date);
      const city = gps && Number.isFinite(gps.latitude) ? nearestCity(gps.latitude, gps.longitude) : null;
      if (city) placed.push({ city, date, approx });
      else unplaced.push({ date, approx, hadGps: !!gps });
    } catch {
      failed++;
    }
    onProgress(++done, files.length);
  }
  return { placed, unplaced, failed };
}
