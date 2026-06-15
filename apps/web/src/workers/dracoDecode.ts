/**
 * Lazy, bundler-independent loader for Google's reference **Draco** decoder,
 * used to decode the Draco-compressed LiDAR spins in NVIDIA's raw Alpamayo
 * dataset *in the browser* — no pre-conversion step.
 *
 * Why the controlled eval instead of a plain `import`: the official `draco3d`
 * npm package ships only a **Node-targeted** emscripten glue
 * (`draco_decoder_nodejs.js`) that `require("fs")`/`require("path")`. A browser
 * bundler can't resolve those, and the `.wasm` would otherwise be grabbed by
 * `vite-plugin-wasm` and (wrongly) auto-instantiated. So we pull the glue in as
 * a **string** (`?raw`) and the wasm as a **URL** (`?url`), then run the
 * emscripten factory ourselves with `wasmBinary` supplied. Nothing on the Node
 * code path is ever bundled or executed — the `require("fs")` sits behind a
 * `typeof process == "object"` guard that is false in a worker.
 *
 * This whole module is imported **dynamically** (only when a raw Alpamayo LiDAR
 * file is opened), so the ~700 KB decoder wasm + glue never touch first load and
 * the core WASM size budget is untouched.
 */

// Vite query imports (typed by `vite/client`): the Node glue as source text,
// the decoder wasm as an asset URL.
import dracoGlueSource from "draco3d/draco_decoder_nodejs.js?raw";
import dracoWasmUrl from "draco3d/draco_decoder.wasm?url";

// --- Minimal typings for the bits of the emscripten decoder API we touch -----
// (draco3d ships no type declarations; this is the subset DRACOLoader uses.)

interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}
interface DracoAttribute {
  num_components(): number;
}
interface DracoPointCloud {
  num_points(): number;
}
interface DracoDecoder {
  DecodeBufferToPointCloud(buffer: unknown, pc: DracoPointCloud): DracoStatus;
  GetAttributeId(pc: DracoPointCloud, type: number): number;
  GetAttributeIdByMetadataEntry(
    pc: DracoPointCloud,
    name: string,
    value: string,
  ): number;
  GetAttribute(pc: DracoPointCloud, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(
    pc: DracoPointCloud,
    attr: DracoAttribute,
    dataType: number,
    byteLength: number,
    outPtr: number,
  ): boolean;
}
interface DracoDecoderBuffer {
  Init(data: Int8Array, length: number): void;
}
interface DracoModule {
  Decoder: new () => DracoDecoder;
  DecoderBuffer: new () => DracoDecoderBuffer;
  PointCloud: new () => DracoPointCloud;
  POSITION: number;
  DT_FLOAT32: number;
  DT_UINT8: number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  destroy(obj: unknown): void;
}

type DecoderFactory = (cfg: {
  wasmBinary: ArrayBuffer;
}) => Promise<DracoModule>;

/** One decoded spin: flattened xyz (`len 3N`, metres) + per-point intensity. */
export interface DecodedSpin {
  positions: Float32Array;
  intensities: Uint8Array;
}

/** A synchronous spin decoder — the shape `open_alpamayo_lidar` calls per row. */
export type SpinDecoder = (blob: Uint8Array) => DecodedSpin;

let modulePromise: Promise<DracoModule> | null = null;

/** Instantiate (once) the emscripten decoder module from the bundled glue. */
function getModule(): Promise<DracoModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmBinary = await (await fetch(dracoWasmUrl)).arrayBuffer();
      // Run the CJS glue in a controlled scope: `require` is a stub (the
      // fs/path requires are on the dead Node branch), and `module.exports`
      // collects the `DracoDecoderModule` factory.
      const shim: { exports: DecoderFactory | Record<string, never> } = {
        exports: {},
      };
      const requireStub = (): Record<string, never> => ({});
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function("module", "exports", "require", dracoGlueSource)(
        shim,
        shim.exports,
        requireStub,
      );
      const createDecoderModule = shim.exports as DecoderFactory;
      return createDecoderModule({ wasmBinary });
    })();
  }
  return modulePromise;
}

/** Copy a decoded attribute out of the wasm heap as a fresh typed array. */
function readAttribute(
  mod: DracoModule,
  decoder: DracoDecoder,
  pc: DracoPointCloud,
  attr: DracoAttribute,
  numValues: number,
  kind: "f32" | "u8",
): Float32Array | Uint8Array {
  const bytesPerElem = kind === "f32" ? 4 : 1;
  const byteLength = numValues * bytesPerElem;
  const ptr = mod._malloc(byteLength);
  try {
    const dataType = kind === "f32" ? mod.DT_FLOAT32 : mod.DT_UINT8;
    const ok = decoder.GetAttributeDataArrayForAllPoints(
      pc,
      attr,
      dataType,
      byteLength,
      ptr,
    );
    if (!ok) throw new Error("GetAttributeDataArrayForAllPoints failed");
    // `.slice()` copies out of the heap before any later alloc can move it.
    return kind === "f32"
      ? new Float32Array(mod.HEAPF32.buffer, ptr, numValues).slice()
      : new Uint8Array(mod.HEAPU8.buffer, ptr, numValues).slice();
  } finally {
    mod._free(ptr);
  }
}

/** Decode one Draco point-cloud blob into Driveline's `{positions,intensities}`. */
function decodeSpin(mod: DracoModule, blob: Uint8Array): DecodedSpin {
  const decoder = new mod.Decoder();
  const buffer = new mod.DecoderBuffer();
  const pc = new mod.PointCloud();
  try {
    // DRACOLoader passes an Int8Array view; mirror it.
    buffer.Init(
      new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength),
      blob.byteLength,
    );
    const status = decoder.DecodeBufferToPointCloud(buffer, pc);
    if (!status.ok()) {
      throw new Error(`Draco decode failed: ${status.error_msg()}`);
    }
    const numPoints = pc.num_points();

    const posId = decoder.GetAttributeId(pc, mod.POSITION);
    if (posId < 0) throw new Error("point cloud has no POSITION attribute");
    const positions = readAttribute(
      mod,
      decoder,
      pc,
      decoder.GetAttribute(pc, posId),
      numPoints * 3,
      "f32",
    ) as Float32Array;

    // `intensity` is a named generic attribute. Absent on some sensors → zeros,
    // so the cloud still renders (just uniform colour).
    const intId = decoder.GetAttributeIdByMetadataEntry(
      pc,
      "name",
      "intensity",
    );
    const intensities =
      intId >= 0
        ? (readAttribute(
            mod,
            decoder,
            pc,
            decoder.GetAttribute(pc, intId),
            numPoints,
            "u8",
          ) as Uint8Array)
        : new Uint8Array(numPoints);

    return { positions, intensities };
  } finally {
    mod.destroy(buffer);
    mod.destroy(pc);
    mod.destroy(decoder);
  }
}

/**
 * Resolve a synchronous spin decoder, instantiating the Draco module on first
 * use. The caller (`openAlpamayoLidar`) awaits this **before** invoking the wasm
 * reader, which then calls the returned fn once per spin, synchronously.
 */
export async function loadDracoSpinDecoder(): Promise<SpinDecoder> {
  const mod = await getModule();
  return (blob: Uint8Array) => decodeSpin(mod, blob);
}
