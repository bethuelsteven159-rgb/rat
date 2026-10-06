import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import {
  authorMetrics,
  objectMetrics,
  repositoryMetrics,
  timeline,
  type TimelineBucket,
} from '../metrics/queries';
import { findRepo, parseMetricFilter, replyError } from './helpers';

const SORTS = new Set(['churn', 'added', 'removed', 'growth', 'modifications', 'path']);
const BUCKETS = new Set(['day', 'week', 'month']);

export async function registerMetricRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/repos/:id/metrics/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    return objectMetrics(ctx.db, repo.id, parsed.filter, {
      kind: 'file',
      pathPrefix: parsed.path,
      sort: query.sort && SORTS.has(query.sort) ? query.sort : 'churn',
      limit: query.limit ? Number(query.limit) : 100,
    });
  });

  app.get('/api/repos/:id/metrics/dirs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    return objectMetrics(ctx.db, repo.id, parsed.filter, {
      kind: 'dir',
      pathPrefix: parsed.path,
      sort: query.sort && SORTS.has(query.sort) ? query.sort : 'churn',
      limit: query.limit ? Number(query.limit) : 200,
    });
  });

  app.get('/api/repos/:id/metrics/repository', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    return repositoryMetrics(ctx.db, repo.id, parsed.filter, parsed.path);
  });

  app.get('/api/repos/:id/metrics/authors', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    return authorMetrics(
      ctx.db,
      repo.id,
      parsed.filter,
      parsed.path,
      query.limit ? Number(query.limit) : 100,
    );
  });

  app.get('/api/repos/:id/timeline', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    const bucket =
      query.bucket && BUCKETS.has(query.bucket) ? (query.bucket as TimelineBucket) : 'month';
    return {
      points: timeline(ctx.db, repo.id, parsed.filter, bucket, parsed.path),
    };
  });
}
