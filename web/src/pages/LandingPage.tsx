import styles from './LandingPage.module.css';

const LINKS = {
  cli: 'https://gitlab.com/keutmann/trust/-/releases',
  npm: 'https://www.npmjs.com/package/@trust/cli',
  skill: 'https://gitlab.com/keutmann/trust/-/blob/main/SKILL.md',
  gitlab: 'https://gitlab.com/keutmann/trust',
  nip32010: 'https://gitlab.com/keutmann/trust/-/blob/main/documentation/nips/NIP-32010.md',
};

export function LandingPage() {
  return (
    <div className={styles.page}>
      {/* Hero */}
      <section className={styles.hero}>
        <h1 className={styles.title}>
          Decentralized Web of Trust
          <span className={styles.accent}> Reputation</span>
        </h1>
        <p className={styles.subtitle}>
          An open protocol for humans and AI agents to establish, query, and
          visualize trust relationships &mdash; built on{' '}
          <a href="https://nostr.com" target="_blank" rel="noopener noreferrer">Nostr</a>.
        </p>
      </section>

      {/* Quick-start */}
      <section className={styles.section}>
        <h2>Quick start</h2>
        <pre className={styles.codeBlock}>
          <code>{`npm install -g @trust/cli

trust init --name "Alice"
trust trust <npub-or-hex> -c development
trust resolve <npub-or-hex>
trust server`}</code>
        </pre>
      </section>

      {/* Cards */}
      <section className={styles.cards}>
        <Card
          title="CLI &amp; Server"
          description="One binary: run as a CLI for quick trust assertions, or as a full relay + REST API server."
          links={[
            { label: 'Install from npm', href: LINKS.npm },
            { label: 'Download release', href: LINKS.cli },
          ]}
        />
        <Card
          title="For AI Agents"
          description="Agents can read the SKILL.md to learn how to interact with Trust programmatically."
          links={[
            { label: 'View SKILL.md', href: LINKS.skill },
            { label: 'REST API docs (coming soon)', href: '#' },
          ]}
        />
        <Card
          title="NIP-32010"
          description="Trust events are kind 32010 Nostr events. Fully interoperable with any relay."
          links={[
            { label: 'Read the spec', href: LINKS.nip32010 },
            { label: 'Source on GitLab', href: LINKS.gitlab },
          ]}
        />
      </section>

      {/* Coming soon */}
      <section className={styles.section}>
        <h2>Coming soon</h2>
        <ul className={styles.roadmap}>
          <li>
            <span className={styles.badge}>Explorer</span>
            Interactive trust graph visualization &mdash; browse nodes, edges, and contexts.
          </li>
          <li>
            <span className={styles.badge}>Resolve</span>
            Query trust paths with a visual breakdown of how a score is computed.
          </li>
          <li>
            <span className={styles.badge}>Auth</span>
            Sign in with your Nostr key to manage your identity and trust assertions from the browser.
          </li>
        </ul>
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
  links: { label: string; href: string }[];
}) {
  return (
    <div className={styles.card}>
      <h3>{title}</h3>
      <p>{description}</p>
      <div className={styles.cardLinks}>
        {links.map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer">
            {l.label} &rarr;
          </a>
        ))}
      </div>
    </div>
  );
}
