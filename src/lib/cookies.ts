export const SESSION_COOKIE_NAME = 'jobbook_session'
// Pre-account-auth cookie name. Still accepted as a valid session (same token
// format/secret) so Mike's live session survives the cutover; cleared on
// login/logout so it ages out.
export const LEGACY_SESSION_COOKIE_NAME = 'pilot_session'

export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

// Browsers only delete a cookie if the clearing Set-Cookie uses the same
// Domain/Path/Secure/SameSite attributes that were present when it was set.
export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? ('none' as const) : ('lax' as const),
    domain: isProduction ? (process.env.COOKIE_DOMAIN ?? '.thejobbook.app') : undefined,
    path: '/',
  }
}
