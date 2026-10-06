import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../app';
import { config } from '../config';
import { ingestRepository, slugify, type Job } from '../git/ingest';
import { listCommits } from '../metrics/queries';
import { findRepo, parseMetricFilter, replyError } from './helpers';

/** Runs ingestion in the background; failures land on the job, not the request. */
function startIngest(
  ctx: AppContext,
  input: { sourceType: 'url' | 'zip'; source: string; name?: string },
  job: Job,
): void {
  void ingestRepository({ db: ctx.db, reposDir: ctx.reposDir }, input, job).catch(() => {
    ctx.app.log.warn(`ingestion job ${job.id} (${job.repoName}) failed: ${job.error}`);
  });
}

export async function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/repos', async () => {
    return ctx.db
      .prepare(
        `SELECT id, name, status, source_type AS sourceType, source_ref AS sourceRef,
                head_hash AS headHash, head_subject AS headSubject, ingested_at AS ingestedAt,
                commit_count AS commitCount, file_count AS fileCount, dir_count AS dirCount,
                first_ts AS firstTs, last_ts AS lastTs
           FROM repositories ORDER BY name`,
      )
      .all();
  });

  app.get('/api/repos/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    const authorCount = (
      ctx.db
        .prepare('SELECT COUNT(*) AS n FROM canonical_authors WHERE repo_id = ?')
        .get(repo.id) as { n: number }
    ).n;
    return { ...repo, authorCount };
  });

  app.post('/api/repos/url', async (request, reply) => {
    const body = (request.body ?? {}) as { url?: string; name?: string };
    const url = body.url?.trim();
    if (!url) return replyError(reply, 400, 'Missing "url" field');

    const job = ctx.jobs.create(url);
    startIngest(ctx, { sourceType: 'url', source: url, name: body.name?.trim() || undefined }, job);
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/api/repos/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return replyError(reply, 400, 'Expected a multipart upload with a "file" field');
    }
    await mkdir(config.dataDir, { recursive: true });
    const tmpZip = path.join(
      config.dataDir,
      `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
    );
    let name: string | undefined;
    let sawFile = false;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') continue;
          await pipeline(part.file, createWriteStream(tmpZip));
          sawFile = true;
        } else if (part.fieldname === 'name') {
          name = String(part.value).trim() || undefined;
        }
      }
    } catch (err) {
      await unlink(tmpZip).catch(() => {});
      return replyError(reply, 400, `Upload failed: ${(err as Error).message}`);
    }

    if (!sawFile) {
      await unlink(tmpZip).catch(() => {});
      return replyError(reply, 400, 'Missing zip file in "file" field');
    }

    const job = ctx.jobs.create(name ?? 'zip upload');
    startIngest(ctx, { sourceType: 'zip', source: tmpZip, name }, job);
    return reply.code(202).send({ jobId: job.id });
  });

  app.delete('/api/repos/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    ctx.db.prepare('DELETE FROM repositories WHERE id = ?').run(repo.id);
    await rm(path.join(ctx.reposDir, `${repo.id}-${slugify(repo.name)}`), {
      recursive: true,
      force: true,
    });
    return reply.code(204).send();
  });

  app.get('/api/repos/:id/commits', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = findRepo(ctx.db, Number(id));
    if (!repo) return replyError(reply, 404, `Repository ${id} not found`);
    if (repo.status !== 'ready') {
      return replyError(reply, 409, `Repository "${repo.name}" is still ${repo.status}`);
    }
    const query = request.query as Record<string, string | undefined>;
    const parsed = parseMetricFilter(query);
    if ('error' in parsed) return replyError(reply, 400, parsed.error);
    const limit = query.limit ? Number(query.limit) : 100;
    const offset = query.offset ? Number(query.offset) : 0;
    return listCommits(ctx.db, repo.id, parsed.filter, limit, offset);
  });
}
