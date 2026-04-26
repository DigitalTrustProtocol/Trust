import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LandingPage } from './pages/LandingPage';
import { GraphPage } from './pages/GraphPage';
import { PlaygroundPage } from './playground/PlaygroundPage';
import { Nip32010Page } from './pages/Nip32010Page';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LandingPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="nip-32010" element={<Nip32010Page />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPolicyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
