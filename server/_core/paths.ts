import path from "path";
import { fileURLToPath } from "url";
import { ENV } from "./env";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where uploaded files live: on the persistent disk when one is configured
 * (production), otherwise the project's own uploads folder. Defined once so
 * the upload route, file download, receipt OCR, document delete and backup
 * can never disagree about the location. */
export const uploadsDir = ENV.persistentDataDir ? path.join(ENV.persistentDataDir, "uploads") : path.resolve(here, "../../uploads");
