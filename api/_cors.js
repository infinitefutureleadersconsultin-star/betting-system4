// api/_cors.js
// Small, dependency-free CORS helper for Vercel/Node ESM.
// Returns `false` if it handled the request (OPTIONS/405), otherwise `true`.

export function runCors(req, res, opts = {}) {
  const {
    origin = process.env.CORS_ORIGIN || "*",
    methods = ["POST"],                // allowed app methods for this route
    headers = "Content-Type, Authorization",
    credentials = false,               // set true if you need cookies/credentials
  } = opts;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ["OPTIONS", ...methods].join(", "));
  res.setHeader("Access-Control-Allow-Headers", headers);
  if (credentials) res.setHeader("Access-Control-Allow-Credentials", "true");

  // Preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return false; // tell caller we already responded
  }

  // Method guard (405)
  if (!methods.includes(req.method)) {
    res.setHeader("Allow", ["OPTIONS", ...methods]);
    res.status(405).json({ error: "Method Not Allowed" });
    return false;
  }

  return true; // proceed
}

// Provide a default export so `import runCors from "./_cors.js"` works.
export default runCors;
