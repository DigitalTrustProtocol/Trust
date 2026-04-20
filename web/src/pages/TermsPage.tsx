import styles from './TermsPage.module.css';

export function TermsPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1>Terms of Service</h1>
        <p>
          These Terms of Service govern your use of trust.dance services, including the web app, API, and relay
          infrastructure.
        </p>
        <span className={styles.meta}>Last updated: April 20, 2026</span>
      </section>

      <section className={styles.section}>
        <h2>1. Services</h2>
        <p>You may not abuse trust.dance services or attempt to disrupt service availability.</p>
        <ol>
          <li>
            Do not perform spam, denial of service, or abusive automated traffic against trust.dance infrastructure.
          </li>
          <li>
            You may not use the trust.dance services to store or disseminate following content:
            <ul>
              <li>CSAM</li>
              <li>Spam or advertising</li>
              <li>Sexually explicit content</li>
              <li>Copyright-infringing material</li>
              <li>Unauthorized sharing of PII</li>
              <li>Storage of large non-Nostr blobs</li>
            </ul>
          </li>
          <li>
            Do not use the relay or API as bulk file storage for large non-protocol blobs or unrelated payloads.
          </li>
          <li>
            Fair use applies. If your usage degrades stability for others, we may rate-limit, restrict, or suspend
            access.
          </li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>2. Content</h2>
        <p>You are responsible for all content you publish or import through trust.dance services.</p>
        <ol>
          <li>You represent that you have the legal rights to submit, publish, and share the content you send.</li>
          <li>
            You grant trust.dance a worldwide, non-exclusive, royalty-free license to host, index, transform, and
            display
            that content as needed to operate the service.
          </li>
          <li>Public protocol data may remain accessible through third-party relays and caches after publication.</li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>3. Privacy and Abuse Prevention</h2>
        <p>We process limited operational data to protect the service and monitor reliability.</p>
        <ol>
          <li>
            We may log technical metadata (such as IP address, request timing, and public key identifiers) to detect
            abuse and investigate incidents.
          </li>
          <li>
            When abuse is detected, we may retain relevant identifiers longer and share necessary information with
            trusted partners or legal authorities.
          </li>
          <li>
            We try to minimize stored personal data and separate operational telemetry from identity whenever possible.
          </li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>4. Payments and Credits</h2>
        <p>Some features may require paid credits or usage-based billing.</p>
        <ol>
          <li>Credits are service-only and are not redeemable for cash unless required by applicable law.</li>
          <li>Unless otherwise stated, credits may expire after 12 months.</li>
          <li>Network-denominated payments are generally final once settled.</li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>5. Suspension, Termination, and Changes</h2>
        <p>We may suspend or terminate access to protect users, systems, or legal compliance.</p>
        <ol>
          <li>Violations of these terms can lead to immediate restrictions or account termination.</li>
          <li>We may update these terms over time. Continued use after updates means you accept the new terms.</li>
          <li>Where required, we will provide notice of material changes through site or service channels.</li>
        </ol>
      </section>

      <p className={styles.note}>
        For privacy and GDPR processing details, see the <a href="/privacy">Privacy Policy</a>.
      </p>
    </div>
  );
}
