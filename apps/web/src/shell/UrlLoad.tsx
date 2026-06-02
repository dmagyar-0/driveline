// Load a `.mcap`/`.mf4` source from a URL. Sits next to the file picker in
// both the first-run empty state and the Sources drawer. MCAP fetches the
// whole body; MF4 streams lazily over HTTP range requests (see the store's
// `openUrl`). Failures surface inline so the user isn't left guessing when a
// host lacks CORS or range support.

import { useId, useState } from "react";
import { useSession } from "../state/store";
import s from "./UrlLoad.module.css";

interface Props {
  /** `firstrun` is the prominent empty-state form; `drawer` is compact. */
  variant: "firstrun" | "drawer";
}

export function UrlLoad({ variant }: Props) {
  const openUrl = useSession((st) => st.openUrl);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await openUrl(value);
      if (result.opened.length > 0) {
        setUrl("");
      } else {
        setError(result.errors[0]?.reason ?? "Could not load that URL.");
      }
    } finally {
      setBusy(false);
    }
  };

  const rootClass = variant === "firstrun" ? s.firstRun : s.drawer;

  return (
    <form
      className={rootClass}
      onSubmit={onSubmit}
      data-testid={`url-load-${variant}`}
    >
      <div className={s.row}>
        <input
          type="url"
          inputMode="url"
          className={s.input}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          placeholder="https://…/log.mcap or .mf4"
          aria-label="Load .mcap or .mf4 from URL"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={busy}
          data-testid={`url-load-input-${variant}`}
        />
        <button
          type="submit"
          className={s.button}
          disabled={busy || url.trim().length === 0}
          data-testid={`url-load-submit-${variant}`}
        >
          {busy ? "Loading…" : "Load URL"}
        </button>
      </div>
      {error ? (
        <p id={errorId} className={s.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
