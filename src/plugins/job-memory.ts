import type { FastifyInstance } from 'fastify'
import { isMoneyFeaturesEnabled } from '../config/features.js'
import { ignoreMoneyInput, withoutMoney } from '../lib/job-memory.js'

export function installJobMemoryBoundary(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (isMoneyFeaturesEnabled()) return
    const path = request.url.split('?')[0]
    const moneyRoute =
      /^\/api\/book\/money(?:\/|$)/.test(path) ||
      /^\/api\/jobs\/[^/]+\/(?:budget-categories(?:\/|$)|budget-summary$|money(?:\/|$)|payments(?:\/|$)|labour-people(?:\/|$))/.test(
        path,
      ) ||
      (['POST', 'PATCH', 'DELETE'].includes(request.method) &&
        /^\/api\/jobs\/[^/]+\/receipts(?:\/|$)/.test(path))
    if (moneyRoute)
      return reply
        .code(404)
        .send({ code: 'FEATURE_DISABLED', message: 'This feature is disabled' })
  })
  app.addHook('preValidation', async (request) => {
    const path = request.url.split('?')[0]
    if (
      isMoneyFeaturesEnabled() ||
      !/^\/api\/jobs\/[^/]+\/(?:memory-items|review-queue-decisions|details)(?:\/|$)/.test(
        path,
      )
    )
      return
    if (request.body && typeof request.body === 'object') {
      const body = ignoreMoneyInput(request.body) as Record<string, unknown>
      if (body.corrected && typeof body.corrected === 'object')
        body.corrected = ignoreMoneyInput(body.corrected)
      request.body = body
    }
  })
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (isMoneyFeaturesEnabled()) return payload
    const path = request.url.split('?')[0]
    if (
      /^\/api\/jobs(?:$|\/current$|\/[^/]+$|\/[^/]+\/(?:details|memory-view|review-queue|memory-items)(?:\/|$))/.test(
        path,
      ) ||
      /^\/api\/workshop(?:\/|$)/.test(path)
    ) {
      return withoutMoney(payload)
    }
    return payload
  })
}
