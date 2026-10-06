import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';

export async function registerJobRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/jobs', async () => {
    return { jobs: ctx.jobs.list() };
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = ctx.jobs.get(id);
    if (!job) return reply.code(404).send({ error: `Job ${id} not found` });
    return job;
  });
}
