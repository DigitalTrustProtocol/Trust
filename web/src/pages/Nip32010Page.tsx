import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import styles from './Nip32010Page.module.css';

/** Raw spec on the canonical GitHub repo (only implemented NIP linked from the site). */
const NIP_32010_RAW =
  'https://raw.githubusercontent.com/DigitalTrustProtocol/Trust/main/documentation/nips/NIP-32010.md';

const NIP_32010_BLOB =
  'https://github.com/DigitalTrustProtocol/Trust/blob/main/documentation/nips/NIP-32010.md';

export function Nip32010Page() {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(NIP_32010_RAW);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t = await res.text();
        if (!cancelled) setText(t);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>NIP-32010 — Trust events</h1>
        <p className={styles.lead}>
          This page loads the markdown specification from GitHub and renders it in the browser using{' '}
          <strong>react-markdown</strong> (with GFM and HTML sanitization). That is the usual approach for
          readable NIP-style docs without a separate static site generator.
        </p>
        <p className={styles.source}>
          Source:{' '}
          <a href={NIP_32010_BLOB} target="_blank" rel="noopener noreferrer">
            NIP-32010.md on GitHub
          </a>
        </p>
      </header>

      {error && (
        <div className={styles.error} role="alert">
          Could not load the spec ({error}). Open the GitHub link above, or run the site with network access.
        </div>
      )}

      {text && (
        <article className={styles.md}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {text}
          </ReactMarkdown>
        </article>
      )}
    </div>
  );
}
