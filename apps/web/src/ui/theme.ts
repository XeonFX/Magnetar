import { createTheme } from '@codefusion-cc/theme/browser'
import { themeConfig } from './themeConfig.ts'

/** The page's theme: follows the system and the other tabs; `useTheme(theme)` from @codefusion-cc/theme/react reads it. */
export const theme = createTheme(themeConfig)
