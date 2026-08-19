import type { FastifyPluginAsync } from 'fastify'
import {
  createManualWorkshopItem,
  getWorkshop,
  markWorkshopItemUsedUp,
  markWorkshopItemWasntThere,
  moveLeftoverToWorkshop,
  patchWorkshopItem,
  putWorkshopItemBack,
  undoMoveWorkshopItem,
} from '../services/workshop.js'
import { handleServiceError } from './jobs.js'

// Workshop routes. The move action is registered under the source job because
// it is an action on a job's leftover; everything else is global, because the
// Workshop itself belongs to Mike's book rather than to any one job.
//
// No route here accepts a supplier, price, Budget category, location or unit,
// and none writes to a memory item, Budget category, Money event or job.
const workshopRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/workshop — Book Home summary + the currently available items.
  // Read-only: opening the Workshop creates and resolves nothing.
  fastify.get('/api/workshop', async (request, reply) => {
    try {
      return reply.send(await getWorkshop(request.userId))
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // POST /api/jobs/:jobId/memory-items/:memoryItemId/workshop — move a
  // confirmed leftover into the Workshop. The source row stays exactly where it
  // is, with its purchase, cost, paid state and job status untouched.
  fastify.post<{
    Params: { jobId: string; memoryItemId: string }
    Body: { roughAmount?: string | null }
  }>('/api/jobs/:jobId/memory-items/:memoryItemId/workshop', async (request, reply) => {
    const { jobId, memoryItemId } = request.params
    try {
      const result = await moveLeftoverToWorkshop(jobId, memoryItemId, request.userId, request.body ?? {})
      return reply.code(201).send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // POST /api/workshop/items — add by hand. Material name only, plus optional
  // rough wording.
  fastify.post<{ Body: { materialName?: string; roughAmount?: string | null } }>(
    '/api/workshop/items',
    async (request, reply) => {
      try {
        return reply.code(201).send(await createManualWorkshopItem(request.userId, request.body ?? {}))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/workshop/items/:workshopItemId — change what's there.
  fastify.patch<{
    Params: { workshopItemId: string }
    Body: { materialName?: string; roughAmount?: string | null }
  }>('/api/workshop/items/:workshopItemId', async (request, reply) => {
    try {
      return reply.send(
        await patchWorkshopItem(request.userId, request.params.workshopItemId, request.body ?? {}),
      )
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  const action = (
    path: string,
    run: (userId: string, workshopItemId: string) => Promise<unknown>,
  ) => {
    fastify.post<{ Params: { workshopItemId: string } }>(
      `/api/workshop/items/:workshopItemId/${path}`,
      async (request, reply) => {
        try {
          return reply.send(await run(request.userId, request.params.workshopItemId))
        } catch (err: unknown) {
          return handleServiceError(err, reply)
        }
      },
    )
  }

  // The four lifecycle actions. `used-up` and `wasnt-there` are deliberately
  // separate outcomes with separate states — "I used it" and "it was never
  // there" are different memories, and collapsing them would lose the
  // correction.
  action('undo-move', undoMoveWorkshopItem)
  action('used-up', markWorkshopItemUsedUp)
  action('wasnt-there', markWorkshopItemWasntThere)
  action('put-back', putWorkshopItemBack)
}

export default workshopRoutes
