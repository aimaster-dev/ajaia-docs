// Vercel runs this file as a serverless function for every /api/* request
// (vercel.json sends them here). It starts the compiled Express app once per
// instance (built to dist/server by `npm run build`) and hands it each request.
// Plain JavaScript on purpose, so Vercel doesn't compile any TypeScript itself.

let app;

export default async function handler(req, res) {
  try {
    app ??= import('../dist/server/vercel.js').then((m) => m.createVercelApp());
    const express = await app;
    express(req, res);
  } catch (err) {
    app = undefined; // start again on the next request (e.g. once settings are fixed)
    console.error('Ajaia Docs could not start:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    const message = err?.expose ? err.message : 'The server could not start. Check the function logs in Vercel.';
    res.end(JSON.stringify({ error: { code: 'server_not_ready', message } }));
  }
}
