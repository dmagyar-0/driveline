// Pure file-bucketing helper for T2.4. Takes a flat `File[]` (from either a
// real `DataTransfer` drop or the Playwright dev-hook) and returns the inputs
// grouped by reader format. mp4 + `.mp4.ts.bin` pairing follows the naming
// convention in `docs/05-video-pipeline.md:127-131`: `foo.mp4` pairs with
// `foo.mp4.ts.bin` in the same drop batch.

export interface Mp4Pair {
  mp4: File;
  ts: File;
}

export interface BucketError {
  name: string;
  reason: string;
}

export interface Buckets {
  mcap: File[];
  mf4: File[];
  mp4Pairs: Mp4Pair[];
  errors: BucketError[];
}

const SIDECAR_SUFFIX = ".mp4.ts.bin";

export function bucketFiles(files: File[]): Buckets {
  const mcap: File[] = [];
  const mf4: File[] = [];
  const sidecars = new Map<string, File>(); // mp4 filename -> sidecar file
  const mp4s: File[] = [];
  const errors: BucketError[] = [];

  for (const f of files) {
    const name = f.name;
    const lower = name.toLowerCase();
    if (lower.endsWith(SIDECAR_SUFFIX)) {
      // "drive.mp4.ts.bin" -> "drive.mp4". Preserve the original (unlowered)
      // casing of the mp4 name so equality matching stays strict.
      const mp4Name = name.slice(0, -".ts.bin".length);
      sidecars.set(mp4Name, f);
    } else if (lower.endsWith(".mp4")) {
      mp4s.push(f);
    } else if (lower.endsWith(".mcap")) {
      mcap.push(f);
    } else if (lower.endsWith(".mf4")) {
      mf4.push(f);
    } else {
      errors.push({ name, reason: `unknown file type: ${name}` });
    }
  }

  const mp4Pairs: Mp4Pair[] = [];
  for (const mp4 of mp4s) {
    const ts = sidecars.get(mp4.name);
    if (ts) {
      mp4Pairs.push({ mp4, ts });
      sidecars.delete(mp4.name);
    } else {
      errors.push({
        name: mp4.name,
        reason: `missing sidecar ${mp4.name}.ts.bin`,
      });
    }
  }

  // Any sidecar left over has no matching mp4 in this drop.
  for (const [mp4Name, ts] of sidecars) {
    errors.push({
      name: ts.name,
      reason: `orphan sidecar; no ${mp4Name} in drop`,
    });
  }

  return { mcap, mf4, mp4Pairs, errors };
}
