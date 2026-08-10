// Job details + job-local contacts. Every route is owner-scoped by the service
// layer; nothing here logs or echoes a submitted contact value.
import type { FastifyPluginAsync } from 'fastify'
import {
  getJobDetails,
  patchJobDetails,
  createJobContact,
  patchJobContact,
  deleteJobContact,
} from '../services/job-contacts.js'
import type { ContactInput } from '../services/job-contacts.js'
import { handleServiceError } from './jobs.js'

const jobContactsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/jobs/:jobId/details — job + live contacts
  fastify.get<{ Params: { jobId: string } }>('/api/jobs/:jobId/details', async (request, reply) => {
    try {
      return reply.send(await getJobDetails(request.params.jobId, request.userId))
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // PATCH /api/jobs/:jobId/details — site address only; returns JobDetailsResponse
  fastify.patch<{ Params: { jobId: string }; Body: { siteAddress?: unknown } }>(
    '/api/jobs/:jobId/details',
    async (request, reply) => {
      try {
        const body = request.body ?? {}
        return reply.send(await patchJobDetails(request.params.jobId, request.userId, body))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // POST /api/jobs/:jobId/contacts — name-only is valid
  fastify.post<{ Params: { jobId: string }; Body: ContactInput }>(
    '/api/jobs/:jobId/contacts',
    async (request, reply) => {
      try {
        const contact = await createJobContact(request.params.jobId, request.userId, request.body ?? {})
        return reply.code(201).send(contact)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/contacts/:contactId — omitted preserves, null clears
  fastify.patch<{ Params: { jobId: string; contactId: string }; Body: ContactInput }>(
    '/api/jobs/:jobId/contacts/:contactId',
    async (request, reply) => {
      try {
        const { jobId, contactId } = request.params
        const contact = await patchJobContact(jobId, contactId, request.userId, request.body ?? {})
        return reply.send(contact)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // DELETE /api/jobs/:jobId/contacts/:contactId — soft delete, repeat is 404
  fastify.delete<{ Params: { jobId: string; contactId: string } }>(
    '/api/jobs/:jobId/contacts/:contactId',
    async (request, reply) => {
      try {
        const { jobId, contactId } = request.params
        await deleteJobContact(jobId, contactId, request.userId)
        return reply.code(204).send()
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default jobContactsRoutes
