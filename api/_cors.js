// api/_cors.js
import corsPkg from 'cors';

// Make it ESM/CJS agnostic
const corsFn = (corsPkg && corsPkg.default) ? corsPkg.default : corsPkg;

/**
 * Run CORS safely. We construct the middleware INSIDE the handler
 * so nothing executes at import-time anymore.
 */
export function runCors(req, res) {
  const corsMiddleware = corsFn({
    origin: true,             // reflect request origin
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  return new Promise((resolve, reject) => {
    try {
      corsMiddleware(req, res, (result) => {
        if (result instanceof Error) return reject(result);
        resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}
