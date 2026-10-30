// Drives an express.Router() directly with a fake req/res pair, so route
// handlers can be tested without starting a server or adding supertest.
//
// An express Router is just a callable middleware stack -- `router.handle(req,
// res, next)` is exactly what app.use() ends up doing per request, with the
// mount prefix already stripped from req.url. Calling it ourselves exercises
// the real handler, the real validation, and the real status codes; only the
// socket is missing.
//
// What this deliberately does NOT cover: anything the surrounding app.use()
// chain adds. server.ts mounts most routers behind requireAuth (and budget's
// behind requireUnlocked too), so a router driven here is being tested as if
// that gate had already passed -- which is the right unit, since those gates
// have their own tests in auth.test.ts.

import type express from "express";

export interface FakeSession {
  userId?: string;
  unlockedUntil?: number;
  lockTrusted?: boolean;
  destroy?: (cb: () => void) => void;
  regenerate?: (cb: (err?: any) => void) => void;
  [key: string]: any;
}

export interface RouteResponse {
  status: number;
  body: any;
  /** True when no handler matched and the request fell through to next(). */
  fellThrough: boolean;
  /** Set when a handler passed an error to next(err). */
  error?: any;
  /** Headers the handler set with res.setHeader, lower-cased. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  session?: FakeSession;
  sessionID?: string;
  /** Set by deviceTokenAuth for a Wear OS `Authorization: Bearer` request (no session at all). */
  deviceUserId?: string;
  /** The caller's address, as Express reports it in req.ip (the rate limiter keys on it). */
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Parsed query string. Express populates req.query at the app level, not in
   *  the Router, so a router driven directly needs it supplied here. */
  query?: Record<string, string>;
}

/**
 * Sends one request through a router and resolves once the handler has
 * responded (or fallen through). Async handlers are common here -- bcrypt
 * comparisons especially -- so this resolves on the response, not on
 * handle() returning.
 */
export function callRoute(
  router: express.Router,
  method: string,
  url: string,
  opts: RequestOptions = {}
): Promise<RouteResponse> {
  const session: FakeSession = opts.session ?? {};
  // req.session.destroy is a real method on an express-session session; logout
  // calls it, so a fake without one would throw rather than fail a test
  // meaningfully.
  if (!session.destroy) {
    session.destroy = (cb: () => void) => {
      for (const key of Object.keys(session)) {
        if (key !== "destroy") delete session[key];
      }
      cb();
    };
  }
  // Real express-session mints a fresh session id and clears prior data;
  // this fake keeps the same object identity (tests hold a reference to it)
  // but drops every field the way a genuinely new session would.
  if (!session.regenerate) {
    session.regenerate = (cb: (err?: any) => void) => {
      for (const key of Object.keys(session)) {
        if (key !== "destroy" && key !== "regenerate") delete session[key];
      }
      cb();
    };
  }

  const req: any = {
    method: method.toUpperCase(),
    url,
    originalUrl: url,
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    session,
    deviceUserId: opts.deviceUserId,
    sessionID: opts.sessionID ?? "test-session",
    ip: opts.ip,
    params: {},
    query: opts.query ?? {},
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };

  return new Promise<RouteResponse>((resolve) => {
    let settled = false;
    const finish = (result: RouteResponse) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, headers: res.headers });
    };

    const res: any = {
      statusCode: 200,
      headersSent: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.headersSent = true;
        finish({ status: this.statusCode, body: payload, fellThrough: false });
        return this;
      },
      send(payload: unknown) {
        this.headersSent = true;
        finish({ status: this.statusCode, body: payload, fellThrough: false });
        return this;
      },
      end() {
        this.headersSent = true;
        finish({ status: this.statusCode, body: undefined, fellThrough: false });
        return this;
      },
      type() {
        return this;
      },
      // Express's res.redirect([status,] url): the target lands in headers.location.
      redirect(statusOrUrl: number | string, maybeUrl?: string) {
        const [code, url] = typeof statusOrUrl === "number" ? [statusOrUrl, maybeUrl!] : [302, statusOrUrl];
        this.statusCode = code;
        this.headers.location = url;
        this.headersSent = true;
        finish({ status: code, body: undefined, fellThrough: false });
        return this;
      },
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name: string) {
        return this.headers[name.toLowerCase()];
      },
      removeHeader() {},
    };

    (router as any).handle(req, res, (err?: any) => {
      finish({ status: res.statusCode, body: undefined, fellThrough: true, error: err });
    });
  });
}

/** Runs one middleware (requireAuth, requireUnlocked, ...) and reports whether
 *  it called next() or answered the request itself. */
export function callMiddleware(
  middleware: (req: any, res: any, next: (err?: any) => void) => void,
  opts: RequestOptions = {}
): Promise<{ passed: boolean; status: number; body: any; session: FakeSession }> {
  const session: FakeSession = opts.session ?? {};
  const req: any = {
    method: "GET",
    url: "/",
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    session,
    sessionID: opts.sessionID ?? "test-session",
  };

  return new Promise((resolve) => {
    let settled = false;
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        if (!settled) {
          settled = true;
          resolve({ passed: false, status: this.statusCode, body: payload, session });
        }
        return this;
      },
    };

    middleware(req, res, () => {
      if (!settled) {
        settled = true;
        resolve({ passed: true, status: res.statusCode, body: undefined, session });
      }
    });
  });
}
