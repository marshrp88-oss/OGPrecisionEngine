import type { Request, Response, NextFunction } from "express";
import { scheduleIntegrityRevalidation } from "../lib/integrity";

const WATCHED_PREFIXES = [
  "/api/bills",
  "/api/balances",
  "/api/assumptions",
  "/api/one-time-expenses",
  "/api/retirement",
  "/api/commissions",
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Fires an integrity revalidation after any successful mutating write to a
 * watched route. Non-blocking — runs after response is flushed. Skips:
 *  - the integrity routes themselves (avoid recursion)
 *  - non-2xx responses (writes that failed)
 */
export function integrityRevalidateMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.path.startsWith("/api/integrity")) {
    next();
    return;
  }
  if (!WATCHED_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      scheduleIntegrityRevalidation(`${req.method} ${req.path}`);
    }
  });

  next();
}
