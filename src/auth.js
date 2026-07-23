// Clerk JWT verification — same JWKS pattern as the usegoblin site
// (Goblin_Labs/api/_auth.ts), so one Clerk account works on both surfaces.
// Verification is stateless: Clerk's public JWKS, no secret key needed.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = process.env.CLERK_ISSUER || 'https://clerk.usegoblin.xyz';
// Default ON: the whole point is gating who builds with Kara. REQUIRE_AUTH=0
// is the local-dev escape hatch (curl tests, rehearsals without a browser).
const REQUIRED = (process.env.REQUIRE_AUTH ?? '1') !== '0';

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export const authRequired = REQUIRED;

// Returns the Clerk user id for a raw JWT, or null if missing/invalid.
// Exists apart from verifyBearer because EventSource can't set headers, so
// the SSE endpoint receives its token as a query param instead.
export async function verifyToken(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

// Returns the Clerk user id, or null if the token is missing/invalid.
export async function verifyBearer(req) {
  const auth = req.headers.authorization ?? '';
  return verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : null);
}

// Express middleware for the endpoints that cost money (Anam minutes, model
// tokens). Attaches req.userId; 401s when auth is on and the token is bad.
export async function requireAuth(req, res, next) {
  const userId = await verifyBearer(req);
  if (REQUIRED && !userId) {
    return res.status(401).json({ error: 'auth_required' });
  }
  req.userId = userId; // may be null when REQUIRE_AUTH=0
  next();
}
