import styles from './PrivacyPolicyPage.module.css';

export function PrivacyPolicyPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1>Privacy Policy</h1>
        <p>
          This Privacy Policy explains how trust.dance processes personal data when operating the website, API, and
          relay service.
        </p>
        <span className={styles.meta}>Last updated: April 20, 2026</span>
      </section>

      <section className={styles.section}>
        <h2>1. Who we are</h2>
        <p>
          trust.dance is a public Nostr service that may process personal data published to the protocol and limited
          technical metadata needed to operate the infrastructure.
        </p>
        <ul>
          <li>Controller: trust.dance operator (Denmark)</li>
          <li>Service scope: website, API, and relay infrastructure</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>2. Data we process</h2>
        <p>We aim to minimize personal data processing and only process what is necessary to run the service.</p>
        <ul>
          <li>Public Nostr data submitted to the relay (including kind 0 metadata and other published events)</li>
          <li>Technical logs such as request time, endpoint, and system diagnostics</li>
          <li>
            IP address only when needed for abuse prevention, rate limiting, and incident response, as described in the
            Terms
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>3. Legal basis and purposes</h2>
        <p>Under GDPR, we process personal data to provide and secure the service.</p>
        <ul>
          <li>Service operation and delivery of relay/API functionality</li>
          <li>Security monitoring, abuse detection, and service integrity protection</li>
          <li>Rate limiting and incident response where technically required</li>
          <li>Legal compliance and defense of legal claims where applicable</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>4. Retention</h2>
        <p>We keep data only as long as needed for the purpose it was collected.</p>
        <ul>
          <li>Protocol data may persist until removed by policy, moderation action, or deletion request handling</li>
          <li>Operational logs are retained for a limited period and deleted or rotated regularly</li>
          <li>IP-related records are retained only as necessary for abuse/security handling, then deleted</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>5. Erasure and deletion requests</h2>
        <p>
          We support deletion signaling through Nostr mechanisms, including <span className={styles.inline}>NIP-09</span>{' '}
          and <span className={styles.inline}>NIP-62</span>, to handle relay-local deletion requests.
        </p>
        <ul>
          <li>Deletion requests are best effort and apply only to systems under trust.dance control</li>
          <li>
            We cannot guarantee deletion from third-party relays, client caches, archives, or other external systems
          </li>
          <li>Where legally required, we will process valid GDPR rights requests for data under our control</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>6. Your GDPR rights</h2>
        <p>Depending on applicable law, you may have rights including:</p>
        <ul>
          <li>Access to personal data we process about you</li>
          <li>Rectification of inaccurate personal data</li>
          <li>Erasure of data under our control (subject to legal/technical limits)</li>
          <li>Restriction or objection to certain processing</li>
          <li>Complaint to your local supervisory authority, including in Denmark or your country of residence</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>7. Sharing and transfers</h2>
        <p>We do not sell personal data. Data may be shared only when necessary for operation or legal compliance.</p>
        <ul>
          <li>Infrastructure providers processing data on our behalf (where applicable)</li>
          <li>Authorities or partners where required to prevent abuse or comply with legal obligations</li>
          <li>
            Public Nostr events are inherently distributed and may be mirrored outside trust.dance infrastructure
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>8. Policy updates</h2>
        <p>
          We may update this policy as the service evolves. Material changes will be published on this page with an
          updated date.
        </p>
      </section>

      <p className={styles.note}>
        This policy is a practical GDPR-focused transparency document for trust.dance operations and does not constitute
        legal advice.
      </p>
    </div>
  );
}
