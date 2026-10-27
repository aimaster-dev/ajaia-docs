// Bundles the API for Vercel into one ES module: dist/vercel/server.mjs
// (loaded by api/index.js). Run by `npm run build:vercel`.
//
// Why bundle: Vercel's Node runtime can't require() a package that ships only
// ES modules, although Node itself can. sanitize-html, for one, loads
// htmlparser2 that way. Bundling resolves every import at build time, so
// nothing is require()d at run time, and cold starts load one file.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/vercel.ts'],
  outfile: 'dist/vercel/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Left as a normal package: its local driver is native code (never loaded on
  // Vercel), and its web client is already plain ES modules.
  external: ['@libsql/client'],
  // CommonJS code inside the bundle still require()s Node's built-in modules.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'warning',
});

console.log('Bundled the API for Vercel: dist/vercel/server.mjs');
