import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WoTProvider } from './lib/nostr-wot-sdk/react';
import { HeaderSessionProvider } from './components/HeaderSessionContext';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <HeaderSessionProvider>
        <WoTProvider>
          <App />
        </WoTProvider>
      </HeaderSessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
