import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { listAuthors, mergeAuthors, unmergeAlias } from '../metrics/queries';
import { findRepo, replyError } from './helpers';

export async function registerAuthorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/repos/:id/authors', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    return { authors: listAuthors(ctx.db, repo.id) };
  });

  app.post('/api/repos/:id/authors/merge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const body = (request.body ?? {}) as { targetId?: number; sourceIds?: number[] };
    const targetId = Number(body.targetId);
    const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(Number) : [];
    if (!Number.isInteger(targetId)) return replyError(reply, 400, 'Missing or invalid "targetId"');
    if (sourceIds.length === 0) return replyError(reply, 400, 'Missing "sourceIds" array');
    if (sourceIds.some((s) => !Number.isInteger(s))) {
      return replyError(reply, 400, '"sourceIds" must be integers');
    }
    if (sourceIds.includes(targetId)) {
      return replyError(reply, 400, '"targetId" cannot be one of the "sourceIds"');
    }

    const authors = new Set(
      (listAuthors(ctx.db, repo.id)).map((a) => a.id),
    );
    if (!authors.has(targetId)) return replyError(reply, 404, 'Target author not found');
    for (const sourceId of sourceIds) {
      if (!authors.has(sourceId)) return replyError(reply, 404, `Source author ${sourceId} not found`);
    }

    mergeAuthors(ctx.db, repo.id, targetId, sourceIds);
    return { authors: listAuthors(ctx.db, repo.id) };
  });

  app.post('/api/repos/:id/authors/unmerge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const body = (request.body ?? {}) as { name?: string; email?: string };
    if (!body.name || !body.email) {
      return replyError(reply, 400, 'Missing "name" or "email"');
    }
    const result = unmergeAlias(ctx.db, repo.id, body.name, body.email);
    if (!result.ok) return replyError(reply, 400, result.reason);
    return { authors: listAuthors(ctx.db, repo.id) };
  });
}
