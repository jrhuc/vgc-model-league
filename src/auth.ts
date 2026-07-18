import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type UserRole = 'reader' | 'contributor' | 'operator';

export interface AuthUser {
  id: number;
  providerSubject: string;
  login: string;
  avatarUrl: string;
  role: UserRole;
}

export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: number;
}

interface AuthOptions {
  dbPath: string;
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  operatorSubjects?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
}

interface OAuthUser {
  id?: unknown;
  login?: unknown;
  avatar_url?: unknown;
}

const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_FLOW_AGE_MS = 10 * 60 * 1000;
const ROLE_RANK: Record<UserRole, number> = { reader: 0, contributor: 1, operator: 2 };
const requireFromHere = createRequire(import.meta.url);

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AuthService {
  private readonly db: DatabaseSync;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly redirectUri: string;
  private readonly operatorSubjects: ReadonlySet<string>;

  constructor(private readonly options: AuthOptions) {
    const sqlite = requireFromHere('node:sqlite') as { DatabaseSync: new (location: string) => DatabaseSync };
    this.db = new sqlite.DatabaseSync(options.dbPath);
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.redirectUri = `${options.publicOrigin}/auth/github/callback`;
    this.operatorSubjects = new Set(options.operatorSubjects ?? []);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.recoverInterruptedExperiments();
  }

  close(): void {
    this.db.close();
  }

  ready(): void {
    this.db.prepare('SELECT 1').get();
  }

  private recoverInterruptedExperiments(): void {
    const interrupted = this.db
      .prepare("SELECT run_id, owner_user_id FROM experiments WHERE status = 'running'")
      .all() as Array<{ run_id: string; owner_user_id: number }>;
    if (!interrupted.length) return;
    const timestamp = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE experiments SET status = 'failed', ended_at = ? WHERE status = 'running'").run(timestamp);
      for (const row of interrupted) {
        this.insertAudit(
          row.owner_user_id,
          'experiment.failed',
          'experiment',
          row.run_id,
          { reason: 'server_restart' },
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  beginLogin(): { location: string; state: string } {
    this.cleanup();
    const state = randomToken();
    const verifier = randomToken();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.db
      .prepare('INSERT INTO oauth_flows (state_hash, code_verifier, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(state), verifier, this.now() + OAUTH_FLOW_AGE_MS);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { location: url.href, state };
  }

  async completeLogin(
    code: string,
    state: string,
    stateCookie: string | undefined,
    currentSessionToken: string | undefined,
  ): Promise<{ sessionToken: string; session: AuthSession }> {
    if (!code || !stateCookie || !safeEqual(state, stateCookie)) throw new AuthError(400, 'invalid OAuth state');
    const flow = this.db
      .prepare('DELETE FROM oauth_flows WHERE state_hash = ? RETURNING code_verifier, expires_at')
      .get(hashToken(state)) as { code_verifier?: unknown; expires_at?: unknown } | undefined;
    if (!flow || typeof flow.code_verifier !== 'string' || Number(flow.expires_at) < this.now()) {
      throw new AuthError(400, 'OAuth flow expired or was already used');
    }

    const tokenResponse = await this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code,
        redirect_uri: this.redirectUri,
        code_verifier: flow.code_verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = await responseJson(tokenResponse, 'GitHub token exchange');
    const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
    if (!tokenResponse.ok || !accessToken) throw new AuthError(502, 'GitHub token exchange failed');

    const userResponse = await this.request('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'vgc-model-league',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const profile = (await responseJson(userResponse, 'GitHub identity lookup')) as OAuthUser;
    const subject = typeof profile.id === 'number' && Number.isSafeInteger(profile.id) ? String(profile.id) : '';
    const login = typeof profile.login === 'string' ? profile.login.trim().slice(0, 255) : '';
    const avatarUrl = typeof profile.avatar_url === 'string' ? profile.avatar_url.slice(0, 1000) : '';
    if (!userResponse.ok || !subject || !login) throw new AuthError(502, 'GitHub identity lookup failed');

    const timestamp = this.now();
    const role: UserRole = this.operatorSubjects.has(subject) ? 'operator' : 'contributor';
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = timestamp + SESSION_AGE_MS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.db
        .prepare(
          `INSERT INTO users (provider, provider_subject, login, avatar_url, role, created_at, updated_at)
           VALUES ('github', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, provider_subject) DO UPDATE SET
             login = excluded.login,
             avatar_url = excluded.avatar_url,
             updated_at = excluded.updated_at,
             role = CASE WHEN excluded.role = 'operator' THEN 'operator' ELSE users.role END
           RETURNING id, provider_subject, login, avatar_url, role`,
        )
        .get(subject, login, avatarUrl, role, timestamp, timestamp) as Record<string, unknown>;
      if (currentSessionToken)
        this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(currentSessionToken));
      this.db
        .prepare(
          'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(hashToken(sessionToken), Number(user.id), csrfToken, timestamp, expiresAt);
      this.insertAudit(Number(user.id), 'auth.login', 'session', null, { provider: 'github' }, timestamp);
      this.db.exec('COMMIT');
      return { sessionToken, session: { user: authUser(user), csrfToken, expiresAt } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  session(sessionToken: string | undefined): AuthSession | undefined {
    if (!sessionToken) return undefined;
    const row = this.db
      .prepare(
        `SELECT users.id, users.provider_subject, users.login, users.avatar_url, users.role,
                sessions.csrf_token, sessions.expires_at
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(hashToken(sessionToken), this.now()) as Record<string, unknown> | undefined;
    if (!row || typeof row.csrf_token !== 'string') return undefined;
    return { user: authUser(row), csrfToken: row.csrf_token, expiresAt: Number(row.expires_at) };
  }

  authorize(sessionToken: string | undefined, csrfToken: string | undefined, minimumRole: UserRole): AuthSession {
    const session = this.session(sessionToken);
    if (!session) throw new AuthError(401, 'authentication required');
    if (!csrfToken || !safeEqual(csrfToken, session.csrfToken)) throw new AuthError(403, 'invalid CSRF token');
    if (ROLE_RANK[session.user.role] < ROLE_RANK[minimumRole]) throw new AuthError(403, 'insufficient role');
    return session;
  }

  logout(sessionToken: string | undefined, csrfToken: string | undefined): void {
    const session = this.authorize(sessionToken, csrfToken, 'reader');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken!));
      this.insertAudit(session.user.id, 'auth.logout', 'session', null, {}, this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordPool(user: AuthUser, poolId: string, format: string): void {
    const timestamp = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO published_pools (pool_id, format, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
        .run(poolId, format, user.id, timestamp);
      this.insertAudit(user.id, 'pool.publish', 'pool', poolId, { format }, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordValidation(user: AuthUser, format: string): void {
    this.insertAudit(user.id, 'team.validate', 'team', null, { format }, this.now());
  }

  recordModelDiscovery(user: AuthUser, provider: string): void {
    this.insertAudit(user.id, 'models.discover', 'provider', provider, {}, this.now());
  }

  startExperiment(user: AuthUser, runId: string, pool: string, config: unknown): void {
    const timestamp = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO experiments (run_id, pool_id, owner_user_id, status, config_json, created_at)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(runId, pool, user.id, JSON.stringify(config), timestamp);
      this.insertAudit(user.id, 'experiment.start', 'experiment', runId, { pool }, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishExperiment(runId: string, status: 'done' | 'failed'): void {
    const timestamp = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('UPDATE experiments SET status = ?, ended_at = ? WHERE run_id = ? RETURNING owner_user_id')
        .get(status, timestamp, runId) as { owner_user_id?: unknown } | undefined;
      if (row) this.insertAudit(Number(row.owner_user_id), `experiment.${status}`, 'experiment', runId, {}, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stopExperiment(user: AuthUser, runId: string): void {
    if (!this.canControlExperiment(user, runId))
      throw new AuthError(403, 'only the run owner or an operator can stop it');
    this.insertAudit(user.id, 'experiment.stop', 'experiment', runId, {}, this.now());
  }

  canControlExperiment(user: AuthUser, runId: string): boolean {
    if (user.role === 'operator') return true;
    const row = this.db.prepare('SELECT owner_user_id FROM experiments WHERE run_id = ?').get(runId) as
      | { owner_user_id?: unknown }
      | undefined;
    return Number(row?.owner_user_id) === user.id;
  }

  private cleanup(): void {
    const timestamp = this.now();
    this.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(timestamp);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp);
  }

  private insertAudit(
    actorUserId: number,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: unknown,
    timestamp: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actorUserId, action, resourceType, resourceId, JSON.stringify(metadata), timestamp);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
    if (applied) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          provider_subject TEXT NOT NULL,
          login TEXT NOT NULL,
          avatar_url TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('reader', 'contributor', 'operator')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (provider, provider_subject)
        ) STRICT;
        CREATE TABLE sessions (
          token_hash BLOB PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sessions_expires_at ON sessions(expires_at);
        CREATE TABLE oauth_flows (
          state_hash BLOB PRIMARY KEY,
          code_verifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX oauth_flows_expires_at ON oauth_flows(expires_at);
        CREATE TABLE published_pools (
          pool_id TEXT PRIMARY KEY,
          format TEXT NOT NULL,
          owner_user_id INTEGER NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE experiments (
          run_id TEXT PRIMARY KEY,
          pool_id TEXT NOT NULL,
          owner_user_id INTEGER NOT NULL REFERENCES users(id),
          status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          ended_at INTEGER
        ) STRICT;
        CREATE INDEX experiments_owner_user_id ON experiments(owner_user_id);
        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY,
          actor_user_id INTEGER NOT NULL REFERENCES users(id),
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          metadata_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX audit_events_actor_user_id ON audit_events(actor_user_id);
        CREATE INDEX audit_events_created_at ON audit_events(created_at);
      `);
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function authUser(row: Record<string, unknown>): AuthUser {
  const role = row.role;
  if (role !== 'reader' && role !== 'contributor' && role !== 'operator') throw new Error('invalid stored user role');
  return {
    id: Number(row.id),
    providerSubject: String(row.provider_subject),
    login: String(row.login),
    avatarUrl: String(row.avatar_url),
    role,
  };
}

async function responseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > 64_000) throw new AuthError(502, `${operation} returned too much data`);
  if (!response.body) throw new AuthError(502, `${operation} returned an invalid response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      break;
    }
    size += value.byteLength;
    if (size > 64_000) {
      await reader.cancel();
      throw new AuthError(502, `${operation} returned too much data`);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new AuthError(502, `${operation} returned an invalid response`);
}
