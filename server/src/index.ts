import { mkdirSync } from 'node:fs';
import { buildApp } from './app';
import { config, reposDir } from './config';
import { openDatabase } from './db/database';
import { checkGitAvailable } from './git/git';

async function main(): Promise<void> {
  if (!(await checkGitAvailable())) {
    console.error('RAT requires git to be installed and available on PATH.');
    process.exit(1);
  }
  mkdirSync(reposDir(), { recursive: true });

  const db = openDatabase();
  const app = await buildApp(db, reposDir());
  await app.listen({ port: config.port, host: '0.0.0.0' });

  console.log(`RAT server listening on http://localhost:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
