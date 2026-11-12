import { createServer, type Server } from 'node:http'

export interface Mock2AServerHandle {
  close: () => Promise<void>
}

/**
 * Servidor mock en proceso para la Capa 2A (:3003).
 * Si Capa 2A ya está corriendo en el host, la reutiliza.
 * Si no está corriendo (como en CI o pruebas unitarias aisladas), arranca un
 * servidor HTTP en :3003 que implementa fielmente el contrato de supresión
 * y autenticación de Capa 2A.
 */
export async function ensureAgentic2AServer(
  port = 3003,
  secret = process.env.AGENTIC_2A_INTERNAL_SECRET || process.env.INTERNAL_API_SECRET || 'ci-test-2a-secret-0000000000'
): Promise<Mock2AServerHandle> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) })
    if (res.ok) {
      return { close: async () => {} }
    }
  } catch {}

  const suppressedSet = new Set<string>()
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    const auth = req.headers['authorization']
    const isAuthed = auth === `Bearer ${secret}`

    if (url.pathname.startsWith('/api/internal/suppression/')) {
      const phone = decodeURIComponent(url.pathname.split('/').pop() || '')
      const orgId = (req.headers['x-org-id'] as string) || 'org_test'

      if (req.method === 'GET') {
        const isSupp = suppressedSet.has(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, suppressed: isSupp, organizationId: orgId }))
        return
      }

      if (req.method === 'POST') {
        if (!isAuthed) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        suppressedSet.add(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, suppressed: true, organizationId: orgId }))
        return
      }

      if (req.method === 'DELETE') {
        if (!isAuthed) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        suppressedSet.delete(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, deleted: true, organizationId: orgId }))
        return
      }
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'mock-agentic-2a' }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })

  return {
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
