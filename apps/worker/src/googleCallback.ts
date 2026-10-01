import { GOOGLE_CALLBACK_PATH, handleGoogleSignIn } from '@codefusion-cc/google-sign-in'
import { allowedOrigins, type Env } from './env.ts'

/**
 * Google's redirect back to the site: the page it lands on, drawn in the dashboard's background so it never
 * flashes white, and the hand-off that sends the token to /login on one of our origins.
 */
export async function handleGoogleCallback(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== GOOGLE_CALLBACK_PATH) return null
  return handleGoogleSignIn(request, {
    allowedOrigin: origin => allowedOrigins(env).includes(origin),
    page: { background: { light: '#f6f7fb', dark: '#0f1117' } },
  })
}
