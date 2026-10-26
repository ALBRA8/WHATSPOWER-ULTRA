export function renderCampaignStudioHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsPower-Ultra — Campaign Studio & Anti-Ban Monitor</title>
  <style>
    :root {
      --bg: #090d16;
      --panel: #111827;
      --panel-border: #1f2937;
      --accent: #10b981;
      --accent-hover: #059669;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --warning: #f59e0b;
      --danger: #ef4444;
      --info: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

    /* Header */
    header { background: var(--panel); border-bottom: 1px solid var(--panel-border); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 20; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 32px; height: 32px; background: linear-gradient(135deg, #10b981, #06b6d4); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 16px; }
    .brand-title { font-size: 16px; font-weight: 700; color: #fff; }
    .brand-sub { font-size: 11px; color: var(--text-muted); background: #1e293b; padding: 2px 8px; border-radius: 12px; }
    .nav-tabs { display: flex; gap: 8px; }
    .tab-btn { background: transparent; border: 1px solid transparent; color: var(--text-muted); padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .tab-btn.active { background: #1f2937; color: #fff; border-color: var(--panel-border); }

    /* Main Container */
    main { flex: 1; display: flex; overflow: hidden; }

    /* Left Panel: Creator */
    .left-panel { flex: 1; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; max-width: 650px; border-right: 1px solid var(--panel-border); }
    /* Right Panel: Live Monitor */
    .right-panel { flex: 1.2; padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; background: #0b1120; }

    .card { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 12px; padding: 18px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); }
    .card-title { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
    input, textarea, select { width: 100%; background: #1f2937; border: 1px solid #374151; border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none; }
    input:focus, textarea:focus { border-color: var(--accent); }
    textarea { resize: vertical; min-height: 80px; font-family: inherit; }

    .btn { padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }
    .btn-accent { background: var(--accent); color: #fff; }
    .btn-accent:hover { background: var(--accent-hover); }
    .btn-secondary { background: #374151; color: #fff; }
    .btn-secondary:hover { background: #4b5563; }
    .btn-danger { background: #991b1b; color: #fca5a5; }
    .btn-warning { background: #92400e; color: #fde68a; }

    /* Spintax Preview Box */
    .preview-box { background: #0f172a; border: 1px dashed #334155; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.5; color: #cbd5e1; max-height: 140px; overflow-y: auto; }
    .preview-item { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #1e293b; }
    .preview-item:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }

    /* Metrics Grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .metric-card { background: #1e293b; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid #334155; }
    .metric-num { font-size: 20px; font-weight: 800; color: #fff; margin-top: 4px; }
    .metric-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }

    /* Progress bar */
    .progress-bar-bg { width: 100%; height: 10px; background: #1e293b; border-radius: 9999px; overflow: hidden; margin: 12px 0; }
    .progress-bar-fill { height: 100%; background: linear-gradient(90deg, #10b981, #06b6d4); width: 0%; transition: width 0.3s; }

    /* Live Logs Table */
    .log-table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .log-table th { text-align: left; padding: 8px; background: #1e293b; color: var(--text-muted); border-bottom: 1px solid #334155; }
    .log-table td { padding: 8px; border-bottom: 1px solid #1e293b; }
    .badge-status { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .badge-sent { background: #064e3b; color: #6ee7b7; }
    .badge-pending { background: #1e3a8a; color: #93c5fd; }
    .badge-skipped { background: #78350f; color: #fde68a; }
    .badge-failed { background: #7f1d1d; color: #fca5a5; }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">🚀</div>
      <div>
        <div class="brand-title">WhatsPower-Ultra Campaign Studio</div>
      </div>
      <span class="brand-sub">Nivel 3 · WhatsOn + WATI + SleekFlow</span>
    </div>

    <div class="nav-tabs">
      <button class="tab-btn active">🎯 Creador de Difusión</button>
      <button class="tab-btn" onclick="loadCampaignsList()">📊 Historial</button>
    </div>
  </header>

  <main>
    <!-- Left: Campaign Creator -->
    <div class="left-panel">
      <div class="card">
        <div class="card-title">
          <span>Configurar Campaña Masiva</span>
          <span style="font-size:11px; color:#10b981; font-weight:normal;">🛡️ Escudo Anti-Ban Activo</span>
        </div>

        <div class="form-group">
          <label>Nombre de la Campaña</label>
          <input id="cmpName" placeholder="Ej. Lanzamiento Black Friday - Segmento VIP" value="Campaña WhatsPower Ultra 01">
        </div>

        <!-- Neuromarketing AI Copilot -->
        <div style="background:#132338; border:1px solid #1e40af; border-radius:8px; padding:12px; margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong style="color:#60a5fa; font-size:12px;">🧠 Copiloto de Neuromarketing & Ventas IA (360°)</strong>
            <span style="font-size:10px; background:#1e3a8a; color:#93c5fd; padding:2px 6px; border-radius:4px;">Hofstede + Zaltman + Rapaille</span>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:6px;">
            <select id="neuroCountry" style="flex:1; font-size:11px; padding:6px;">
              <option value="COLOMBIA">🇨🇴 Colombia (Colectivismo + Confianza)</option>
              <option value="MEXICO">🇲🇽 México (Estatus + Respaldo)</option>
              <option value="ARGENTINA">🇦🇷 Argentina (ROI Concreto + Crítico)</option>
              <option value="CHILE">🇨🇱 Chile (Calidad + Estabilidad)</option>
              <option value="ESPANA">🇪🇸 España (Claridad + Profesionalismo)</option>
            </select>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:6px;">
            <input id="neuroBenefit" style="flex:1; font-size:11px; padding:6px;" placeholder="Beneficio Principal (Ej: cerrar 3x más ventas)" value="cerrar 3x más ventas sin contratar más personal">
            <input id="neuroPain" style="flex:1; font-size:11px; padding:6px;" placeholder="Dolor / Miedo (Ej: perder prospectos)" value="perder clientes por no responder de inmediato">
          </div>
          <button class="btn btn-primary" style="width:100%; font-size:11px; padding:6px;" onclick="generateNeuroSpintax()">
            ⚡ Redactar Spintax Persuasivo con Neuromarketing
          </button>
        </div>

        <div class="form-group">
          <label>Plantilla con Spintax {A|B|C} y Variables {{nombre}}</label>
          <textarea id="cmpTemplate" rows="4">{¡Hola|Buen día|Estimado/a} {{nombre}}! {Tenemos una novedad para ti|Queremos compartirte esta oportunidad exclusiva}: mira los detalles aquí: https://albra.co/oferta</textarea>
          <button class="btn btn-secondary" style="margin-top:6px; font-size:11px; padding:4px 8px;" onclick="testSpintax()">
            🎲 Previsualizar 5 Variaciones Spintax
          </button>
        </div>

        <!-- Spintax Live Variations -->
        <div class="form-group">
          <label>Variaciones Dinámicas Generadas (Preview):</label>
          <div class="preview-box" id="spintaxPreview">
            <div class="preview-item">1. ¡Hola Juan! Tenemos una novedad para ti: mira los detalles aquí: https://albra.co/oferta</div>
            <div class="preview-item">2. Buen día Juan! Queremos compartirte esta oportunidad exclusiva: mira los detalles aquí: https://albra.co/oferta</div>
          </div>
        </div>

        <div class="form-group">
          <label>Audiencia CSV (Pegar líneas: teléfono,nombre)</label>
          <textarea id="cmpCsv" rows="4" placeholder="phone,name&#10;573017543786,Johan Bravo&#10;573163301286,ALBRA Negocio&#10;573001234567,Carlos Perez">phone,name
573017543786,Johan Bravo
573163301286,ALBRA Negocio
573001234567,Carlos Perez</textarea>
          <button class="btn btn-secondary" style="margin-top:6px; font-size:11px; padding:4px 8px;" onclick="previewCsv()">
            📋 Validar Formato y Normalizar (+57)
          </button>
        </div>

        <div class="form-group" style="display:flex; gap:12px;">
          <div style="flex:1;">
            <label>Ritmo Anti-Ban</label>
            <select id="cmpSpeed">
              <option value="safe">🛡️ Modo Seguro (20s - 45s + Enfriamiento)</option>
              <option value="balanced">⚡ Modo Equilibrado (15s - 30s)</option>
            </select>
          </div>
          <div style="flex:1;">
            <label>Bloque de Enfriamiento</label>
            <select id="cmpCooldown">
              <option value="25">Pausa cada 25 envíos (8 min)</option>
              <option value="50">Pausa cada 50 envíos (12 min)</option>
            </select>
          </div>
        </div>

        <button class="btn btn-accent" style="width:100%; padding:12px; font-size:14px;" onclick="createAndStartCampaign()">
          🚀 Crear y Encolar Campaña
        </button>
      </div>
    </div>

    <!-- Right: Live Dispatch Monitor -->
    <div class="right-panel">
      <div class="card">
        <div class="card-title">
          <span>Monitor de Despacho en Caliente</span>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-warning" style="font-size:11px; padding:4px 8px;" onclick="pauseCampaign()">⏸️ Pausar</button>
            <button class="btn btn-accent" style="font-size:11px; padding:4px 8px;" onclick="resumeCampaign()">▶️ Reanudar</button>
            <button class="btn btn-danger" style="font-size:11px; padding:4px 8px;" onclick="cancelCampaign()">⏹️ Cancelar</button>
          </div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Destinatarios</div>
            <div class="metric-num" id="mTotal">0</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Enviados</div>
            <div class="metric-num" id="mSent" style="color:#10b981;">0</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Omitidos (Locks)</div>
            <div class="metric-num" id="mSkipped" style="color:#f59e0b;">0</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Errores</div>
            <div class="metric-num" id="mFailed" style="color:#ef4444;">0</div>
          </div>
        </div>

        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progressBar"></div>
        </div>

        <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted);">
          <span id="cmpStatus">Estado: EN ESPERA</span>
          <span id="cmpProgressText">0% completado</span>
        </div>
      </div>

      <!-- Live Delivery Log -->
      <div class="card" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
        <div class="card-title">
          <span>Registro en Tiempo Real de Envíos</span>
          <button class="btn btn-secondary" style="font-size:10px; padding:2px 6px;" onclick="refreshCurrentCampaign()">Refrescar</button>
        </div>

        <div style="flex:1; overflow-y:auto; border:1px solid #1e293b; border-radius:6px;">
          <table class="log-table">
            <thead>
              <tr>
                <th>Teléfono</th>
                <th>Nombre</th>
                <th>Mensaje Renderizado (Spintax)</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody id="logTbody">
              <tr>
                <td colspan="4" style="text-align:center; color:#64748b; padding:24px;">No hay despachos activos en este momento.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </main>

  <script>
    let activeCampaignId = null;
    let pollInterval = null;

    async function generateNeuroSpintax() {
      const productName = document.getElementById('cmpName').value || 'Nuestra Solución';
      const country = document.getElementById('neuroCountry').value;
      const benefit = document.getElementById('neuroBenefit').value;
      const pain = document.getElementById('neuroPain').value;

      try {
        const res = await fetch('/api/ai/neuromarketing/generate-spintax', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productName, country, mainBenefit: benefit, painPoint: pain })
        });
        const data = await res.json();
        if (data.spintaxTemplate) {
          document.getElementById('cmpTemplate').value = data.spintaxTemplate;
          testSpintax();
        }
      } catch(e) {
        alert('Error al generar Spintax: ' + e.message);
      }
    }

    async function testSpintax() {
      const template = document.getElementById('cmpTemplate').value;
      const box = document.getElementById('spintaxPreview');
      box.innerHTML = '';
      for (let i = 1; i <= 5; i++) {
        const seed = 'test_' + Math.random();
        try {
          const res = await fetch('/api/spintax/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template, name: 'Juan Pérez' })
          });
          const data = await res.json();
          const div = document.createElement('div');
          div.className = 'preview-item';
          div.textContent = i + '. ' + data.rendered;
          box.appendChild(div);
        } catch(e) {
          box.textContent = 'Error generando preview: ' + e.message;
        }
      }
    }

    async function previewCsv() {
      const csv = document.getElementById('cmpCsv').value;
      try {
        const res = await fetch('/api/audiences/preview-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvContent: csv })
        });
        const data = await res.json();
        alert('📋 Validación de Audiencia:\n- Válidos normalizados: ' + data.validCount + '\n- Inválidos descartados: ' + data.invalidCount + '\n- Duplicados eliminados: ' + data.duplicatesCount);
      } catch(e) {
        alert('Error en validación: ' + e.message);
      }
    }

    async function createAndStartCampaign() {
      const name = document.getElementById('cmpName').value;
      const template = document.getElementById('cmpTemplate').value;
      const csv = document.getElementById('cmpCsv').value;

      try {
        const res = await fetch('/api/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organizationId: 'org_albra_default',
            name,
            templateSpintax: template,
            csvContent: csv
          })
        });
        const campaign = await res.json();
        activeCampaignId = campaign.id;
        alert('✅ Campaña encolada con éxito (' + campaign.totalTargets + ' destinatarios). Iniciando monitor.');
        startMonitoring(campaign.id);
      } catch(e) {
        alert('Error creando campaña: ' + e.message);
      }
    }

    function startMonitoring(campaignId) {
      activeCampaignId = campaignId;
      if (pollInterval) clearInterval(pollInterval);
      refreshCurrentCampaign();
      pollInterval = setInterval(refreshCurrentCampaign, 2000);
    }

    async function refreshCurrentCampaign() {
      if (!activeCampaignId) return;
      try {
        const res = await fetch('/api/campaigns/' + activeCampaignId);
        if (!res.ok) return;
        const data = await res.json();
        const cmp = data.campaign;
        const items = data.items || [];

        document.getElementById('mTotal').textContent = cmp.totalTargets;
        document.getElementById('mSent').textContent = cmp.sentCount;
        document.getElementById('mSkipped').textContent = cmp.skippedCount;
        document.getElementById('mFailed').textContent = cmp.failedCount;

        const total = cmp.totalTargets || 1;
        const done = (cmp.sentCount + cmp.skippedCount + cmp.failedCount);
        const pct = Math.min(100, Math.round((done / total) * 100));

        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('cmpProgressText').textContent = pct + '% completado';
        document.getElementById('cmpStatus').textContent = 'Estado: ' + cmp.status;

        // Render table
        const tbody = document.getElementById('logTbody');
        tbody.innerHTML = '';
        items.slice(0, 30).forEach(it => {
          const tr = document.createElement('tr');
          const badgeClass = it.status === 'SENT' ? 'badge-sent' : it.status === 'PENDING' ? 'badge-pending' : it.status.includes('EXCLUDED') || it.status === 'SUPPRESSED' ? 'badge-skipped' : 'badge-failed';
          tr.innerHTML = \`
            <td style="font-weight:600;">+\${it.contactPhone}</td>
            <td>\${it.contactName || '-'}</td>
            <td style="color:#cbd5e1; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${it.renderedText || '-'}</td>
            <td><span class="badge-status \${badgeClass}">\${it.status}</span></td>
          \`;
          tbody.appendChild(tr);
        });
      } catch(e) {}
    }

    async function pauseCampaign() {
      if (!activeCampaignId) return;
      await fetch('/api/campaigns/' + activeCampaignId + '/pause', { method: 'POST' });
      refreshCurrentCampaign();
    }

    async function resumeCampaign() {
      if (!activeCampaignId) return;
      await fetch('/api/campaigns/' + activeCampaignId + '/resume', { method: 'POST' });
      refreshCurrentCampaign();
    }

    async function cancelCampaign() {
      if (!activeCampaignId) return;
      await fetch('/api/campaigns/' + activeCampaignId + '/cancel', { method: 'POST' });
      refreshCurrentCampaign();
    }

    testSpintax();
  </script>
</body>
</html>`;
}
