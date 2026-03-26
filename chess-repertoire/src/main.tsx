import React from 'react';
import ReactDOM from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { App } from './components/App';
import { AuthProvider } from './context/AuthContext';
import { RepertoireProvider } from './context/RepertoireContext';
import { EngineProvider } from './context/EngineContext';
import { GameProvider } from './context/GameContext';
import { FileProvider } from './context/FileContext';
import { ErrorProvider } from './context/ErrorContext';
import { RepertoireEvalProvider } from './context/RepertoireEvalContext';
import { SettingsProvider } from './context/SettingsContext';
import { installGlobalHandlers } from './utils/errorLogger';
import './styles/globals.css';

// Capture unhandled errors & rejections before React mounts.
installGlobalHandlers();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsProvider>
      <AuthProvider>
        <ErrorProvider>
          <FileProvider>
            <RepertoireProvider>
              <EngineProvider>
                <GameProvider>
                  <RepertoireEvalProvider>
                    <App />
                    <Analytics />
                  </RepertoireEvalProvider>
                </GameProvider>
              </EngineProvider>
            </RepertoireProvider>
          </FileProvider>
        </ErrorProvider>
      </AuthProvider>
    </SettingsProvider>
  </React.StrictMode>
);
