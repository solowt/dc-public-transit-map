import { create, verify, getNumericDate } from "@zaubrik/djwt";

const jwtKey = await crypto.subtle.generateKey(
  { name: "HMAC", hash: "SHA-512" },
  true,
  ["sign", "verify"],
);

const ACCESS_TOKEN_LIFETIME = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_LIFETIME = 7 * 24 * 60 * 60; // 7 days in seconds
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes in ms

interface RefreshTokenEntry {
  expiresAt: number;
}

const refreshTokens = new Map<string, RefreshTokenEntry>();

// Prune expired refresh tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of refreshTokens) {
    if (entry.expiresAt <= now) {
      refreshTokens.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

async function createJwt(sub: string): Promise<{ token: string; exp: number }> {
  const exp = getNumericDate(ACCESS_TOKEN_LIFETIME);
  const token = await create(
    { alg: "HS512", typ: "JWT" },
    { sub, exp },
    jwtKey,
  );
  return { token, exp };
}

function makeRefreshCookie(id: string): string {
  return `refresh_token=${id}; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=${REFRESH_TOKEN_LIFETIME}`;
}

export async function createTokens(): Promise<{
  accessToken: string;
  refreshTokenCookie: string;
  exp: number;
}> {
  const refreshTokenId = crypto.randomUUID();
  refreshTokens.set(refreshTokenId, {
    expiresAt: Date.now() + REFRESH_TOKEN_LIFETIME * 1000,
  });

  const { token, exp } = await createJwt(refreshTokenId);
  return {
    accessToken: token,
    refreshTokenCookie: makeRefreshCookie(refreshTokenId),
    exp,
  };
}

export async function refreshAccessToken(
  cookieHeader: string | null,
): Promise<{
  accessToken: string;
  refreshTokenCookie: string;
  exp: number;
} | null> {
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/(?:^|;\s*)refresh_token=([^\s;]+)/);
  if (!match) return null;

  const oldId = match[1];
  const entry = refreshTokens.get(oldId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    refreshTokens.delete(oldId);
    return null;
  }

  // Rotate: delete old, issue new
  refreshTokens.delete(oldId);

  const newId = crypto.randomUUID();
  refreshTokens.set(newId, {
    expiresAt: Date.now() + REFRESH_TOKEN_LIFETIME * 1000,
  });

  const { token, exp } = await createJwt(newId);
  return {
    accessToken: token,
    refreshTokenCookie: makeRefreshCookie(newId),
    exp,
  };
}

export async function verifyAccessToken(
  token: string,
): Promise<{ sub: string; exp: number } | null> {
  try {
    const payload = await verify(token, jwtKey);
    return { sub: payload.sub as string, exp: payload.exp as number };
  } catch {
    return null;
  }
}
