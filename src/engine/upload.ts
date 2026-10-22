// Receiving a file: streamed to a private temp file in the storage dir while
// it is counted and hashed, so an upload never sits in memory whole.
import { closeSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ConcurrencyGate, LimitError } from "./limits.ts";
import { logEvent } from "./log.ts";

const TEMP_PREFIX = ".tmp-";
/** Bytes kept from the start of a file to detect its type (see sniffContentType). */
const HEAD_BYTES = 16;

export const tempPathFor = (dir: string, id: string) => join(dir, `${TEMP_PREFIX}${id}`);

/** Removes temp files a crashed or killed upload left in `dir`. One process owns a data dir, so none is in use. */
export function removeTempFiles(dir: string) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch (err) {
      logEvent("warn", { ev: "storage_error", what: "temp file cleanup", file: name, err }, ["[incibase] could not remove", name, err]);
    }
  }
}

export interface ReceivedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReceiveOptions {
  /** Called with the size so far after every chunk; throws to stop (e.g. too large). */
  checkSize: (size: number) => void;
  /** Called once with the first bytes (all of them for a small file); throws to stop (e.g. a refused type). */
  checkHead: (head: Uint8Array) => void;
}

/**
 * Writes `body` to `path` (created 0600, never replacing a file), hashing it
 * as it goes. Stops reading as soon as a check throws. On any failure the
 * file is removed and the body cancelled.
 */
export async function receiveToFile(body: ReadableStream<Uint8Array> | null, path: string, options: ReceiveOptions): Promise<ReceivedFile> {
  const hasher = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "wx", 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  const reader = body?.getReader();
  let size = 0;
  let head: Uint8Array | null = new Uint8Array(0);
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      size += value.byteLength;
      options.checkSize(size);
      if (head) {
        const kept: Uint8Array = head;
        const joined = new Uint8Array(Math.min(HEAD_BYTES, kept.byteLength + value.byteLength));
        joined.set(kept);
        joined.set(value.subarray(0, joined.byteLength - kept.byteLength), kept.byteLength);
        head = joined;
        if (head.byteLength >= HEAD_BYTES) {
          options.checkHead(head);
          head = null;
        }
      }
      hasher.update(value);
      // Written synchronously: while an async write is pending, Bun keeps
      // reading the body into memory as fast as the client sends it (a
      // 500 MiB upload over loopback grew RSS by about 130 MiB that way).
      // Chunks are small, so each write only takes the page cache a moment.
      for (let written = 0; written < value.byteLength; ) written += writeSync(fd, value, written);
    }
    if (head) options.checkHead(head);
    close();
  } catch (err) {
    reader?.cancel().catch(() => {});
    try {
      close();
    } catch {}
    rmSync(path, { force: true });
    throw err;
  }
  return { path, size, sha256: hasher.digest("hex") };
}

/**
 * At most `limit` uploads at a time. The rest wait in order for up to
 * `maxWaitMs`, then get UPLOADS_BUSY (503).
 */
export class UploadGate extends ConcurrencyGate {
  constructor(limit: number, maxWaitMs: number) {
    super(limit, maxWaitMs, {
      busy: () =>
        new LimitError({ code: "UPLOADS_BUSY", message: `Too many uploads in progress (at most ${limit} at a time); try again shortly` }, 503, 5),
      aborted: "The upload was aborted",
    });
  }
}
