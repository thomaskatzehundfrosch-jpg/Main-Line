import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type BoardTheme = 'classic' | 'ocean' | 'forest' | 'midnight' | 'coral';
export type PieceSet = 'standard' | 'neo' | 'alpha';

export interface AppSettings {
  // Board appearance
  boardTheme: BoardTheme;
  showCoordinates: boolean;
  showLegalMoveHints: boolean;
  showLastMoveHighlight: boolean;
  animateMoves: boolean;

  // Notation
  useFigurineNotation: boolean;

  // Engine defaults
  engineDepth: number;
  engineMultiPV: number;
  engineThreads: number;
  autoStartEngine: boolean;

  // Repertoire behaviour
  defaultColor: 'white' | 'black';
  autoSave: boolean;
  confirmDeleteNode: boolean;

  // UI
  showEvalBar: boolean;
  compactMoveList: boolean;
}

const STORAGE_KEY = 'mainline_settings_v1';

const defaultThreads = Math.max(1, Math.min(16, Math.floor((navigator?.hardwareConcurrency ?? 2) / 2)));

export const DEFAULT_SETTINGS: AppSettings = {
  boardTheme: 'classic',
  showCoordinates: true,
  showLegalMoveHints: true,
  showLastMoveHighlight: true,
  animateMoves: true,

  useFigurineNotation: true,

  engineDepth: 25,
  engineMultiPV: 3,
  engineThreads: defaultThreads,
  autoStartEngine: true,

  defaultColor: 'white',
  autoSave: true,
  confirmDeleteNode: true,

  showEvalBar: true,
  compactMoveList: false,
};

interface SettingsContextValue {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const resetSettings = () => setSettings(DEFAULT_SETTINGS);

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
