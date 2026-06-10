// HTTP ranged-read helpers for URL-backed MF4/MCAP sources.
//
// Both readers decode synchronously inside wasm, so the lazy ranged path needs
// a *synchronous* reader. Off the main thread (these only ever run inside a
// Worker) that means synchronous `XMLHttpRequest` issuing `Range` requests.
// They live in their own module — apart from the worker's Comlink/wasm wiring —
// so the CORS/range failure handling is unit-testable without booting wasm.

/**
 * Thrown when a URL fetch is rejected in the opaque way a CORS block (or a
 * bare network failure) surfaces to script: a synchronous `XMLHttpRequest`
 * that throws on `send()`, or returns with `status === 0` and no headers —
 * the browser refuses to expose a cross-origin response that carries no
 * `Access-Control-Allow-Origin` header for this site's origin. There's no
 * status line or body to distinguish "CORS" from "host unreachable", so the
 * message names the overwhelmingly common cause (cross-origin host without a
 * CORS policy) and points at the local-drop escape hatch. Surfaced verbatim
 * in the URL-load form via the store's `openUrl`.
 */
export class UrlFetchBlockedError extends Error {
  constructor(url: string) {
    super(
      `Couldn't fetch ${url} — the request was blocked, almost always by CORS. ` +
        `The host must send an 'Access-Control-Allow-Origin' header for this ` +
        `site and, for .mf4 and ranged .mcap, expose 'Content-Range' and honour ` +
        `'Range' requests. If you can't change the host's CORS settings, ` +
        `download the file and drop it in directly.`,
    );
    this.name = "UrlFetchBlockedError";
  }
}

/**
 * Probe a remote file over HTTP and return its total byte length.
 *
 * Both the MF4 and MCAP readers decode synchronously inside wasm, so the lazy
 * ranged path needs a *synchronous* reader (the OPFS path uses a sync access
 * handle). For a URL we use synchronous `XMLHttpRequest` — permitted inside a
 * Worker — issuing `Range` requests. This probe asks for a single byte and
 * reads the total size out of the `Content-Range` header, which doubles as a
 * check that the server actually honours range requests (status 206). A server
 * that ignores `Range` (200, whole body) can't back a lazy reader, so we fail
 * loudly here; the MCAP caller catches this and falls back to a whole-body
 * fetch.
 */
export function urlProbeSize(url: string): number {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false); // synchronous — only legal off the main thread
  xhr.setRequestHeader("Range", "bytes=0-0");
  try {
    xhr.send();
  } catch {
    // A synchronous XHR throws (rather than returning a status) when the
    // browser blocks the response — the usual shape of a CORS rejection.
    throw new UrlFetchBlockedError(url);
  }
  // The other shape: a completed request with no status line or headers,
  // which the platform reports as status 0 for an opaque cross-origin failure.
  if (xhr.status === 0) {
    throw new UrlFetchBlockedError(url);
  }
  if (xhr.status !== 206) {
    throw new Error(
      `URL does not support HTTP range requests ` +
        `(got status ${xhr.status}, expected 206). The server must send ` +
        `'Accept-Ranges: bytes' and honour the Range header.`,
    );
  }
  // "bytes 0-0/123456" → total is the part after the slash.
  const contentRange = xhr.getResponseHeader("Content-Range");
  const total = contentRange?.split("/")[1];
  if (!total || total === "*" || !Number.isFinite(Number(total))) {
    throw new Error(
      `URL range response missing a usable total size ` +
        `(Content-Range: ${contentRange ?? "<none>"}).`,
    );
  }
  return Number(total);
}

/**
 * Synchronous ranged read against `url`, used as the wasm `readRange`
 * callback for a URL-backed source. wasm invokes this once per data block /
 * chunk while decoding, so only the bytes actually plotted (or the video
 * chunks actually played) are ever fetched.
 */
export function urlReadRange(
  url: string,
  offset: number,
  length: number,
): Uint8Array {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer"; // allowed for sync XHR inside a Worker
  xhr.setRequestHeader("Range", `bytes=${offset}-${offset + length - 1}`);
  try {
    xhr.send();
  } catch {
    // Same CORS/network block as in `urlProbeSize` — but mid-stream, once a
    // channel's bytes are actually requested. Surface the same actionable hint.
    throw new UrlFetchBlockedError(url);
  }
  if (xhr.status === 0) {
    throw new UrlFetchBlockedError(url);
  }
  if (xhr.status !== 206 && xhr.status !== 200) {
    throw new Error(`url readRange failed at ${offset}: status ${xhr.status}`);
  }
  let buf = new Uint8Array(xhr.response as ArrayBuffer);
  // A non-conforming server may answer a Range with the whole body (200);
  // slice the requested window out of it rather than failing.
  if (xhr.status === 200 && buf.length >= offset + length) {
    buf = buf.subarray(offset, offset + length);
  }
  if (buf.length !== length) {
    throw new Error(
      `url short read at ${offset}: wanted ${length}, got ${buf.length}`,
    );
  }
  return buf;
}
