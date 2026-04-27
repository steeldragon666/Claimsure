import { useContext } from 'react';
import { ThemeContext, type Theme } from './theme-provider.js';

/**
 * Cheap hook over the ThemeContext.
 *
 * Always returns a Theme — the context default is DEFAULT_THEME so
 * callers never see undefined. That means screens can `const { primary_color } = useTheme()`
 * without null-guards.
 */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
