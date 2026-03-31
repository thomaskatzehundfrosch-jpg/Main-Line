import type { BoardTheme } from '../../context/SettingsContext';

export const BOARD_THEME_COLORS: Record<BoardTheme, { light: string; dark: string }> = {
  classic: { light: '#e8dcc0', dark: '#4b6fa0' },
  ocean: { light: '#d4e8e8', dark: '#2d7d7d' },
  forest: { light: '#d9e8c0', dark: '#3d6b3d' },
  midnight: { light: '#cdd5e0', dark: '#3a4466' },
  coral: { light: '#f0d9d0', dark: '#b05050' },
};
