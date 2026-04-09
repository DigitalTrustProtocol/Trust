import { Link } from 'react-router-dom';
import { getApiBase, getApiDocsUrl } from '../api';
import styles from './LandingPage.module.css';

const LINKS = {
  github: 'https://github.com/DigitalTrustProtocol/Trust',
  nip32010: 'https://github.com/DigitalTrustProtocol/Trust/blob/main/documentation/nips/NIP-32010.md',
  npm: 'https://www.npmjs.com/package/@dtp/trust',
  relay: 'wss://relay.trust.dance/relay',
};

export function LandingPage() {
  const apiDocsUrl = getApiDocsUrl();
  const apiBase = getApiBase();

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.title}>
          Decentralized Web of Trust
          <span className={styles.accent}> reputation</span>
        </h1>
        <p className={styles.subtitle}>
          An open protocol for humans and AI agents to publish, query, and reason about trust — built on{' '}
          <a href="https://nostr.com" target="_blank" rel="noopener noreferrer">
            Nostr
          </a>
          . Public site: <strong>trust.dance</strong>. HTTP API: <strong>api.trust.dance</strong>. Relay:{' '}
          <strong>relay.trust.dance</strong>.
        </p>
      </section>

      <section
        className={styles.section}
        aria-label="Machine-readable summary"
        data-ai-purpose="project-summary"
      >
        <h2>What this is (for humans and tools)</h2>
        <ul className={styles.summaryList}>
          <li>
            <strong>Trust</strong> is a CLI, SDK, HTTP API, and optional Nostr relay that stores and resolves{' '}
            <strong>kind 32010</strong> trust assertions (see{' '}
            <Link to="/nip-32010">NIP-32010</Link> only — other NIPs in the repo are not implemented yet).
          </li>
          <li>
            <strong>Install (npm)</strong>: <code className={styles.inline}>npm install -g @dtp/trust</code> — binary{' '}
            <code className={styles.inline}>trust</code> (package name scopes may vary until publish; see npm link).
          </li>
          <li>
            <strong>HTTP API</strong>: OpenAPI Swagger UI at{' '}
            <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer">
              <code className={styles.inline}>{apiDocsUrl}</code>
            </a>
            {apiBase ? (
              <> (from <code className={styles.inline}>VITE_API_BASE_URL</code>)</>
            ) : (
              <> (same origin as this site when the API is served with the web app)</>
            )}
            .
          </li>
          <li>
            <strong>Relay</strong>: <code className={styles.inline}>{LINKS.relay}</code> (NIP-01 WebSocket; trust events
            kind 32010).
          </li>
          <li>
            <strong>Web</strong>: <Link to="/graph">Graph explorer</Link> — client-side graph + resolve visualization
            against your configured API base.
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>Quick start</h2>
        <pre className={styles.codeBlock}>
          <code>{`npm install -g @dtp/trust

trust init --name "Alice"
trust add <npub-or-hex> -c development
trust resolve <npub-or-hex>
trust server`}</code>
        </pre>
        <p className={styles.note}>
          Run <code className={styles.inline}>trust server</code> to serve relay + REST + this web UI from one process,
          or deploy relay, API, and static web on <code className={styles.inline}>trust.dance</code>,{' '}
          <code className={styles.inline}>api.trust.dance</code>, and{' '}
          <code className={styles.inline}>relay.trust.dance</code> separately.
        </p>
      </section>

      <section className={styles.cards}>
        <Card
          title="Explore"
          description="Browse the synced trust graph and run resolve with author + subject to see paths and scores."
          links={[
            { label: 'Open graph', to: '/graph', internal: true },
            { label: 'GitHub', href: LINKS.github },
          ]}
        />
        <Card
          title="For AI agents"
          description="Use the HTTP API or MCP tools; prefer OpenAPI /docs for request shapes. Trust events follow NIP-32010."
          links={[
            { label: 'API docs', href: apiDocsUrl },
            { label: 'NIP-32010 spec', href: LINKS.nip32010 },
          ]}
        />
        <Card
          title="NIP-32010"
          description="The only trust-event NIP implemented in this codebase today. Interoperates with any Nostr relay."
          links={[
            { label: 'Rendered on site', to: '/nip-32010', internal: true },
            { label: 'Markdown on GitHub', href: LINKS.nip32010 },
          ]}
        />
      </section>

      <section className={styles.section}>
        <h2>Documentation</h2>
        <p className={styles.note}>
          The in-app <Link to="/nip-32010">NIP-32010</Link> page loads markdown from GitHub and renders it with{' '}
          <strong>react-markdown</strong> (GFM + sanitization). That is the standard client-side way to turn spec
          markdown into readable HTML — no separate build step for the NIP text.
        </p>
      </section>
    </div>
  );
}

function Card({
  title,
  description,
  links,
}: {
  title: string;
  description: string;
  links: ({ label: string } & ({ to: string; internal: true } | { href: string; internal?: false }))[];
}) {
  return (
    <div className={styles.card}>
      <h3>{title}</h3>
      <p>{description}</p>
      <div className={styles.cardLinks}>
        {links.map((l) =>
          'to' in l ? (
            <Link key={l.label} to={l.to}>
              {l.label} &rarr;
            </Link>
          ) : (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label} &rarr;
            </a>
          ),
        )}
      </div>
    </div>
  );
}
