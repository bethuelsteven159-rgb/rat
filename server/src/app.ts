import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import type { DB } from './db/database';
import { JobManager } from './git/ingest';
import { registerAuthorRoutes } from './routes/authors';
import { registerJobRoutes } from './routes/jobs';
import { registerMetricRoutes } from './routes/metrics';
import { registerRepoRoutes } from './routes/repos';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  jobs: JobManager;
  reposDir: string;
}

/** Builds the API app with all routes; `db` and `reposDir` are injectable for tests. */
export async function buildApp(db: DB, reposDir: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' } });
  const ctx: AppContext = { app, db, jobs: new JobManager(), reposDir };

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

  await registerRepoRoutes(app, ctx);
  await registerMetricRoutes(app, ctx);
  await registerAuthorRoutes(app, ctx);
  await registerJobRoutes(app, ctx);
  return app;
}
