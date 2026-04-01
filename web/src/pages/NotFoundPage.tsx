import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div style={{ textAlign: 'center', paddingTop: '4rem' }}>
      <h1 style={{ fontSize: '3rem', fontWeight: 800 }}>404</h1>
      <p style={{ color: 'var(--color-text-muted)', marginTop: '0.5rem' }}>
        Page not found.
      </p>
      <Link to="/" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
        Back to home &rarr;
      </Link>
    </div>
  );
}
