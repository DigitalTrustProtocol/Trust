import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LandingPage } from './pages/LandingPage';
import { GraphPage } from './pages/GraphPage';
import { Nip32010Page } from './pages/Nip32010Page';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LandingPage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="nip-32010" element={<Nip32010Page />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
