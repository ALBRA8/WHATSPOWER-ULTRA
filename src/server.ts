import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createBroadcastDatabase } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'
import { Http2ALockChecker, StandaloneLockChecker } from './safety/lock-checker.ts'
import { LocalSuppressionStore, Http2ASuppressionChecker, CompositeSuppressionChecker } from './safety/suppression.ts'
import { renderCampaignStudioHtml } from './studio/campaign-studio-html.ts'
import { renderSpintax } from './engine/spintax.ts'
import { parseAudienceCsv } from './audiences/csv-importer.ts'
import { WebhookLeadIngester } from './audiences/webhook-ingest.ts'
import { MetaCloudDispatcher } from './adapters/meta-cloud-dispatcher.ts'
import { NeuromarketingEngine } from './ai/neuromarketing-engine.ts'

export function createBroadcastServer(options?: {
  dbPath?: string
  dispatcher?: any
  lockChecker?: any
  suppressionStore?: any
  whatsPowerEnabled?: boolean
  useMetaCloudApi?: boolean
}) {
  const whatsPowerEnabled = options?.whatsPowerEnabled ?? (process.env.WHATSPOWER_ENABLED !== 'false')
  const db = createBroadcastDatabase(options?.dbPath)
  const leadIngester = new WebhookLeadIngester(db)
  const neuromarketingEngine = new NeuromarketingEngine()
  const dispatcher =
    options?.dispatcher ||
    (options?.useMetaCloudApi || process.env.TRANSPORT_ENGINE === 'meta_cloud'
      ? new MetaCloudDispatcher()
      : new HttpCrmDaemonDispatcher({ allowRealDispatch: false }))
  const lockChecker = options?.lockChecker || (whatsPowerEnabled ? new Http2ALockChecker({ enabled: true }) : new StandaloneLockChecker())
  const suppressionStore =
    options?.suppressionStore ||
    (whatsPowerEnabled
      ? new CompositeSuppressionChecker(new LocalSuppressionStore(db), new Http2ASuppressionChecker())
      : new LocalSuppressionStore(db))

  const engine = new BroadcastEngine({
    db,
    dispatcher,
    lockChecker,
    suppressionStore,
  })

  // Ejecutar recuperación ante caídas al arrancar
  const recovery = engine.recoverFromCrash()
  if (recovery.recoveredCount > 0) {
    console.log(`[Capa 2B] Recuperación ante caídas: ${recovery.recoveredCount} ítems transitorios restablecidos`)
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // 0. Campaign Studio UI
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/campaigns')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderCampaignStudioHtml())
      return
    }

    // 1. Healthcheck
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'whatspower-ultra' }))
      return
    }

    // 2. Previsualizador Spintax
    if (req.method === 'POST' && url.pathname === '/api/spintax/preview') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { template, name, variables } = JSON.parse(body)
          const rendered = renderSpintax(template || '', {
            seed: String(Math.random()),
            variables: { nombre: name || 'Juan', ...(variables || {}) },
          })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ rendered }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 3. Previsualizador y Validador CSV
    if (req.method === 'POST' && url.pathname === '/api/audiences/preview-csv') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { csvContent } = JSON.parse(body)
          const result = parseAudienceCsv(csvContent || '')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 4. Listar Campañas
    if (req.method === 'GET' && url.pathname === '/api/campaigns') {
      const rows = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rows))
      return
    }

    // 5. Crear Campaña
    if (req.method === 'POST' && url.pathname === '/api/campaigns') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)
          const campaign = await engine.createCampaign(data)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(campaign))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 6. Detalle de Campaña (GET /api/campaigns/:id)
    if (req.method === 'GET' && url.pathname.startsWith('/api/campaigns/')) {
      const campaignId = url.pathname.replace('/api/campaigns/', '')
      const campaign = engine.getCampaign(campaignId)
      if (!campaign) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }

      const items = engine.getItems(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ campaign, items }))
      return
    }

    // 7. Acciones de Control de Campaña
    if (req.method === 'POST' && url.pathname.includes('/step')) {
      const campaignId = url.pathname.split('/')[3]
      const stepRes = await engine.processNextItem(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stepRes))
      return
    }

    if (req.method === 'POST' && url.pathname.includes('/pause')) {
      const campaignId = url.pathname.split('/')[3]
      db.prepare("UPDATE campaigns SET status = 'PAUSED' WHERE id = ?").run(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'PAUSED' }))
      return
    }

    if (req.method === 'POST' && url.pathname.includes('/resume')) {
      const campaignId = url.pathname.split('/')[3]
      db.prepare("UPDATE campaigns SET status = 'RUNNING' WHERE id = ?").run(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'RUNNING' }))
      return
    }

    if (req.method === 'POST' && url.pathname.includes('/cancel')) {
      const campaignId = url.pathname.split('/')[3]
      db.prepare("UPDATE campaigns SET status = 'CANCELLED' WHERE id = ?").run(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'CANCELLED' }))
      return
    }

    // 8. Enlaces Rastreados y Atribución (/t/:code)
    if (req.method === 'GET' && url.pathname.startsWith('/t/')) {
      const code = url.pathname.replace('/t/', '')
      const contactPhone = url.searchParams.get('p') || null
      const userAgent = req.headers['user-agent'] || null
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1'

      const row = db.prepare('SELECT target_url, campaign_id FROM tracked_links WHERE code = ?').get(code) as any
      if (row && row.target_url) {
        db.prepare('UPDATE tracked_links SET clicks = clicks + 1 WHERE code = ?').run(code)
        
        // Registrar evento individual para heatmap y atribución
        try {
          db.prepare(`
            INSERT INTO tracked_link_clicks (id, code, contact_phone, user_agent, ip, clicked_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(`clk_${randomUUID()}`, code, contactPhone, userAgent, ip, Math.floor(Date.now() / 1000))
        } catch {}

        res.writeHead(302, { Location: row.target_url })
        res.end()
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Enlace no encontrado')
      return
    }

    // 9. Ingesta de Leads en Tiempo Real (Facebook/TikTok Ads, Typeform, Webhooks)
    if (req.method === 'POST' && url.pathname === '/api/audiences/webhook-lead') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const result = leadIngester.ingestLead(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 10. Reporte de Atribución y Clics de Campaña
    if (req.method === 'GET' && url.pathname.startsWith('/api/attribution/report/')) {
      const campaignId = url.pathname.replace('/api/attribution/report/', '')
      const campaign = engine.getCampaign(campaignId)
      if (!campaign) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }

      const linkRows = db.prepare('SELECT * FROM tracked_links WHERE campaign_id = ?').all(campaignId) as any[]
      const totalClicks = linkRows.reduce((sum, r) => sum + (r.clicks || 0), 0)
      const ctr = campaign.sentCount > 0 ? ((totalClicks / campaign.sentCount) * 100).toFixed(1) : '0.0'

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        campaignId,
        campaignName: campaign.name,
        sentCount: campaign.sentCount,
        totalClicks,
        ctrPercent: `${ctr}%`,
        links: linkRows,
      }))
      return
    }

    // 11. Neuromarketing AI: Análisis de Mercado y Perfil Subconsciente
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/analyze') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const result = neuromarketingEngine.analyzeTargetMarket(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 12. Neuromarketing AI: Generación Automática de Spintax Persuasivo
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/generate-spintax') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const result = neuromarketingEngine.generateNeuromarketingSpintax(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 13. Neuromarketing AI: Constructor de Master Prompt 360° para LLMs
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/master-prompt') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const prompt = neuromarketingEngine.buildMasterPrompt(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ masterPrompt: prompt }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }))
  })

  return { server, db, engine, leadIngester, dispatcher, neuromarketingEngine }
}

// Auto-arranque si se ejecuta directamente con Node
if (process.argv[1]?.includes('server.ts')) {
  const PORT = Number(process.env.PORT || 3004)
  const { server } = createBroadcastServer()
  server.listen(PORT, () => {
    console.log(`[Capa 2B] Servidor de Broadcast escuchando en http://localhost:${PORT}`)
  })
}
