import * as crypto from 'crypto';
import * as express from 'express';
import * as https from 'https';

const JWT_ALGORITHM = 'RS256';
const JWKS_PATH = '/cdn-cgi/access/certs';
const JWKS_TIMEOUT_MS = 5000;
const JWKS_REFRESH_INTERVAL_MS = 10000;
const CLOCK_TOLERANCE_SECONDS = 10;

interface CloudflareAccessJwtHeader {
    readonly alg: string;
    readonly kid: string;
}

interface CloudflareAccessJwk extends crypto.JsonWebKey {
    readonly kid: string;
}

interface CloudflareAccessJwks {
    readonly keys: CloudflareAccessJwk[];
}

export interface CloudflareAccessJwtPayload {
    readonly aud: string[];
    readonly country?: string;
    readonly email?: string;
    readonly exp: number;
    readonly iat?: number;
    readonly identity_nonce?: string;
    readonly iss: string;
    readonly nbf?: number;
    readonly sub?: string;
    readonly type: string;
    readonly [claim: string]: unknown;
}

export interface CloudflareAccessUser {
    readonly country: string | null;
    readonly email: string | null;
    readonly id: string | null;
    readonly claims: CloudflareAccessJwtPayload;
}

declare global {
    namespace Express {
        interface Request {
            cloudflareAccessUser?: CloudflareAccessUser;
        }
    }
}

class InvalidCloudflareAccessTokenError extends Error {}

class CloudflareAccessKeyStore {
    private readonly certsUrl: URL;
    private keys = new Map<string, crypto.KeyObject>();
    private lastSuccessfulRefreshAt = 0;
    private refreshPromise: Promise<void> | null = null;

    constructor(teamDomain: string) {
        this.certsUrl = new URL(JWKS_PATH, teamDomain);
    }

    public async getKey(keyId: string): Promise<crypto.KeyObject> {
        let key = this.keys.get(keyId);
        if (typeof key !== 'undefined') {
            return key;
        }

        if (this.refreshPromise !== null || Date.now() - this.lastSuccessfulRefreshAt >= JWKS_REFRESH_INTERVAL_MS) {
            await this.refreshKeys();
            key = this.keys.get(keyId);
        }

        if (typeof key === 'undefined') {
            throw new InvalidCloudflareAccessTokenError('Unknown JWT signing key');
        }

        return key;
    }

    private refreshKeys(): Promise<void> {
        if (this.refreshPromise !== null) {
            return this.refreshPromise;
        }

        this.refreshPromise = getHttpsResponse(this.certsUrl)
            .then(body => {
                const jwks = JSON.parse(body) as CloudflareAccessJwks;
                this.keys = new Map(
                    jwks.keys.map(key => [
                        key.kid,
                        crypto.createPublicKey({
                            format: 'jwk',
                            key,
                        }),
                    ]),
                );
                this.lastSuccessfulRefreshAt = Date.now();
            })
            .finally(() => {
                this.refreshPromise = null;
            });

        return this.refreshPromise;
    }
}

const getHttpsResponse = (url: URL): Promise<string> => {
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers: {
                    Accept: 'application/json',
                },
            },
            response => {
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Cloudflare Access JWKS request failed with status ${response.statusCode ?? 0}`));
                    return;
                }

                response.setEncoding('utf8');
                let body = '';
                response.on('data', (chunk: string) => (body += chunk));
                response.on('end', () => resolve(body));
                response.on('error', reject);
            },
        );

        request.setTimeout(JWKS_TIMEOUT_MS, () =>
            request.destroy(new Error('Cloudflare Access JWKS request timed out')),
        );
        request.on('error', reject);
    });
};

const decodeJwtPart = <T>(encoded: string): T => {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
};

const validatePayload = (
    payload: CloudflareAccessJwtPayload,
    expectedIssuer: string,
    expectedAudience: string,
): void => {
    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== expectedIssuer || payload.aud.includes(expectedAudience) === false) {
        throw new InvalidCloudflareAccessTokenError('JWT claims do not match this Cloudflare Access application');
    }

    if (payload.exp <= now - CLOCK_TOLERANCE_SECONDS) {
        throw new InvalidCloudflareAccessTokenError('JWT is expired');
    }

    if (typeof payload.nbf !== 'undefined' && payload.nbf > now + CLOCK_TOLERANCE_SECONDS) {
        throw new InvalidCloudflareAccessTokenError('JWT is not active');
    }
};

const verifyToken = async (
    token: string,
    keyStore: CloudflareAccessKeyStore,
    expectedIssuer: string,
    expectedAudience: string,
): Promise<CloudflareAccessJwtPayload> => {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new InvalidCloudflareAccessTokenError('Invalid JWT format');
    }

    const header = decodeJwtPart<CloudflareAccessJwtHeader>(parts[0]);
    if (header.alg !== JWT_ALGORITHM) {
        throw new InvalidCloudflareAccessTokenError('Invalid JWT algorithm');
    }

    const key = await keyStore.getKey(header.kid);
    const signatureIsValid = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
        key,
        Buffer.from(parts[2], 'base64url'),
    );

    if (signatureIsValid === false) {
        throw new InvalidCloudflareAccessTokenError('Invalid JWT signature');
    }

    const payload = decodeJwtPart<CloudflareAccessJwtPayload>(parts[1]);
    validatePayload(payload, expectedIssuer, expectedAudience);
    return payload;
};

export const createCloudflareAccessMiddleware = (
    logWarning: (message: string) => void,
): express.RequestHandler | null => {
    const configuredTeamDomain = process.env.CF_ACCESS_TEAM_DOMAIN ?? '';
    const audience = process.env.CF_ACCESS_AUD ?? '';

    if (configuredTeamDomain.length === 0 || audience.length === 0) {
        return null;
    }

    const teamDomain = `https://${configuredTeamDomain}`;
    const keyStore = new CloudflareAccessKeyStore(teamDomain);

    return async (req, _res, next): Promise<void> => {
        const token = req.header('Cf-Access-Jwt-Assertion');
        if (typeof token === 'undefined') {
            logWarning(`Cloudflare Access user parsing skipped for ${req.method} ${req.originalUrl}: missing token`);
            next();
            return;
        }

        try {
            const claims = await verifyToken(token, keyStore, teamDomain, audience);
            req.cloudflareAccessUser = {
                country: claims.country ?? null,
                email: claims.email ?? null,
                id: claims.sub ?? null,
                claims,
            };
            next();
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            logWarning(`Cloudflare Access user parsing failed for ${req.method} ${req.originalUrl}: ${reason}`);
            next();
        }
    };
};
