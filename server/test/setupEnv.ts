import path from 'node:path';

// Redirects RAT_DATA_DIR before src/config.ts is imported by any test, so
// uploaded zips created during tests land in test/.tmp-data instead of the
// real data/ directory. Vitest invokes this file with cwd = server package.
process.env.RAT_DATA_DIR = path.join(process.cwd(), 'test', '.tmp-data');
