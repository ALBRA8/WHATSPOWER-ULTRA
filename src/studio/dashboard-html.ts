/**
 * studio/dashboard-html.ts — UI del dashboard de paridad (Fase 3).
 *
 * Pantallas (parity/inventario-original.md §4): login, onboarding, resumen,
 * conversaciones/chat, contactos, embudo/kanban, campañas (lista + creador
 * EXISTENTE + monitor EXISTENTE), respuestas rápidas, etiquetas, agentes,
 * integraciones y ajustes.
 *
 * Reglas respetadas:
 *  - El creador de campañas y el monitor en vivo se REUTILIZAN tal cual
 *    (mismos IDs y funciones de campaign-studio-html.ts); solo se cambia el
 *    alert() por toasts y se implementa loadCampaignsList() (botón muerto).
 *  - Renderizado seguro: datos de contacto SIEMPRE vía textContent (patrón
 *    §4.A del repo — jamás innerHTML con datos externos).
 *  - Sesión: cookie HttpOnly del canje /studio/login; todo 401 → /login.
 */

export function renderDashboardLoginHtml(opts?: { demoEnabled?: boolean }): string {
  // El botón demo SOLO se ofrece cuando el backend lo permite (DEMO_MODE=true
  // fuera de producción): la UI no debe ofrecer una entrada que el servidor
  // rechazaría con 403. El llamador calcula la bandera server-side.
  const demoEnabled = opts?.demoEnabled === true
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsPower-Ultra · Acceso</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2310b981'/%3E%3Cpath d='M16 6 L25 11 V21 L16 26 L7 21 V11 Z' fill='none' stroke='%23fff' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E">
  <style>
    :root {
      --bg:#090d16; --panel:#111827; --panel-border:#1f2937; --accent:#10b981; --accent-hover:#059669;
      --text:#f3f4f6; --text-muted:#9ca3af; --danger:#ef4444; --warning:#f59e0b;
      --input-bg:#1f2937; --input-border:#374151;
      --msg-err-bg:#7f1d1d; --msg-err-fg:#fca5a5; --msg-warn-bg:#78350f; --msg-warn-fg:#fde68a;
    }
    html[data-theme="light"] {
      --bg:#f5f7fa; --panel:#ffffff; --panel-border:#e2e8f0; --accent:#10b981; --accent-hover:#059669;
      --text:#0f172a; --text-muted:#64748b; --danger:#dc2626; --warning:#d97706;
      --input-bg:#f1f5f9; --input-border:#cbd5e1;
      --msg-err-bg:#fee2e2; --msg-err-fg:#991b1b; --msg-warn-bg:#fef3c7; --msg-warn-fg:#92400e;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; position:relative; }
    .card { background:var(--panel); border:1px solid var(--panel-border); border-radius:12px; padding:28px; width:100%; max-width:380px; position:relative; }
    .logo { width:44px; height:44px; background:linear-gradient(135deg,#10b981,#06b6d4); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:22px; margin-bottom:14px; }
    h1 { font-size:18px; margin-bottom:4px; }
    .sub { font-size:12px; color:var(--text-muted); margin-bottom:20px; }
    label { display:block; font-size:12px; font-weight:600; color:var(--text-muted); margin-bottom:6px; }
    input { width:100%; background:var(--input-bg); border:1px solid var(--input-border); border-radius:6px; padding:10px 12px; color:var(--text); font-size:14px; outline:none; }
    input:focus { border-color:var(--accent); }
    .btn { width:100%; padding:11px; border:none; border-radius:6px; background:var(--accent); color:#fff; font-size:14px; font-weight:600; cursor:pointer; margin-top:14px; }
    .btn:hover { background:var(--accent-hover); }
    .btn:disabled { opacity:0.6; cursor:not-allowed; }
    .btn-demo { width:100%; padding:10px; border:1px dashed var(--accent); border-radius:6px; background:transparent; color:var(--accent); font-size:13px; font-weight:600; cursor:pointer; margin-top:10px; transition:all .15s; }
    .btn-demo:hover { background:var(--accent); color:#fff; }
    .btn-demo:disabled { opacity:0.5; cursor:not-allowed; }
    .demo-hint { font-size:11px; color:var(--text-muted); margin-top:10px; padding:8px 10px; background:var(--input-bg); border-radius:6px; line-height:1.5; display:none; }
    .demo-hint.visible { display:block; }
    .msg { font-size:12px; margin-top:12px; padding:8px 10px; border-radius:6px; display:none; word-break:break-word; }
    .msg.error { display:block; background:var(--msg-err-bg); color:var(--msg-err-fg); }
    .msg.warn { display:block; background:var(--msg-warn-bg); color:var(--msg-warn-fg); }
    .hint { font-size:11px; color:var(--text-muted); margin-top:16px; line-height:1.5; }
    .theme-toggle {
      position:absolute; top:16px; right:16px;
      background:var(--input-bg); border:1px solid var(--panel-border); color:var(--text);
      border-radius:8px; width:32px; height:32px; display:flex; align-items:center; justify-content:center;
      cursor:pointer; font-size:15px; transition:all .15s;
    }
    .theme-toggle:hover { border-color:var(--accent); color:var(--accent); }
  </style>
</head>
<body>
  <div class="card">
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Cambiar tema claro/oscuro" aria-label="Cambiar tema">🌙</button>
    <div class="logo">🚀</div>
    <h1>WhatsPower-Ultra Campaign Studio</h1>
    <div class="sub">Nivel 3 · Consola de difusión, chat y anti-ban</div>
    <form id="loginForm">
      <label for="secret">Secreto administrativo</label>
      <input type="password" id="secret" name="secret" autocomplete="current-password" placeholder="Clave ADMIN_API_KEYS de tu organización" required>
      <button class="btn" id="loginBtn" type="submit">Entrar</button>
    </form>
    ${demoEnabled ? '<button class="btn-demo" id="demoBtn" type="button" onclick="loginDemo()">🚀 Entrar sin registro (demo)</button>' : ''}
    <div class="msg" id="msg"></div>
    <div class="hint">El secreto se canjea <b>una vez</b> por una sesión HttpOnly de 1 hora; jamás se guarda en el navegador. Tras 10 intentos fallidos por minuto el acceso se bloquea temporalmente.</div>
    ${demoEnabled ? '<div class="demo-hint" id="demoHint">El modo demo usa una sesión temporal con la primera organización configurada. Desactívalo en producción (<code>DEMO_MODE=false</code>).</div>' : ''}
  </div>
  <script>
    function toggleTheme() {
      var html = document.documentElement;
      var actual = html.getAttribute('data-theme') || 'dark';
      var nuevo = actual === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', nuevo);
      try { localStorage.setItem('wp-theme', nuevo); } catch (e) {}
      var btn = document.getElementById('themeToggle');
      if (btn) btn.textContent = nuevo === 'dark' ? '🌙' : '☀️';
    }
    (function () {
      try {
        var guardado = localStorage.getItem('wp-theme');
        if (guardado === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
          var btn = document.getElementById('themeToggle');
          if (btn) btn.textContent = '☀️';
        }
      } catch (e) {}
    })();
    // === Login demo (sin registro) — solo con demoEnabled (botón presente) ===
    ${demoEnabled ? `
    function loginDemo() {
      var btn = document.getElementById('demoBtn');
      var msg = document.getElementById('msg');
      var hint = document.getElementById('demoHint');
      btn.disabled = true;
      msg.className = 'msg';
      fetch('/studio/login-demo', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function (r) {
          if (r.ok) { location.href = '/'; return; }
          return r.json().then(function (d) {
            btn.disabled = false;
            msg.className = 'msg error';
            msg.textContent = (d && d.error) ? d.error : 'Modo demo no disponible';
            if (hint) hint.classList.add('visible');
          });
        }).catch(function () {
          btn.disabled = false;
          msg.className = 'msg error';
          msg.textContent = 'Error de red. Inténtalo de nuevo.';
        });
    }
    // Mostrar la pista demo al cargar (informativo)
    (function () { var h = document.getElementById('demoHint'); if (h) h.classList.add('visible'); })();
    ` : ''}
    var params = new URLSearchParams(location.search);
    if (params.get('expired') === '1') {
      var m = document.getElementById('msg');
      m.className = 'msg warn';
      m.textContent = 'Tu sesión caducó. Vuelve a entrar para continuar.';
    }
    document.getElementById('loginForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = document.getElementById('loginBtn');
      var msg = document.getElementById('msg');
      btn.disabled = true;
      msg.className = 'msg';
      fetch('/studio/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: document.getElementById('secret').value })
      }).then(function (r) {
        if (r.ok) { location.href = '/'; return; }
        return r.json().then(function (d) {
          btn.disabled = false;
          msg.className = 'msg error';
          msg.textContent = (d && d.error) ? d.error : 'Credencial administrativa inválida';
        });
      }).catch(function () {
        btn.disabled = false;
        msg.className = 'msg error';
        msg.textContent = 'Error de red. Inténtalo de nuevo.';
      });
    });
  </script>
</body>
</html>`
}

export function renderDashboardAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsPower-Ultra — Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2310b981'/%3E%3Cpath d='M16 6 L25 11 V21 L16 26 L7 21 V11 Z' fill='none' stroke='%23fff' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E">
  <style>
    :root {
      --bg:#090d16; --panel:#111827; --panel-border:#1f2937; --accent:#10b981; --accent-hover:#059669;
      --text:#f3f4f6; --text-muted:#9ca3af; --warning:#f59e0b; --danger:#ef4444; --info:#3b82f6;
      --input-bg:#1f2937; --input-border:#374151; --hover-bg:#1a2436;
      --table-head:#1e293b; --table-row-border:#1e293b; --table-row-alt:#334155;
      --metric-bg:#1e293b; --metric-border:#334155;
      --skeleton-from:#1e293b; --skeleton-to:#334155;
      --shadow:0 6px 16px rgba(0,0,0,0.4);
    }
    /* Modo claro: se activa con data-theme="light" en <html> */
    html[data-theme="light"] {
      --bg:#f5f7fa; --panel:#ffffff; --panel-border:#e2e8f0; --accent:#10b981; --accent-hover:#059669;
      --text:#0f172a; --text-muted:#64748b; --warning:#d97706; --danger:#dc2626; --info:#2563eb;
      --input-bg:#f1f5f9; --input-border:#cbd5e1; --hover-bg:#f1f5f9;
      --table-head:#f1f5f9; --table-row-border:#e2e8f0; --table-row-alt:#cbd5e1;
      --metric-bg:#f8fafc; --metric-border:#e2e8f0;
      --skeleton-from:#e2e8f0; --skeleton-to:#cbd5e1;
      --shadow:0 6px 16px rgba(15,23,42,0.1);
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; overflow:hidden; }

    /* ===== Sidebar ===== */
    .sidebar { width:232px; background:var(--panel); border-right:1px solid var(--panel-border); display:flex; flex-direction:column; flex-shrink:0; z-index:40; }
    .brand { display:flex; align-items:center; gap:10px; padding:16px 16px 12px; border-bottom:1px solid var(--panel-border); }
    .brand-logo { width:34px; height:34px; background:linear-gradient(135deg,#10b981,#06b6d4); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:17px; flex-shrink:0; }
    .brand-title { font-size:14px; font-weight:700; color:#fff; line-height:1.2; }
    .brand-sub { font-size:10px; color:var(--text-muted); }
    .nav { flex:1; overflow-y:auto; padding:10px 8px; display:flex; flex-direction:column; gap:2px; }
    .nav-item { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:8px; font-size:13px; font-weight:600; color:var(--text-muted); cursor:pointer; border:1px solid transparent; background:transparent; text-align:left; width:100%; }
    .nav-item:hover { background:var(--hover-bg); color:var(--text); }
    .nav-item.active { background:var(--panel-border); color:var(--text); border-color:var(--panel-border); }
    .nav-badge { margin-left:auto; background:#7f1d1d; color:#fca5a5; font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px; display:none; }
    .sidebar-footer { padding:12px; border-top:1px solid var(--panel-border); font-size:11px; color:var(--text-muted); }
    .transport-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--warning); margin-right:6px; }
    .transport-dot.ok { background:var(--accent); }
    .transport-dot.bad { background:var(--danger); }

    /* ===== Main ===== */
    .main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
    .topbar { background:var(--panel); border-bottom:1px solid var(--panel-border); padding:12px 20px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .topbar h2 { font-size:16px; color:#fff; }
    /* Botón toggle de tema claro/oscuro */
    .theme-toggle { background:var(--input-bg); border:1px solid var(--panel-border); color:var(--text); border-radius:8px; width:34px; height:34px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px; transition:all .15s; flex-shrink:0; }
    .theme-toggle:hover { border-color:var(--accent); color:var(--accent); }
    .topbar-actions { display:flex; align-items:center; gap:8px; }
    .hamburger { display:none; background:var(--input-bg); border:1px solid var(--panel-border); color:var(--text); border-radius:6px; padding:6px 10px; cursor:pointer; font-size:15px; }
    .view-root { flex:1; overflow-y:auto; padding:20px; }
    .backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:35; }

    /* ===== Componentes (mismas variables del studio existente) ===== */
    .card { background:var(--panel); border:1px solid var(--panel-border); border-radius:12px; padding:18px; }
    .card-title { font-size:14px; font-weight:700; color:#fff; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .form-group { margin-bottom:14px; }
    label { display:block; font-size:12px; font-weight:600; color:var(--text-muted); margin-bottom:6px; }
    input, textarea, select { width:100%; background:var(--input-bg); border:1px solid var(--input-border); border-radius:6px; padding:8px 12px; color:#fff; font-size:13px; outline:none; }
    input:focus, textarea:focus, select:focus { border-color:var(--accent); }
    textarea { resize:vertical; font-family:inherit; }
    .btn { padding:8px 14px; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; border:none; display:inline-flex; align-items:center; justify-content:center; gap:6px; transition:all .2s; }
    .btn-accent { background:var(--accent); color:#fff; } .btn-accent:hover { background:var(--accent-hover); }
    .btn-secondary { background:var(--input-border); color:var(--text); } .btn-secondary:hover { background:var(--table-row-alt); }
    .btn-danger { background:#991b1b; color:#fca5a5; }
    .btn-warning { background:#92400e; color:#fde68a; }
    .btn-ghost { background:transparent; border:1px solid var(--panel-border); color:var(--text-muted); }
    .btn-sm { font-size:11px; padding:4px 8px; }
    .metrics-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
    .metric-card { background:var(--metric-bg); border-radius:8px; padding:14px; border:1px solid var(--metric-border); }
    .metric-num { font-size:22px; font-weight:800; color:#fff; margin-top:4px; }
    .metric-label { font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600; }
    .table-wrap { overflow-x:auto; border:1px solid var(--table-row-border); border-radius:8px; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th { text-align:left; padding:8px 10px; background:var(--table-head); color:var(--text-muted); border-bottom:1px solid var(--table-row-alt); white-space:nowrap; }
    td { padding:8px 10px; border-bottom:1px solid var(--table-row-border); vertical-align:middle; }
    tr:last-child td { border-bottom:none; }
    .badge-status { padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700; text-transform:uppercase; white-space:nowrap; }
    .badge-sent { background:#064e3b; color:#6ee7b7; }
    .badge-pending { background:#1e3a8a; color:#93c5fd; }
    .badge-skipped { background:#78350f; color:#fde68a; }
    .badge-failed { background:#7f1d1d; color:#fca5a5; }
    .badge-neutral { background:var(--panel-border); color:var(--text-muted); }
    .tag-chip { display:inline-block; font-size:10px; padding:2px 8px; border-radius:10px; margin:1px 2px; background:#1e3a8a; color:#93c5fd; }
    .state-box { padding:32px 16px; text-align:center; color:#64748b; font-size:13px; }
    .state-box .btn { margin-top:12px; }
    .skeleton { height:14px; border-radius:4px; background:linear-gradient(90deg,var(--skeleton-from) 25%,var(--skeleton-to) 50%,var(--skeleton-from) 75%); background-size:200% 100%; animation:sk 1.2s infinite; margin:8px 0; }
    @keyframes sk { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

    /* Toasts */
    .toasts { position:fixed; bottom:18px; right:18px; display:flex; flex-direction:column; gap:8px; z-index:200; max-width:340px; }
    .toast { padding:10px 14px; border-radius:8px; font-size:12px; font-weight:600; box-shadow:0 6px 16px rgba(0,0,0,0.4); animation:tin .2s; }
    .toast.ok { background:#064e3b; color:#6ee7b7; border:1px solid #10b981; }
    .toast.err { background:#7f1d1d; color:#fca5a5; border:1px solid #ef4444; }
    .toast.info { background:#1e3a8a; color:#93c5fd; border:1px solid #3b82f6; }
    @keyframes tin { from { transform:translateY(8px); opacity:0; } to { transform:none; opacity:1; } }

    /* Modal */
    .modal-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:100; align-items:center; justify-content:center; padding:16px; }
    .modal-backdrop.open { display:flex; }
    .modal { background:var(--panel); border:1px solid var(--panel-border); border-radius:12px; width:100%; max-width:460px; max-height:90vh; overflow-y:auto; padding:20px; }
    .modal h3 { font-size:15px; color:#fff; margin-bottom:14px; }
    .modal-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap; }

    /* Chat */
    .chat-layout { display:grid; grid-template-columns:300px 1fr; gap:14px; height:calc(100vh - 140px); min-height:420px; }
    .conv-list { background:var(--panel); border:1px solid var(--panel-border); border-radius:12px; overflow-y:auto; }
    .conv-item { padding:12px 14px; border-bottom:1px solid var(--table-row-border); cursor:pointer; }
    .conv-item:hover { background:var(--hover-bg); }
    .conv-item.active { background:#1f2937; border-left:3px solid var(--accent); }
    .conv-name { font-size:13px; font-weight:700; color:#fff; display:flex; justify-content:space-between; gap:6px; }
    .conv-last { font-size:11px; color:var(--text-muted); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .conv-unread { background:var(--accent); color:#04211a; font-size:10px; font-weight:800; border-radius:10px; padding:1px 7px; }
  .conv-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
  .conv-filtro { display:flex; gap:6px; align-items:center; }
  .conv-filtro .btn[aria-pressed="true"] { box-shadow: inset 0 0 0 2px rgba(0,0,0,.25); }
  .conv-mark { margin-left:6px; border:0; border-radius:10px; cursor:pointer; font-size:11px; font-weight:800;
    line-height:1; padding:3px 5px; background:var(--accent); color:#04211a; }
  .conv-mark:hover { filter:brightness(1.1); }
    .chat-thread { background:var(--panel); border:1px solid var(--panel-border); border-radius:12px; display:flex; flex-direction:column; overflow:hidden; }
    .thread-head { padding:12px 16px; border-bottom:1px solid var(--panel-border); display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .thread-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; background:#0b1120; }
    .bubble { max-width:72%; padding:9px 12px; border-radius:10px; font-size:13px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
    .bubble.out { align-self:flex-end; background:#064e3b; color:#d1fae5; }
    .bubble.in { align-self:flex-start; background:#1f2937; color:#e5e7eb; }
    .bubble .meta { display:block; font-size:9px; color:rgba(255,255,255,0.55); margin-top:4px; text-align:right; }
    .composer { padding:12px; border-top:1px solid var(--panel-border); display:flex; gap:8px; position:relative; }
    .composer textarea { flex:1; min-height:44px; max-height:120px; }
    .qr-menu { position:absolute; bottom:64px; left:12px; right:12px; background:var(--panel); border:1px solid var(--panel-border); border-radius:8px; max-height:220px; overflow-y:auto; display:none; z-index:10; }
    .qr-item { padding:9px 12px; cursor:pointer; font-size:12px; border-bottom:1px solid #1e293b; }
    .qr-item:hover { background:var(--hover-bg); }

    /* Kanban */
    .kanban { display:flex; gap:12px; overflow-x:auto; align-items:flex-start; padding-bottom:8px; min-height:420px; }
    .kcol { min-width:240px; width:240px; flex-shrink:0; background:#0b1120; border:1px solid var(--panel-border); border-radius:10px; }
    .kcol-head { padding:10px 12px; font-size:12px; font-weight:700; color:#fff; border-bottom:1px solid var(--panel-border); display:flex; justify-content:space-between; align-items:center; }
    .kcol-body { padding:8px; min-height:120px; display:flex; flex-direction:column; gap:6px; }
    .kcol.dragover { outline:2px dashed var(--accent); }
    .kcard { background:var(--panel); border:1px solid #334155; border-radius:8px; padding:10px; cursor:grab; font-size:12px; }
    .kcard:active { cursor:grabbing; }
    .kcard .phone { font-weight:700; color:#fff; }
    .kcard .tagsline { margin-top:6px; }

    /* Creador de campaña (reutilizado del studio existente) */
    .preview-box { background:#0f172a; border:1px dashed #334155; border-radius:8px; padding:12px; font-size:12px; line-height:1.5; color:#cbd5e1; max-height:140px; overflow-y:auto; }
    .preview-item { margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #1e293b; }
    .preview-item:last-child { margin-bottom:0; padding-bottom:0; border-bottom:none; }
    .progress-bar-bg { width:100%; height:10px; background:#1e293b; border-radius:9999px; overflow:hidden; margin:12px 0; }
    .progress-bar-fill { height:100%; background:linear-gradient(90deg,#10b981,#06b6d4); width:0%; transition:width .3s; }
    .log-table { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
    .two-col { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:16px; align-items:start; }

    /* Onboarding */
    .onb-steps { display:flex; gap:6px; margin-bottom:16px; }
    .onb-step { flex:1; height:4px; border-radius:2px; background:#1f2937; }
    .onb-step.done { background:var(--accent); }

    /* F11: accesibilidad (foco visible, enlace de salto) y movil 390px */
    :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .skip-link { position:absolute; left:-9999px; top:0; z-index:200; background:var(--accent); color:#04211a; font-weight:700; padding:10px 14px; border-radius:0 0 8px 0; }
    .skip-link:focus { left:0; }
    .thread-more { display:flex; justify-content:center; padding:8px; border-bottom:1px solid var(--panel-border); }
    .bubble.failed { border:1px solid #f87171; }
    .thread-msgs .state-box { align-self:center; }
    @media (max-width: 700px) {
      .btn, .btn-sm, .nav-item, .theme-toggle, .hamburger, .conv-item { min-height:44px; }
      .table-wrap { max-width:100%; -webkit-overflow-scrolling:touch; }
    }

    @media (max-width: 900px) {
      .two-col { grid-template-columns:1fr; }
      .chat-layout { grid-template-columns:1fr; height:auto; }
      .conv-list { max-height:260px; }
      .chat-thread { min-height:420px; }
    }
    @media (max-width: 700px) {
      .sidebar { position:fixed; left:0; top:0; bottom:0; transform:translateX(-100%); transition:transform .2s; }
      .sidebar.open { transform:none; }
      .hamburger { display:block; }
      .backdrop.show { display:block; }
      .view-root { padding:12px; }
      .kanban { flex-direction:column; }
      .kcol { width:100%; min-width:0; }
    }
    /* B8: Pantallas muy estrechas (<380px): una sola columna, tablas con scroll interno */
    @media (max-width: 380px) {
      .topbar { padding:8px 10px; }
      .topbar h2 { font-size:14px; }
      .view-root { padding:8px; }
      .card { padding:12px; }
      .metric-card { padding:10px; }
      .metric-num { font-size:18px; }
      .two-col { grid-template-columns:1fr; gap:8px; }
      .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      table { font-size:11px; }
      th, td { padding:6px 8px; }
      .btn { padding:6px 10px; font-size:12px; }
      .theme-toggle { width:28px; height:28px; font-size:13px; }
      .brand-title { font-size:12px; }
      .brand-sub { font-size:9px; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#viewRoot">Saltar al contenido</a>
  <div class="backdrop" id="backdrop" onclick="closeSidebar()"></div>
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-logo">🚀</div>
      <div>
        <div class="brand-title">WhatsPower-Ultra</div>
        <div class="brand-sub">Nivel 3 · Campaign + Chat</div>
      </div>
    </div>
    <nav class="nav" id="navRoot"></nav>
    <div class="sidebar-footer">
      <span class="transport-dot" id="transportDot"></span><span id="transportLabel">Transporte: comprobando…</span>
    </div>
  </aside>

  <div class="main">
    <div class="topbar">
      <div style="display:flex; align-items:center; gap:10px;">
        <button class="hamburger" onclick="toggleSidebar()">☰</button>
        <h2 id="viewTitle">Resumen</h2>
      </div>
      <div class="topbar-actions">
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Cambiar tema claro/oscuro" aria-label="Cambiar tema">🌙</button>
        <button class="btn btn-ghost btn-sm" onclick="doLogout()">Cerrar sesión</button>
      </div>
    </div>
    <div class="view-root" id="viewRoot" role="main" tabindex="-1">
      <div class="skeleton" style="width:40%"></div>
      <div class="skeleton" style="width:70%"></div>
      <div class="skeleton" style="width:55%"></div>
    </div>
  </div>

  <div class="toasts" id="toasts"></div>
  <div class="modal-backdrop" id="modalBackdrop"><div class="modal" id="modalBody"></div></div>

  <script>
  // ============================================================
  // Núcleo: api() con sesión, toasts, modales y router por hash
  // ============================================================
  function toast(text, type) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    // B1: word-break + recortar a ~200 caracteres con elipsis
    var txt = String(text || '');
    if (txt.length > 200) txt = txt.slice(0, 200) + '…';
    el.textContent = txt;
    el.style.wordBreak = 'break-word';
    el.style.overflowWrap = 'anywhere';
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }
  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    return fetch(path, options).then(function (r) {
      if (r.status === 401) { location.href = '/login?expired=1'; throw new Error('SESSION_EXPIRED'); }
      return r.json().then(function (d) {
        if (!r.ok) {
          var err = new Error('HTTP_' + r.status);
          err.status = r.status;
          err.data = d;
          throw err;
        }
        return { status: r.status, data: d };
      });
    });
  }
  function openModal(html) {
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalBackdrop').classList.add('open');
  }
  function closeModal() { document.getElementById('modalBackdrop').classList.remove('open'); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtTime(sec) { if (!sec) return '-'; return new Date(sec * 1000).toLocaleString('es'); }
  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('show');
  }
  function closeSidebar() {
    // B9: la transición dura 200ms; si se captura antes, se fotografía a medias.
    // Retrasamos la limpieza de clases 350ms para que el sidebar termine de cerrarse.
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
  }
  function doLogout() {
    fetch('/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
  }

  // === Toggle de tema claro/oscuro (un solo clic) ===
  function toggleTheme() {
    var html = document.documentElement;
    var actual = html.getAttribute('data-theme') || 'dark';
    var nuevo = actual === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', nuevo);
    try { localStorage.setItem('wp-theme', nuevo); } catch (e) {}
    actualizarIconoTheme(nuevo);
  }
  function actualizarIconoTheme(tema) {
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = tema === 'dark' ? '🌙' : '☀️';
  }
  // Restaurar tema guardado al cargar
  (function () {
    try {
      var guardado = localStorage.getItem('wp-theme');
      if (guardado === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    } catch (e) {}
    // El icono se actualiza tras el render del topbar
    setTimeout(function () {
      var tema = document.documentElement.getAttribute('data-theme') || 'dark';
      actualizarIconoTheme(tema);
    }, 50);
  })();

  var viewTimers = [];
  function clearViewTimers() { viewTimers.forEach(function (t) { clearInterval(t); }); viewTimers = []; }

  var NAV = [
    { id: 'summary', icon: '📊', label: 'Resumen' },
    { id: 'conversations', icon: '💬', label: 'Conversaciones' },
    { id: 'contacts', icon: '👥', label: 'Contactos' },
    { id: 'pipeline', icon: '🪜', label: 'Embudo' },
    { id: 'campaigns', icon: '📢', label: 'Campañas' },
    { id: 'quick-replies', icon: '⚡', label: 'Respuestas rápidas' },
    { id: 'tags', icon: '🏷️', label: 'Etiquetas' },
    { id: 'agents', icon: '🧑‍💼', label: 'Agentes' },
    { id: 'integrations', icon: '🔌', label: 'Integraciones' },
    { id: 'settings', icon: '⚙️', label: 'Ajustes' }
  ];

  function currentView() {
    var h = location.hash.replace(/^#\\/?/, '');
    if (!h) return 'summary';
    return NAV.some(function (n) { return n.id === h; }) ? h : 'summary';
  }

  function renderNav() {
    var root = document.getElementById('navRoot');
    root.textContent = '';
    var active = currentView();
    NAV.forEach(function (n) {
      var b = document.createElement('button');
      b.className = 'nav-item' + (n.id === active ? ' active' : '');
      b.setAttribute('data-view', n.id);
      var icon = document.createElement('span'); icon.textContent = n.icon;
      var label = document.createElement('span'); label.textContent = n.label;
      var badge = document.createElement('span'); badge.className = 'nav-badge'; badge.id = 'badge-unread';
      b.appendChild(icon); b.appendChild(label);
      if (n.id === 'conversations') b.appendChild(badge);
      b.addEventListener('click', function () { location.hash = '#/' + n.id; closeSidebar(); });
      root.appendChild(b);
    });
  }

  function setTitle(t) { document.getElementById('viewTitle').textContent = t; }

  function renderTransportStatus() {
    api('/api/integrations/transport').then(function (r) {
      var dot = document.getElementById('transportDot');
      var label = document.getElementById('transportLabel');
      var cfg = r.data;
      if (cfg.engine === 'meta_cloud') {
        dot.className = 'transport-dot ' + (cfg.metaPhoneNumberId ? 'ok' : 'bad');
        label.textContent = 'Transporte: Meta Cloud (' + (cfg.metaPhoneNumberId ? 'configurado' : 'sin phone_id') + ')';
      } else {
        dot.className = 'transport-dot ' + (cfg.daemonUrl ? 'ok' : 'bad');
        label.textContent = 'Transporte: Daemon CRM (' + (cfg.daemonUrl ? cfg.daemonUrl.replace(/^https?:\\/\\//, '') : 'sin URL') + ')';
      }
    }).catch(function () {
      document.getElementById('transportLabel').textContent = 'Transporte: sesión requerida';
    });
  }

  function refreshUnreadBadge() {
    api('/api/conversations?unreadOnly=1&limit=1').then(function (r) {
      var badge = document.getElementById('badge-unread');
      if (!badge) return;
      var total = (r.data.total || 0);
      badge.style.display = total > 0 ? 'inline-block' : 'none';
      badge.textContent = String(total);
      var enBoton = document.getElementById('convUnreadCount');
      if (enBoton) enBoton.textContent = total > 0 ? total : '';
    }).catch(function () {});
  }

  // ============================================================
  // VISTA: Resumen
  // ============================================================
  function viewSummary() {
    setTitle('Resumen');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    root.innerHTML = '<div class="skeleton" style="width:50%"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:65%"></div>';
    api('/api/dashboard/summary').then(function (r) {
      var s = r.data;
      root.textContent = '';
      var grid = document.createElement('div');
      grid.className = 'metrics-grid';
      var items = [
        ['Campañas activas', s.campaignsActive, '#fff'],
        ['Enviados totales', s.sentTotal, '#10b981'],
        ['Tasa de clics', s.ctrPercent + '%', '#3b82f6'],
        ['Clics rastreados', s.clicks, '#3b82f6'],
        ['Contactos', s.contactsTotal, '#fff'],
        ['Suprimidos', s.suppressedTotal, '#f59e0b'],
        ['Conversaciones', s.conversationsTotal, '#fff'],
        ['No leídos', s.unreadTotal, '#ef4444']
      ];
      items.forEach(function (it) {
        var c = document.createElement('div'); c.className = 'metric-card';
        var l = document.createElement('div'); l.className = 'metric-label'; l.textContent = it[0];
        var n = document.createElement('div'); n.className = 'metric-num'; n.style.color = it[2]; n.textContent = String(it[1]);
        c.appendChild(l); c.appendChild(n); grid.appendChild(c);
      });
      root.appendChild(grid);
      if (s.campaignsTotal === 0 && s.contactsTotal === 0) {
        var empty = document.createElement('div');
        empty.className = 'card';
        empty.style.marginTop = '16px';
        empty.innerHTML = '<div class="state-box">Aún no hay datos. Empieza importando contactos o creando tu primera campaña.<br></div>';
        var wrap = empty.querySelector('.state-box');
        var b1 = document.createElement('button'); b1.className = 'btn btn-accent'; b1.textContent = '👥 Importar contactos';
        b1.addEventListener('click', function () { location.hash = '#/contacts'; });
        var b2 = document.createElement('button'); b2.className = 'btn btn-secondary'; b2.style.marginLeft = '8px'; b2.textContent = '📢 Nueva campaña';
        b2.addEventListener('click', function () { location.hash = '#/campaigns'; });
        wrap.appendChild(b1); wrap.appendChild(document.createElement('br')); wrap.appendChild(b2);
        root.appendChild(empty);
      }
    }).catch(function (e) {
      if (String(e.message) === 'SESSION_EXPIRED') return;
      root.textContent = '';
      var err = document.createElement('div'); err.className = 'card';
      err.innerHTML = '<div class="state-box">Error cargando el resumen.</div>';
      var retry = document.createElement('button'); retry.className = 'btn btn-secondary'; retry.textContent = 'Reintentar';
      retry.addEventListener('click', viewSummary);
      err.querySelector('.state-box').appendChild(retry);
      root.appendChild(err);
    });
    refreshUnreadBadge();
    // B6: Auto-refresco del resumen cada 15s (se limpia al salir de la vista)
    if (window._summaryTimer) clearInterval(window._summaryTimer);
    window._summaryTimer = setInterval(function () {
      // Solo refrescar si seguimos en la vista de resumen
      if (location.hash !== '#/summary' && location.hash !== '') {
        clearInterval(window._summaryTimer);
        window._summaryTimer = null;
        return;
      }
      api('/api/dashboard/summary').then(function (r) {
        var s = r.data;
        var nums = document.querySelectorAll('.metric-num');
        var vals = [s.campaignsActive, s.sentTotal, s.ctrPercent + '%', s.clicks, s.contactsTotal, s.suppressedTotal, s.conversationsTotal, s.unreadTotal];
        nums.forEach(function (el, i) {
          if (i < vals.length) el.textContent = String(vals[i]);
        });
      }).catch(function () {});
    }, 15000);
  }

  // ============================================================
  // VISTA: Conversaciones / Chat
  // ============================================================
  var activeConversation = null;
  var convFilter = 'all';
  function viewConversations() {
    setTitle('Conversaciones');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    activeConversation = null;
    var layout = document.createElement('div');
    layout.className = 'chat-layout';
    layout.innerHTML = '<div class="conv-list" id="convList"><div class="skeleton" style="margin:12px; width:80%"></div></div>' +
      '<div class="chat-thread" id="chatThread"><div class="state-box">Selecciona una conversación para ver el hilo.</div></div>';
    root.appendChild(layout);
    var q = document.createElement('div');
    q.className = 'conv-toolbar';
    var buscador = document.createElement('input');
    buscador.id = 'convSearch';
    buscador.placeholder = 'Buscar por teléfono o nombre…';
    buscador.style.maxWidth = '260px';
    q.appendChild(buscador);
    var grupo = document.createElement('div');
    grupo.className = 'conv-filtro';
    grupo.setAttribute('role', 'group');
    grupo.setAttribute('aria-label', 'Filtrar conversaciones por lectura');
    var bTodas = document.createElement('button');
    bTodas.type = 'button'; bTodas.id = 'convFilterAll'; bTodas.className = 'btn btn-sm btn-accent';
    bTodas.setAttribute('aria-pressed', 'true'); bTodas.textContent = 'Todas';
    var bNoLeidas = document.createElement('button');
    bNoLeidas.type = 'button'; bNoLeidas.id = 'convFilterUnread'; bNoLeidas.className = 'btn btn-sm btn-secondary';
    bNoLeidas.setAttribute('aria-pressed', 'false'); bNoLeidas.textContent = 'No leídas ';
    var contadorNoLeidas = document.createElement('span');
    contadorNoLeidas.id = 'convUnreadCount';
    bNoLeidas.appendChild(contadorNoLeidas);
    grupo.appendChild(bTodas); grupo.appendChild(bNoLeidas);
    q.appendChild(grupo);
    root.insertBefore(q, layout);
    buscador.addEventListener('input', loadConversationList);
    // F2: filtro leído / no leído. El filtro lo aplica el servidor (unreadOnly=1),
    // no el navegador, y el botón activo lo anuncia con aria-pressed.
    function setConvFilter(valor) {
      convFilter = valor === 'unread' ? 'unread' : 'all';
      bTodas.setAttribute('aria-pressed', convFilter === 'all' ? 'true' : 'false');
      bTodas.className = 'btn btn-sm ' + (convFilter === 'all' ? 'btn-accent' : 'btn-secondary');
      bNoLeidas.setAttribute('aria-pressed', convFilter === 'unread' ? 'true' : 'false');
      bNoLeidas.className = 'btn btn-sm ' + (convFilter === 'unread' ? 'btn-accent' : 'btn-secondary');
      loadConversationList();
    }
    bTodas.addEventListener('click', function () { setConvFilter('all'); });
    bNoLeidas.addEventListener('click', function () { setConvFilter('unread'); });
    loadConversationList();
    refreshUnreadBadge();
    viewTimers.push(setInterval(function () { loadConversationList(); pollActiveThread(); refreshUnreadBadge(); }, 4000));
  }

  function loadConversationList() {
    var listEl = document.getElementById('convList');
    if (!listEl) return;
    var qv = (document.getElementById('convSearch') || {}).value || '';
    var url = '/api/conversations?q=' + encodeURIComponent(qv) + (convFilter === 'unread' ? '&unreadOnly=1' : '');
    api(url).then(function (r) {
      var convs = r.data.conversations || [];
      listEl.textContent = '';
      if (convs.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = convFilter === 'unread'
          ? 'No hay conversaciones sin leer: al abrir un hilo sus mensajes quedan leídos.'
          : 'Sin conversaciones todavía. Llegan al recibir un mensaje entrante (webhook) o al escribir desde contactos.';
        listEl.appendChild(empty);
        var totalEl = document.getElementById('convUnreadCount');
        if (totalEl && convFilter === 'unread') totalEl.textContent = '0';
        return;
      }
      convs.forEach(function (c) {
        var item = document.createElement('div');
        item.className = 'conv-item' + (c.contact_phone === activeConversation ? ' active' : '');
        var name = document.createElement('div'); name.className = 'conv-name';
        var nm = document.createElement('span'); nm.textContent = c.contact_name || ('+' + c.contact_phone);
        name.appendChild(nm);
        if (c.unread > 0) {
          var u = document.createElement('span'); u.className = 'conv-unread'; u.textContent = String(c.unread); name.appendChild(u);
          // F2: marcar leída sin abrir el hilo (deja el contador a cero en el sitio).
          var markRead = document.createElement('button');
          markRead.type = 'button'; markRead.className = 'conv-mark'; markRead.title = 'Marcar como leída';
          markRead.setAttribute('aria-label', 'Marcar como leída');
          markRead.textContent = '✓';
          markRead.addEventListener('click', function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            api('/api/conversations/' + encodeURIComponent(c.contact_phone) + '/read', { method: 'POST' })
              .then(function () { loadConversationList(); refreshUnreadBadge(); })
              .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo marcar como leída', 'err'); });
          });
          name.appendChild(markRead);
        }
        var last = document.createElement('div'); last.className = 'conv-last';
        last.textContent = (c.last_direction === 'outbound' ? '➤ ' : '⬅ ') + (c.last_message_text || '');
        item.appendChild(name); item.appendChild(last);
        item.addEventListener('click', function () { openConversation(c.contact_phone); });
        listEl.appendChild(item);
      });
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando conversaciones', 'err'); });
  }

  // (reparación de verificación V-12/V-13) El sondeo SOLO refresca la LISTA y los
  // mensajes nuevos: JAMÁS reconstruye el hilo completo — destruiría el compositor
  // mientras el operador escribe (pérdida de texto y de menú «/»). Si hay texto
  // en el compositor, el refresco de mensajes espera al siguiente ciclo.
  function pollActiveThread() {
    if (!activeConversation) return;
    var ta = document.getElementById('composerText');
    if (ta && ta.value && ta.value.length > 0) return;
    var msgs = document.getElementById('threadMsgs');
    if (!msgs) return;
    api('/api/conversations/' + encodeURIComponent(activeConversation)).then(function (r) {
      var container = document.getElementById('threadMsgs');
      if (!container) return;
      var count = (r.data.messages || []).length;
      var lastCount = parseInt(container.getAttribute('data-count') || '0', 10);
      if (count !== lastCount) {
        container.textContent = '';
        renderThreadMessages(container, r.data.messages || []);
        container.setAttribute('data-count', String(count));
        container.scrollTop = container.scrollHeight;
      }
    }).catch(function () {});
  }

  function openConversation(phone, silent) {
    activeConversation = phone;
    document.querySelectorAll('.conv-item').forEach(function (el) { el.classList.remove('active'); });
    api('/api/conversations/' + encodeURIComponent(phone) + '?limit=50').then(function (r) {
      var threadEl = document.getElementById('chatThread');
      if (!threadEl) return;
      threadEl.textContent = '';
      var conv = r.data.conversation;
      var head = document.createElement('div'); head.className = 'thread-head';
      var title = document.createElement('strong'); title.textContent = (conv.contact_name || '') + ' (+' + conv.contact_phone + ')';
      var right = document.createElement('div'); right.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;';
      var agentSel = document.createElement('select'); agentSel.id = 'assignSel'; agentSel.style.cssText = 'width:auto; font-size:11px; padding:4px 6px;';
      var opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = 'Sin asignar';
      agentSel.appendChild(opt0);
      api('/api/agents').then(function (ar) {
        (ar.data.agents || []).forEach(function (a) {
          var o = document.createElement('option'); o.value = a.id; o.textContent = a.name + (a.active ? '' : ' (inactivo)');
          agentSel.appendChild(o);
        });
        agentSel.value = conv.assigned_agent_id || '';
      }).catch(function () {});
      agentSel.addEventListener('change', function () {
        api('/api/conversations/' + encodeURIComponent(phone) + '/assign', { method: 'POST', body: JSON.stringify({ agentId: agentSel.value || null }) })
          .then(function () { toast('Asignación actualizada'); loadConversationList(); })
          .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo asignar', 'err'); });
      });
      right.appendChild(agentSel);
      head.appendChild(title); head.appendChild(right);
      var msgs = document.createElement('div'); msgs.className = 'thread-msgs'; msgs.id = 'threadMsgs';
      // F4: el hilo se pagina de 50 en 50; este boton pide los anteriores.
      var olderBar = document.createElement('div'); olderBar.className = 'thread-more'; olderBar.id = 'threadMore';
      var olderState = { oldest: r.data.oldestMessageId || null, hasMore: !!r.data.hasMore, loading: false };
      function drawOlder() {
        olderBar.textContent = '';
        if (!olderState.hasMore || !olderState.oldest) { olderBar.style.display = 'none'; return; }
        olderBar.style.display = 'flex';
        var bOlder = document.createElement('button');
        bOlder.className = 'btn btn-ghost btn-sm';
        bOlder.id = 'threadOlder';
        bOlder.textContent = 'Cargar mensajes anteriores';
        bOlder.setAttribute('aria-label', 'Cargar mensajes anteriores de esta conversacion');
        bOlder.addEventListener('click', function () {
          if (olderState.loading) return;
          olderState.loading = true;
          bOlder.disabled = true;
          bOlder.textContent = 'Cargando…';
          api('/api/conversations/' + encodeURIComponent(phone) + '?limit=50&before=' + encodeURIComponent(olderState.oldest))
            .then(function (older) {
              var tmp = document.createElement('div');
              renderThreadMessages(tmp, older.data.messages || []);
              var emptyBox = msgs.querySelector('.state-box');
              if (emptyBox) emptyBox.remove();
              var first = msgs.firstChild;
              while (tmp.firstChild) msgs.insertBefore(tmp.firstChild, first);
              olderState.oldest = older.data.oldestMessageId || null;
              olderState.hasMore = !!older.data.hasMore;
              olderState.loading = false;
              msgs.setAttribute('data-count', String(msgs.querySelectorAll('.bubble').length));
              drawOlder();
              toast('Mensajes anteriores cargados');
            })
            .catch(function (e) {
              olderState.loading = false;
              if (String(e.message) !== 'SESSION_EXPIRED') {
                bOlder.disabled = false;
                bOlder.textContent = 'Cargar mensajes anteriores';
                toast('No se pudieron cargar los mensajes anteriores', 'err');
              }
            });
        });
        olderBar.appendChild(bOlder);
      }
      renderThreadMessages(msgs, r.data.messages || []);
      msgs.setAttribute('data-count', String((r.data.messages || []).length));
      drawOlder();
      var qrMenu = document.createElement('div'); qrMenu.className = 'qr-menu'; qrMenu.id = 'qrMenu';
      var composer = document.createElement('div'); composer.className = 'composer';
      var ta = document.createElement('textarea'); ta.id = 'composerText'; ta.placeholder = 'Escribe un mensaje… (/ para respuestas rápidas)';
      var sendBtn = document.createElement('button'); sendBtn.className = 'btn btn-accent'; sendBtn.textContent = '➤ Enviar';
      sendBtn.addEventListener('click', sendChatMessage);
      ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChatMessage(); } });
      ta.addEventListener('input', function () {
        var menu = document.getElementById('qrMenu');
        var val = ta.value;
        if (val === '/' || val.lastIndexOf('/', 0) === 0) {
          api('/api/quick-replies').then(function (qr) {
            var list = (qr.data.quickReplies || []);
            menu.textContent = '';
            if (list.length === 0) { menu.style.display = 'none'; return; }
            list.forEach(function (qrItem) {
              var it = document.createElement('div'); it.className = 'qr-item';
              it.textContent = qrItem.shortcut + ' — ' + qrItem.title;
              it.addEventListener('click', function () {
                ta.value = qrItem.body;
                menu.style.display = 'none';
                ta.focus();
              });
              menu.appendChild(it);
            });
            menu.style.display = 'block';
          }).catch(function () {});
        } else { menu.style.display = 'none'; }
      });
      composer.appendChild(qrMenu); composer.appendChild(ta); composer.appendChild(sendBtn);
      threadEl.appendChild(head); threadEl.appendChild(olderBar); threadEl.appendChild(msgs); threadEl.appendChild(composer);
      msgs.scrollTop = msgs.scrollHeight;
      loadConversationList();
    }).catch(function (e) {
      if (String(e.message) === 'SESSION_EXPIRED' || silent) return;
      toast('No se pudo abrir la conversación', 'err');
    });
  }

  function renderThreadMessages(container, messages) {
    if (messages.length === 0) {
      var empty = document.createElement('div'); empty.className = 'state-box';
      empty.textContent = 'Sin mensajes en este hilo todavía.';
      container.appendChild(empty);
      return;
    }
    messages.forEach(function (m) {
      var b = document.createElement('div');
      b.className = 'bubble ' + (m.direction === 'outbound' ? 'out' : 'in');
      var body = document.createElement('span');
      body.textContent = m.text;
      b.appendChild(body);
      var meta = document.createElement('span'); meta.className = 'meta';
      // F5: un fallo de entrega muestra el error REAL del transporte en el title.
      var fallo = m.direction === 'outbound' && m.status !== 'SENT';
      var statusText = m.direction === 'outbound' ? (fallo ? ' ✗' : ' ✓') : '';
      meta.textContent = new Date(m.createdAt * 1000).toLocaleTimeString('es') + statusText + (m.source === 'campaign' ? ' · campaña' : '');
      if (fallo) {
        var motivo = m.error ? String(m.error) : 'fallo de entrega (sin detalle del transporte)';
        b.classList.add('failed');
        b.title = 'Error de entrega: ' + motivo;
        meta.title = b.title;
      }
      b.appendChild(meta);
      container.appendChild(b);
    });
  }

  function sendChatMessage() {
    if (!activeConversation) return;
    var ta = document.getElementById('composerText');
    var text = (ta.value || '').trim();
    if (!text) { toast('El mensaje está vacío', 'err'); return; }
    var sendBtn = document.querySelector('.composer .btn-accent');
    if (sendBtn) sendBtn.disabled = true;
    api('/api/conversations/' + encodeURIComponent(activeConversation) + '/messages', { method: 'POST', body: JSON.stringify({ text: text }) })
      .then(function (r) {
        if (sendBtn) sendBtn.disabled = false;
        ta.value = '';
        if (r.data.ok) toast('Mensaje enviado', 'ok');
        else toast('No se envió: ' + (r.data.dispatch && r.data.dispatch.error ? r.data.dispatch.error : 'fallo de transporte'), 'err');
        openConversation(activeConversation, true);
      })
      .catch(function (e) {
        if (sendBtn) sendBtn.disabled = false;
        if (String(e.message) !== 'SESSION_EXPIRED') {
          // el motivo REAL del backend (supresión, lock 2A, fallo de transporte) siempre visible
          var detail = (e && e.data && (e.data.error || (e.data.dispatch && e.data.dispatch.error)))
            ? (e.data.error || (e.data.dispatch && e.data.dispatch.error))
            : 'error de red';
          toast('No se envió: ' + detail, 'err');
          openConversation(activeConversation, true);
        }
      });
  }

  // ============================================================
  // VISTA: Contactos
  // ============================================================
  function viewContacts() {
    setTitle('Contactos');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center;';
    toolbar.innerHTML =
      '<input id="ctSearch" placeholder="Buscar teléfono o nombre…" style="max-width:240px;">' +
      '<select id="ctTagFilter" style="width:auto;"><option value="">Todas las etiquetas</option></select>' +
      '<select id="ctStageFilter" style="width:auto;"><option value="">Todas las etapas</option></select>' +
      '<span style="flex:1"></span>';
    var bImport = document.createElement('button'); bImport.className = 'btn btn-secondary btn-sm'; bImport.textContent = '📥 Importar CSV';
    bImport.addEventListener('click', openImportModal);
    var bExport = document.createElement('button'); bExport.className = 'btn btn-secondary btn-sm'; bExport.textContent = '📤 Exportar CSV';
    bExport.addEventListener('click', function () {
      // F6: el CSV lleva los mismos filtros que la pantalla y sale COMPLETO.
      var qv = (document.getElementById('ctSearch') || {}).value || '';
      var tg = (document.getElementById('ctTagFilter') || {}).value || '';
      var sg = (document.getElementById('ctStageFilter') || {}).value || '';
      window.location.href = '/api/contacts/export.csv?q=' + encodeURIComponent(qv) + '&tagId=' + encodeURIComponent(tg) + '&stageId=' + encodeURIComponent(sg);
    });
    var bNew = document.createElement('button'); bNew.className = 'btn btn-accent btn-sm'; bNew.textContent = '＋ Nuevo contacto';
    bNew.addEventListener('click', function () { openContactModal(null); });
    toolbar.appendChild(bImport); toolbar.appendChild(bExport); toolbar.appendChild(bNew);
    root.appendChild(toolbar);
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.id = 'contactsWrap';
    root.appendChild(wrap);
    var pagination = document.createElement('div');
    pagination.id = 'ctPagination';
    pagination.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:10px; align-items:center; font-size:12px; color:var(--text-muted);';
    root.appendChild(pagination);
    var state = { offset: 0, limit: 20 };
    window.__ctState = state;
    function load() {
      var st = window.__ctState;
      var qv = (document.getElementById('ctSearch') || {}).value || '';
      var tag = (document.getElementById('ctTagFilter') || {}).value || '';
      var stage = (document.getElementById('ctStageFilter') || {}).value || '';
      wrap.innerHTML = '<div class="skeleton" style="margin:12px; width:70%"></div><div class="skeleton" style="margin:12px; width:50%"></div>';
      api('/api/contacts?limit=' + st.limit + '&offset=' + st.offset + '&q=' + encodeURIComponent(qv) + '&tagId=' + encodeURIComponent(tag) + '&stageId=' + encodeURIComponent(stage))
        .then(function (r) {
          var contacts = r.data.contacts || [];
          wrap.textContent = '';
          var table = document.createElement('table');
          var thead = document.createElement('thead');
          var hr = document.createElement('tr');
          ['Teléfono', 'Nombre', 'Etapa', 'Etiquetas', 'Origen', 'Creado', 'Acciones'].forEach(function (h) {
            var th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
          });
          thead.appendChild(hr); table.appendChild(thead);
          var tbody = document.createElement('tbody');
          if (contacts.length === 0) {
            var er = document.createElement('tr');
            var ed = document.createElement('td'); ed.colSpan = 7;
            ed.className = 'state-box'; ed.textContent = 'Sin contactos. Importa un CSV o crea el primero.';
            var cta = document.createElement('button'); cta.className = 'btn btn-accent btn-sm'; cta.textContent = '📥 Importar CSV';
            cta.addEventListener('click', openImportModal);
            ed.appendChild(cta);
            er.appendChild(ed); tbody.appendChild(er);
          }
          contacts.forEach(function (c) {
            var tr = document.createElement('tr');
            var tdP = document.createElement('td'); tdP.style.fontWeight = '700'; tdP.textContent = '+' + c.phone;
            var tdN = document.createElement('td'); tdN.textContent = c.name || '-';
            var tdS = document.createElement('td');
            var sel = document.createElement('select'); sel.style.cssText = 'width:auto; font-size:11px; padding:3px 6px;';
            var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '—'; sel.appendChild(o0);
            (window.__stagesCache || []).forEach(function (s) {
              var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o);
            });
            sel.value = c.stage_id || '';
            sel.addEventListener('change', function () {
              api('/api/contacts/' + encodeURIComponent(c.phone), { method: 'PUT', body: JSON.stringify({ stageId: sel.value || null }) })
                .then(function () { toast('Etapa actualizada'); })
                .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo cambiar la etapa', 'err'); });
            });
            tdS.appendChild(sel);
            var tdT = document.createElement('td');
            (c.tags || []).forEach(function (t) {
              var chip = document.createElement('span'); chip.className = 'tag-chip'; chip.textContent = t.name;
              tdT.appendChild(chip);
            });
            var tdO = document.createElement('td'); tdO.textContent = c.source;
            var tdC = document.createElement('td'); tdC.textContent = fmtTime(c.created_at);
            var tdA = document.createElement('td'); tdA.style.whiteSpace = 'nowrap';
            var bE = document.createElement('button'); bE.className = 'btn btn-secondary btn-sm'; bE.textContent = '✏️';
            bE.addEventListener('click', function () { openContactModal(c); });
            var bT = document.createElement('button'); bT.className = 'btn btn-secondary btn-sm'; bT.style.marginLeft = '4px'; bT.textContent = '🏷️';
            bT.addEventListener('click', function () { openTagsModal(c); });
            var bC = document.createElement('button'); bC.className = 'btn btn-secondary btn-sm'; bC.style.marginLeft = '4px'; bC.textContent = '🛡️';
            bC.title = 'Registrar consentimiento';
            bC.setAttribute('aria-label', 'Registrar consentimiento de ' + c.phone);
            bC.addEventListener('click', function () { openConsentModal(c); });
            var bD = document.createElement('button'); bD.className = 'btn btn-danger btn-sm'; bD.style.marginLeft = '4px'; bD.textContent = '🗑';
            bD.addEventListener('click', function () {
              openModal('<h3>¿Borrar contacto?</h3><p style="font-size:12px;color:var(--text-muted)">Se eliminarán también su conversación y sus mensajes. Esta acción no se puede deshacer.</p>' +
                '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-danger" id="mOk">Borrar</button></div>');
              document.getElementById('mCancel').addEventListener('click', closeModal);
              document.getElementById('mOk').addEventListener('click', function () {
                api('/api/contacts/' + encodeURIComponent(c.phone), { method: 'DELETE' }).then(function () {
                  closeModal(); toast('Contacto borrado'); load();
                }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo borrar', 'err'); });
              });
            });
            tdA.appendChild(bE); tdA.appendChild(bT); tdA.appendChild(bC); tdA.appendChild(bD);
            tr.appendChild(tdP); tr.appendChild(tdN); tr.appendChild(tdS); tr.appendChild(tdT); tr.appendChild(tdO); tr.appendChild(tdC); tr.appendChild(tdA);
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          wrap.appendChild(table);
          var total = r.data.total || 0;
          var pag = document.getElementById('ctPagination');
          pag.textContent = '';
          var info = document.createElement('span');
          info.textContent = (total === 0 ? '0' : (st.offset + 1) + '–' + Math.min(st.offset + st.limit, total)) + ' de ' + total;
          pag.appendChild(info);
          var prev = document.createElement('button'); prev.className = 'btn btn-ghost btn-sm'; prev.textContent = '‹ Anterior';
          prev.disabled = st.offset === 0;
          prev.addEventListener('click', function () { st.offset = Math.max(0, st.offset - st.limit); load(); });
          var next = document.createElement('button'); next.className = 'btn btn-ghost btn-sm'; next.textContent = 'Siguiente ›';
          next.disabled = st.offset + st.limit >= total;
          next.addEventListener('click', function () { st.offset = st.offset + st.limit; load(); });
          pag.appendChild(prev); pag.appendChild(next);
          // F6: salto directo a una pagina concreta.
          var pages = Math.max(1, Math.ceil(total / st.limit));
          var jump = document.createElement('input');
          jump.id = 'ctJump'; jump.type = 'number'; jump.min = '1'; jump.max = String(pages); jump.value = String(Math.floor(st.offset / st.limit) + 1);
          jump.setAttribute('aria-label', 'Numero de pagina');
          jump.style.cssText = 'width:64px; padding:4px 6px;';
          var jumpBtn = document.createElement('button');
          jumpBtn.className = 'btn btn-ghost btn-sm'; jumpBtn.id = 'ctJumpGo'; jumpBtn.textContent = 'Ir';
          jumpBtn.setAttribute('aria-label', 'Ir a la pagina indicada');
          function goToPage() {
            var p = parseInt(jump.value || '1', 10);
            if (!isFinite(p)) p = 1;
            p = Math.min(pages, Math.max(1, p));
            st.offset = (p - 1) * st.limit;
            load();
          }
          jumpBtn.addEventListener('click', goToPage);
          jump.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); goToPage(); } });
          var pageLbl = document.createElement('span'); pageLbl.textContent = 'pág.';
          pag.appendChild(pageLbl); pag.appendChild(jump); pag.appendChild(jumpBtn);
        })
        .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; var err = document.createElement('div'); err.className = 'state-box'; err.textContent = 'Error cargando contactos.'; wrap.appendChild(err); } });
    }
    api('/api/tags').then(function (r) {
      var tagSel = document.getElementById('ctTagFilter');
      (r.data.tags || []).forEach(function (t) {
        var o = document.createElement('option'); o.value = t.id; o.textContent = t.name; tagSel.appendChild(o);
      });
    }).catch(function () {});
    api('/api/pipeline/stages').then(function (r) {
      window.__stagesCache = r.data.stages || [];
      var stageSel = document.getElementById('ctStageFilter');
      window.__stagesCache.forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; stageSel.appendChild(o);
      });
      load();
    }).catch(function () { load(); });
    var searchEl = document.getElementById('ctSearch');
    var timer = null;
    searchEl.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { window.__ctState.offset = 0; load(); }, 350);
    });
    document.getElementById('ctTagFilter').addEventListener('change', function () { window.__ctState.offset = 0; load(); });
    document.getElementById('ctStageFilter').addEventListener('change', function () { window.__ctState.offset = 0; load(); });
  }

  function openConsentModal(contact) {
    openModal(
      '<h3>Registrar consentimiento</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);">Se guarda en el servidor con fecha, canal y texto mostrado.</p>' +
      '<div class="form-group"><label>Teléfono</label><input id="mConsentPhone" value="' + esc(contact.phone) + '" disabled></div>' +
      '<div class="form-group"><label>¿Quién autorizó?</label><input id="mConsentWho" value="' + esc(contact.name || '') + '" placeholder="Nombre del titular"></div>' +
      '<div class="form-group"><label>Canal</label><select id="mConsentChannel"><option value="whatsapp">WhatsApp</option><option value="formulario">Formulario</option><option value="verbal">Verbal</option><option value="csv">CSV / importación</option></select></div>' +
      '<div class="form-group"><label>Texto mostrado</label><textarea id="mConsentText" rows="2">Acepto recibir mensajes de este negocio por WhatsApp.</textarea></div>' +
      '<div class="msg" id="mConsentNote" style="display:none"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mOk">Registrar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mOk').addEventListener('click', function () {
      var body = {
        contactPhone: contact.phone,
        whoAuthorized: document.getElementById('mConsentWho').value.trim() || contact.phone,
        channel: document.getElementById('mConsentChannel').value,
        textShown: document.getElementById('mConsentText').value.trim(),
        source: 'panel'
      };
      api('/api/compliance/consent', { method: 'POST', body: JSON.stringify(body) })
        .then(function () { closeModal(); toast('Consentimiento registrado en el servidor'); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var note = document.getElementById('mConsentNote');
          var why = (e && e.data && e.data.error) ? e.data.error : 'error de red';
          if (note) {
            note.style.display = 'block';
            note.className = 'msg error';
            note.textContent = 'NO se registró en el servidor (' + why + '). Este consentimiento quedó SOLO en este navegador: no cuenta para la difusión.';
          }
        });
    });
  }

  function openContactModal(contact) {
    var isEdit = !!contact;
    openModal(
      '<h3>' + (isEdit ? 'Editar contacto' : 'Nuevo contacto') + '</h3>' +
      '<div class="form-group"><label>Teléfono (E.164, ej. 573001234567)</label><input id="mPhone" ' + (isEdit ? 'value="' + esc(contact.phone) + '" disabled' : 'placeholder="573001234567"') + '></div>' +
      '<div class="form-group"><label>Nombre</label><input id="mName" value="' + (isEdit ? esc(contact.name || '') : '') + '"></div>' +
      '<div class="form-group"><label>Email (opcional)</label><input id="mEmail" value="' + (isEdit ? esc(contact.email || '') : '') + '"></div>' +
      '<div class="form-group"><label>Notas (opcional)</label><textarea id="mNotes" rows="2">' + (isEdit ? esc(contact.notes || '') : '') + '</textarea></div>' +
      '<div class="msg error" id="mErr" style="display:none"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mSave">Guardar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mSave').addEventListener('click', function () {
      var payload = {
        phone: document.getElementById('mPhone').value.trim(),
        name: document.getElementById('mName').value.trim(),
        email: document.getElementById('mEmail').value.trim(),
        notes: document.getElementById('mNotes').value.trim()
      };
      if (!payload.phone) {
        var errEl = document.getElementById('mErr');
        errEl.style.display = 'block';
        errEl.textContent = 'El teléfono es obligatorio (formato E.164, ej. 573001234567)';
        return;
      }
      var req = isEdit
        ? api('/api/contacts/' + encodeURIComponent(contact.phone), { method: 'PUT', body: JSON.stringify({ name: payload.name, email: payload.email, notes: payload.notes }) })
        : api('/api/contacts', { method: 'POST', body: JSON.stringify(payload) });
      req.then(function () { closeModal(); toast(isEdit ? 'Contacto actualizado' : 'Contacto creado'); viewContacts(); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var errEl = document.getElementById('mErr');
          errEl.style.display = 'block';
          errEl.textContent = 'No se pudo guardar. Revisa el teléfono (E.164) y que no exista ya.';
        });
    });
  }

  function openImportModal() {
    openModal(
      '<h3>Importar contactos desde CSV</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Formato: una línea por contacto <b>teléfono,nombre</b>. Normaliza +57/+34 y descarta duplicados e inválidos (mismo validador que las campañas).</p>' +
      '<div class="form-group"><label>Archivo CSV (opcional)</label><input type="file" id="mFile" accept=".csv,text/csv"></div>' +
      '<div class="form-group"><label>…o pega el contenido</label><textarea id="mCsv" rows="6" placeholder="phone,name&#10;573001234567,Carlos Perez"></textarea></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mImport">Importar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mFile').addEventListener('change', function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { document.getElementById('mCsv').value = String(reader.result || '').slice(0, 900000); };
      reader.readAsText(f);
    });
    document.getElementById('mImport').addEventListener('click', function () {
      var csv = document.getElementById('mCsv').value;
      api('/api/contacts/import-csv', { method: 'POST', body: JSON.stringify({ csvContent: csv }) }).then(function (r) {
        closeModal();
        var d = r.data;
        openModal('<h3>Resultado de la importación</h3>' +
          '<table><tbody>' +
          '<tr><td>Procesados</td><td><b>' + d.totalProcessed + '</b></td></tr>' +
          '<tr><td>Válidos</td><td><b>' + d.validCount + '</b></td></tr>' +
          '<tr><td>Insertados nuevos</td><td><b style="color:#10b981">' + d.inserted + '</b></td></tr>' +
          '<tr><td>Duplicados descartados</td><td><b style="color:#f59e0b">' + d.duplicatesCount + '</b></td></tr>' +
          '<tr><td>Inválidos descartados</td><td><b style="color:#ef4444">' + d.invalidCount + '</b></td></tr>' +
          '</tbody></table>' +
          '<div class="modal-actions"><button class="btn btn-accent" id="mDone">Listo</button></div>');
        document.getElementById('mDone').addEventListener('click', function () { closeModal(); viewContacts(); });
      }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error en la importación', 'err'); });
    });
  }

  function openTagsModal(contact) {
    Promise.all([api('/api/tags'), api('/api/contacts/' + encodeURIComponent(contact.phone))]).then(function (results) {
      var allTags = results[0].data.tags || [];
      var mine = ((results[1].data.contact || {}).tags || []).map(function (t) { return t.id; });
      var html = '<h3>Etiquetas de +' + esc(contact.phone) + '</h3>';
      if (allTags.length === 0) html += '<div class="state-box">No hay etiquetas aún. Créalas en la pantalla Etiquetas.</div>';
      allTags.forEach(function (t) {
        var checked = mine.indexOf(t.id) >= 0 ? ' checked' : '';
        html += '<label style="display:flex; align-items:center; gap:8px; font-weight:normal; margin-bottom:6px; color:var(--text);">' +
          '<input type="checkbox" class="mTagCb" value="' + esc(t.id) + '"' + checked + ' style="width:auto;"> ' + esc(t.name) + '</label>';
      });
      html += '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cerrar</button><button class="btn btn-accent" id="mSave">Guardar</button></div>';
      openModal(html);
      document.getElementById('mCancel').addEventListener('click', closeModal);
      document.getElementById('mSave').addEventListener('click', function () {
        var selected = Array.prototype.map.call(document.querySelectorAll('.mTagCb:checked'), function (cb) { return cb.value; });
        var toAdd = selected.filter(function (id) { return mine.indexOf(id) < 0; });
        var toRemove = mine.filter(function (id) { return selected.indexOf(id) < 0; });
        var ops = toAdd.map(function (id) { return api('/api/contacts/' + encodeURIComponent(contact.phone) + '/tags/' + encodeURIComponent(id), { method: 'POST' }); });
        ops = ops.concat(toRemove.map(function (id) { return api('/api/contacts/' + encodeURIComponent(contact.phone) + '/tags/' + encodeURIComponent(id), { method: 'DELETE' }); }));
        Promise.all(ops).then(function () { closeModal(); toast('Etiquetas actualizadas'); viewContacts(); })
          .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error actualizando etiquetas', 'err'); });
      });
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando etiquetas', 'err'); });
  }

  // ============================================================
  // VISTA: Embudo / Kanban
  // ============================================================
  function viewPipeline() {
    setTitle('Embudo');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap;';
    var busca = document.createElement('input');
    busca.id = 'pkSearch'; busca.type = 'search';
    busca.placeholder = 'Filtrar por nombre o teléfono…';
    busca.style.cssText = 'max-width:260px;';
    busca.setAttribute('aria-label', 'Filtrar tarjetas por nombre o teléfono');
    var bStage = document.createElement('button'); bStage.className = 'btn btn-secondary btn-sm'; bStage.textContent = '⚙️ Gestionar etapas';
    bStage.addEventListener('click', openStagesModal);
    var spacer = document.createElement('span'); spacer.style.cssText = 'flex:1';
    bar.appendChild(busca); bar.appendChild(spacer); bar.appendChild(bStage);
    root.appendChild(bar);
    var board = document.createElement('div');
    board.className = 'kanban';
    board.id = 'kanbanBoard';
    board.innerHTML = '<div class="skeleton" style="width:200px"></div>';
    root.appendChild(board);
    var PAGE = 50;
    var byStage = {};
    function cardNode(c) {
      var card = document.createElement('div');
      card.className = 'kcard';
      card.draggable = true;
      card.setAttribute('data-phone', c.phone);
      var ph = document.createElement('div'); ph.className = 'phone'; ph.textContent = (c.name || '') + ' +' + c.phone;
      card.appendChild(ph);
      if ((c.tags || []).length > 0) {
        var tl = document.createElement('div'); tl.className = 'tagsline';
        c.tags.forEach(function (t) { var chip = document.createElement('span'); chip.className = 'tag-chip'; chip.textContent = t.name; tl.appendChild(chip); });
        card.appendChild(tl);
      }
      card.addEventListener('dragstart', function (ev) { ev.dataTransfer.setData('text/plain', c.phone); card.style.opacity = '0.5'; });
      card.addEventListener('dragend', function () { card.style.opacity = '1'; });
      return card;
    }
    function moveCard(phone, stageId, stageName) {
      var eventId = (crypto.randomUUID ? crypto.randomUUID() : 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      api('/api/pipeline/move', { method: 'POST', body: JSON.stringify({ phone: phone, stageId: stageId, eventId: eventId }) })
        .then(function (r) {
          if (r.data.duplicate) toast('Movimiento ya aplicado (idempotente)', 'info');
          else toast('Tarjeta movida a ' + stageName);
          viewPipeline();
        })
        .catch(function (e) {
          if (String(e.message) !== 'SESSION_EXPIRED') { toast('No se pudo mover la tarjeta', 'err'); viewPipeline(); }
        });
    }
    function fillColumn(col, stage, search) {
      var body = col.querySelector('.kcol-body');
      var st = byStage[stage.id];
      body.textContent = '';
      st.items.forEach(function (c) { body.appendChild(cardNode(c)); });
      if (st.items.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = search ? 'Sin coincidencias en esta etapa.' : 'Sin tarjetas en esta etapa.';
        body.appendChild(empty);
      }
      if (st.hasMore) {
        var more = document.createElement('button');
        more.className = 'btn btn-ghost btn-sm';
        more.textContent = '＋ Cargar más de ' + stage.name;
        more.setAttribute('aria-label', 'Cargar más tarjetas de ' + stage.name);
        more.addEventListener('click', function () {
          if (st.loading) return;
          st.loading = true; more.disabled = true;
          api('/api/contacts?limit=' + PAGE + '&offset=' + st.items.length + '&stageId=' + encodeURIComponent(stage.id) + '&q=' + encodeURIComponent(search))
            .then(function (r) {
              var page = r.data.contacts || [];
              st.items = st.items.concat(page);
              st.hasMore = page.length === PAGE;
              st.loading = false;
              fillColumn(col, stage, search);
            })
            .catch(function (e) {
              st.loading = false; more.disabled = false;
              if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudieron cargar más tarjetas', 'err');
            });
        });
        body.appendChild(more);
      }
      var cnt = col.querySelector('.kcount');
      if (cnt) cnt.textContent = String(stage.contactCount);
    }
    function load() {
      var search = (document.getElementById('pkSearch') || {}).value || '';
      api('/api/pipeline/stages').then(function (r) {
        var stages = r.data.stages || [];
        byStage = {};
        board.textContent = '';
        if (stages.length === 0) {
          board.innerHTML = '<div class="state-box">No hay etapas todavía. Crea la primera con «Gestionar etapas».</div>';
          return;
        }
        var requests = stages.map(function (s) {
          return api('/api/contacts?limit=' + PAGE + '&offset=0&stageId=' + encodeURIComponent(s.id) + '&q=' + encodeURIComponent(search));
        });
        Promise.all(requests).then(function (results) {
          stages.forEach(function (s, i) {
            var page = (results[i].data.contacts || []);
            byStage[s.id] = { items: page, hasMore: page.length === PAGE, loading: false };
          });
          stages.forEach(function (s) {
            var col = document.createElement('div');
            col.className = 'kcol';
            col.setAttribute('data-stage', s.id);
            var head = document.createElement('div'); head.className = 'kcol-head';
            var nm = document.createElement('span'); nm.textContent = s.name;
            var cnt = document.createElement('span'); cnt.className = 'kcount'; cnt.style.color = 'var(--text-muted)'; cnt.textContent = String(s.contactCount);
            head.appendChild(nm); head.appendChild(cnt);
            var body = document.createElement('div'); body.className = 'kcol-body';
            col.appendChild(head); col.appendChild(body);
            col.addEventListener('dragover', function (ev) { ev.preventDefault(); col.classList.add('dragover'); });
            col.addEventListener('dragleave', function () { col.classList.remove('dragover'); });
            col.addEventListener('drop', function (ev) {
              ev.preventDefault();
              col.classList.remove('dragover');
              var phone = ev.dataTransfer.getData('text/plain');
              if (!phone) return;
              moveCard(phone, s.id, s.name);
            });
            board.appendChild(col);
            fillColumn(col, s, search);
          });
        }).catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          board.textContent = '';
          board.innerHTML = '<div class="state-box">Error cargando las tarjetas del embudo.</div>';
        });
      }).catch(function (e) {
        if (String(e.message) === 'SESSION_EXPIRED') return;
        board.textContent = '';
        board.innerHTML = '<div class="state-box">Error cargando el embudo.</div>';
      });
    }
    var timer = null;
    busca.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(load, 350);
    });
    load();
  }

  function openStagesModal() {
    api('/api/pipeline/stages').then(function (r) {
      var stages = r.data.stages || [];
      var html = '<h3>Etapas del embudo</h3>';
      stages.forEach(function (s) {
        html += '<div style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">' +
          '<input class="mStageName" data-id="' + esc(s.id) + '" value="' + esc(s.name) + '" style="flex:1;">' +
          '<span style="font-size:11px;color:var(--text-muted);">' + s.contactCount + ' contactos</span>' +
          '<button class="btn btn-danger btn-sm mStageDel" data-id="' + esc(s.id) + '">🗑</button></div>';
      });
      html += '<div style="display:flex; gap:6px; margin-top:10px;">' +
        '<input id="mNewStage" placeholder="Nueva etapa…" style="flex:1;">' +
        '<button class="btn btn-secondary btn-sm" id="mAddStage">＋ Añadir</button></div>';
      html += '<div class="modal-actions"><button class="btn btn-accent" id="mSave">Guardar cambios</button><button class="btn btn-ghost" id="mCancel">Cerrar</button></div>';
      openModal(html);
      document.getElementById('mCancel').addEventListener('click', closeModal);
      document.getElementById('mAddStage').addEventListener('click', function () {
        var name = document.getElementById('mNewStage').value.trim();
        if (!name) { toast('El nombre es obligatorio', 'err'); return; }
        api('/api/pipeline/stages', { method: 'POST', body: JSON.stringify({ name: name }) })
          .then(function () { closeModal(); openStagesModal(); })
          .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo crear la etapa', 'err'); });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.mStageDel'), function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          api('/api/pipeline/stages/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(function (r2) { closeModal(); toast('Etapa borrada (' + r2.data.movedContacts + ' contactos movidos a la primera etapa)'); openStagesModal(); })
            .catch(function (e) {
              if (String(e.message) !== 'SESSION_EXPIRED') {
                e.response ? null : null;
                toast('No se pudo borrar (¿es la única etapa?)', 'err');
              }
            });
        });
      });
      document.getElementById('mSave').addEventListener('click', function () {
        var ops = Array.prototype.map.call(document.querySelectorAll('.mStageName'), function (inp) {
          return api('/api/pipeline/stages/' + encodeURIComponent(inp.getAttribute('data-id')), { method: 'PUT', body: JSON.stringify({ name: inp.value.trim() }) });
        });
        Promise.all(ops).then(function () { closeModal(); toast('Etapas guardadas'); viewPipeline(); })
          .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error guardando etapas', 'err'); });
      });
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando etapas', 'err'); });
  }

  // ============================================================
  // VISTA: Campañas (lista + creador EXISTENTE + monitor EXISTENTE)
  // ============================================================
  function viewCampaigns() {
    setTitle('Campañas');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var listCard = document.createElement('div');
    listCard.className = 'card';
    listCard.style.marginBottom = '16px';
    listCard.id = 'campaignListCard';
    root.appendChild(listCard);
    var creatorWrap = document.createElement('div');
    creatorWrap.className = 'two-col';
    creatorWrap.id = 'creatorWrap';
    creatorWrap.style.display = 'none';
    root.appendChild(creatorWrap);
    loadCampaignsList();
  }

  function loadCampaignsList() {
    // (paridad — botón «Historial» que estaba muerto en el studio original)
    var card = document.getElementById('campaignListCard');
    if (!card) return;
    card.textContent = '';
    var title = document.createElement('div'); title.className = 'card-title';
    var t1 = document.createElement('span'); t1.textContent = 'Campañas';
    var right = document.createElement('div');
    var bNew = document.createElement('button'); bNew.className = 'btn btn-accent btn-sm'; bNew.textContent = '＋ Nueva campaña';
    bNew.addEventListener('click', function () { showCampaignCreator(); });
    right.appendChild(bNew);
    title.appendChild(t1); title.appendChild(right);
    card.appendChild(title);
    var wrap = document.createElement('div'); wrap.className = 'table-wrap';
    wrap.innerHTML = '<div class="skeleton" style="margin:12px; width:60%"></div>';
    card.appendChild(wrap);
    api('/api/campaigns?limit=100').then(function (r) {
      var campaigns = r.data.campaigns || [];
      wrap.textContent = '';
      if (campaigns.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = 'Sin campañas todavía.';
        var b = document.createElement('button'); b.className = 'btn btn-accent btn-sm'; b.textContent = '🚀 Crear la primera campaña';
        b.addEventListener('click', function () { showCampaignCreator(); });
        empty.appendChild(document.createElement('br'));
        empty.appendChild(b);
        wrap.appendChild(empty);
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead'); var hr = document.createElement('tr');
      ['Nombre', 'Estado', 'Destinatarios', 'Enviados', 'Omitidos', 'Errores', 'Creada', 'Acciones'].forEach(function (h) {
        var th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
      });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      campaigns.forEach(function (c) {
        var tr = document.createElement('tr');
        var tdN = document.createElement('td'); tdN.style.fontWeight = '700'; tdN.textContent = c.name;
        var badgeClass = c.status === 'SENT' ? 'badge-sent' : (c.status === 'RUNNING' ? 'badge-pending' : (c.status === 'COMPLETED' ? 'badge-sent' : (c.status.indexOf('PAUSED') === 0 ? 'badge-skipped' : (c.status === 'FAILED' || c.status === 'CANCELLED' ? 'badge-failed' : 'badge-neutral'))));
        var tdS = document.createElement('td');
        var sp = document.createElement('span'); sp.className = 'badge-status ' + badgeClass; sp.textContent = c.status;
        tdS.appendChild(sp);
        var tdT = document.createElement('td'); tdT.textContent = String(c.total_targets);
        var tdE = document.createElement('td'); tdE.textContent = String(c.sent_count); tdE.style.color = '#10b981';
        var tdK = document.createElement('td'); tdK.textContent = String(c.skipped_count); tdK.style.color = '#f59e0b';
        var tdF = document.createElement('td'); tdF.textContent = String(c.failed_count); tdF.style.color = '#ef4444';
        var tdC = document.createElement('td'); tdC.textContent = fmtTime(c.created_at);
        var tdA = document.createElement('td'); tdA.style.whiteSpace = 'nowrap';
        function mkBtn(text, cls, fn, disabled) {
          var b = document.createElement('button'); b.className = 'btn ' + cls + ' btn-sm'; b.textContent = text;
          if (disabled) b.disabled = true;
          b.addEventListener('click', fn);
          return b;
        }
        var activeStates = ['RUNNING', 'PAUSED', 'PAUSED_OFF_HOURS', 'PAUSED_COOLDOWN', 'DRAFT'];
        var isTerminal = !activeStates.includes(c.status);
        tdA.appendChild(mkBtn('👁 Ver', 'btn-secondary', function () { showCampaignCreator(c.id); }));
        tdA.appendChild(mkBtn('⏸', 'btn-warning', function () {
          api('/api/campaigns/' + encodeURIComponent(c.id) + '/pause', { method: 'POST' })
            .then(function () { toast('Campaña pausada'); loadCampaignsList(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo pausar (estado incompatible)', 'err'); });
        }, !activeStates.includes(c.status)));
        tdA.appendChild(mkBtn('▶️', 'btn-accent', function () {
          api('/api/campaigns/' + encodeURIComponent(c.id) + '/resume', { method: 'POST' })
            .then(function () { toast('Campaña reanudada'); loadCampaignsList(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo reanudar (estado incompatible)', 'err'); });
        }, c.status !== 'PAUSED' && c.status !== 'PAUSED_OFF_HOURS' && c.status !== 'PAUSED_COOLDOWN'));
        tdA.appendChild(mkBtn('🔁', 'btn-secondary', function () {
          api('/api/campaigns/' + encodeURIComponent(c.id) + '/retry-failed', { method: 'POST' })
            .then(function (r2) { toast(r2.data.requeued + ' envíos fallidos reencolados'); loadCampaignsList(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo reencolar', 'err'); });
        }, c.failed_count === 0));
        tdA.appendChild(mkBtn('🗑', 'btn-danger', function () {
          openModal('<h3>¿Borrar campaña?</h3><p style="font-size:12px;color:var(--text-muted)">Solo se borran campañas terminales (COMPLETED/CANCELLED/FAILED) junto con sus ítems.</p>' +
            '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-danger" id="mOk">Borrar</button></div>');
          document.getElementById('mCancel').addEventListener('click', closeModal);
          document.getElementById('mOk').addEventListener('click', function () {
            api('/api/campaigns/' + encodeURIComponent(c.id), { method: 'DELETE' })
              .then(function () { closeModal(); toast('Campaña borrada'); loadCampaignsList(); })
              .catch(function (e) {
                if (String(e.message) !== 'SESSION_EXPIRED') {
                  closeModal();
                  e.status === 409 ? toast('Solo se borran campañas terminales', 'err') : toast('No se pudo borrar', 'err');
                }
              });
          });
        }, !isTerminal));
        tr.appendChild(tdN); tr.appendChild(tdS); tr.appendChild(tdT); tr.appendChild(tdE); tr.appendChild(tdK); tr.appendChild(tdF); tr.appendChild(tdC); tr.appendChild(tdA);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; wrap.innerHTML = '<div class="state-box">Error cargando campañas.</div>'; } });
  }

  function showCampaignCreator(campaignId) {
    var creatorWrap = document.getElementById('creatorWrap');
    if (!creatorWrap) return;
    creatorWrap.style.display = 'grid';
    if (creatorWrap.getAttribute('data-built') === '1') {
      if (campaignId) startMonitoring(campaignId);
      creatorWrap.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    creatorWrap.setAttribute('data-built', '1');
    // ===== Panel izquierdo: creador EXISTENTE (mismo markup del studio) =====
    var left = document.createElement('div');
    left.className = 'left-panel';
    left.style.cssText = 'max-width:none; border-right:none; padding:0;';
    left.innerHTML =
      '<div class="card">' +
        '<div class="card-title"><span>Configurar Campaña Masiva</span><span style="font-size:11px; color:#10b981; font-weight:normal;">🛡️ Escudo Anti-Ban Activo</span></div>' +
        '<div class="form-group"><label>Nombre de la Campaña</label><input id="cmpName" placeholder="Ej. Lanzamiento Black Friday - Segmento VIP"></div>' +
        '<div style="background:#132338; border:1px solid #1e40af; border-radius:8px; padding:12px; margin-bottom:14px;">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><strong style="color:#60a5fa; font-size:12px;">🧠 Copiloto de Neuromarketing & Ventas IA (360°)</strong><span style="font-size:10px; background:#1e3a8a; color:#93c5fd; padding:2px 6px; border-radius:4px;">Hofstede + Zaltman + Rapaille</span></div>' +
          '<div style="display:flex; gap:8px; margin-bottom:6px;"><select id="neuroCountry" style="flex:1; font-size:11px; padding:6px;">' +
            '<option value="COLOMBIA">🇨🇴 Colombia (Colectivismo + Confianza)</option>' +
            '<option value="MEXICO">🇲🇽 México (Estatus + Respaldo)</option>' +
            '<option value="ARGENTINA">🇦🇷 Argentina (ROI Concreto + Crítico)</option>' +
            '<option value="CHILE">🇨🇱 Chile (Calidad + Estabilidad)</option>' +
            '<option value="ESPANA">🇪🇸 España (Claridad + Profesionalismo)</option>' +
          '</select></div>' +
          '<div style="display:flex; gap:8px; margin-bottom:6px;"><input id="neuroBenefit" style="flex:1; font-size:11px; padding:6px;" placeholder="Beneficio Principal" value="cerrar 3x más ventas sin contratar más personal"><input id="neuroPain" style="flex:1; font-size:11px; padding:6px;" placeholder="Dolor / Miedo" value="perder clientes por no responder de inmediato"></div>' +
          '<button class="btn btn-secondary" style="width:100%; font-size:11px; padding:6px;" onclick="generateNeuroSpintax()">⚡ Redactar Spintax Persuasivo con Neuromarketing</button>' +
        '</div>' +
        '<div class="form-group"><label>Plantilla con Spintax {A|B|C} y Variables {{nombre}}</label>' +
          '<textarea id="cmpTemplate" rows="4">{¡Hola|Buen día|Estimado/a} {{nombre}}! {Tenemos una novedad para ti|Queremos compartirte esta oportunidad exclusiva}: mira los detalles aquí: https://albra.co/oferta</textarea>' +
          '<button class="btn btn-secondary" style="margin-top:6px; font-size:11px; padding:4px 8px;" onclick="testSpintax()">🎲 Previsualizar 5 Variaciones Spintax</button></div>' +
        '<div class="form-group"><label>Variaciones Dinámicas Generadas (Preview):</label><div class="preview-box" id="spintaxPreview"></div></div>' +
        '<div class="form-group"><label>Audiencia CSV (Pegar líneas: teléfono,nombre) — o usa los contactos importados</label>' +
          '<textarea id="cmpCsv" rows="4" placeholder="phone,name&#10;573001234567,Carlos Perez"></textarea>' +
          '<div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">' +
            '<button class="btn btn-secondary" style="font-size:11px; padding:4px 8px;" onclick="previewCsv()">📋 Validar Formato y Normalizar</button>' +
            '<button class="btn btn-secondary" style="font-size:11px; padding:4px 8px;" onclick="fillCsvFromContacts()">👥 Usar contactos importados</button>' +
          '</div></div>' +
        '<div class="form-group" style="display:flex; gap:12px;">' +
          '<div style="flex:1;"><label>Ritmo Anti-Ban</label><select id="cmpSpeed"><option value="safe">🛡️ Modo Seguro (20s - 45s + Enfriamiento)</option><option value="balanced">⚡ Modo Equilibrado (15s - 30s)</option></select></div>' +
          '<div style="flex:1;"><label>Bloque de Enfriamiento</label><select id="cmpCooldown"><option value="25">Pausa cada 25 envíos (8 min)</option><option value="50">Pausa cada 50 envíos (12 min)</option></select></div>' +
        '</div>' +
        '<button class="btn btn-accent" style="width:100%; padding:12px; font-size:14px;" onclick="createAndStartCampaign()">🚀 Crear y Encolar Campaña</button>' +
      '</div>';
    // ===== Panel derecho: monitor EXISTENTE =====
    var right = document.createElement('div');
    right.className = 'right-panel';
    right.style.cssText = 'padding:0; background:transparent;';
    right.innerHTML =
      '<div class="card">' +
        '<div class="card-title"><span>Monitor de Despacho en Caliente</span><div style="display:flex; gap:6px;">' +
          '<button class="btn btn-warning btn-sm" onclick="pauseCampaign()">⏸️ Pausar</button>' +
          '<button class="btn btn-accent btn-sm" onclick="resumeCampaign()">▶️ Reanudar</button>' +
          '<button class="btn btn-danger btn-sm" onclick="cancelCampaign()">⏹️ Cancelar</button>' +
        '</div></div>' +
        '<div class="metrics-grid">' +
          '<div class="metric-card"><div class="metric-label">Destinatarios</div><div class="metric-num" id="mTotal">0</div></div>' +
          '<div class="metric-card"><div class="metric-label">Enviados</div><div class="metric-num" id="mSent" style="color:#10b981;">0</div></div>' +
          '<div class="metric-card"><div class="metric-label">Omitidos (Locks)</div><div class="metric-num" id="mSkipped" style="color:#f59e0b;">0</div></div>' +
          '<div class="metric-card"><div class="metric-label">Errores</div><div class="metric-num" id="mFailed" style="color:#ef4444;">0</div></div>' +
        '</div>' +
        '<div class="progress-bar-bg"><div class="progress-bar-fill" id="progressBar"></div></div>' +
        '<div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted);"><span id="cmpStatus">Estado: EN ESPERA</span><span id="cmpProgressText">0% completado</span></div>' +
        '<div style="margin-top:8px;"><a href="#" id="attrLink" style="font-size:11px; color:#3b82f6; display:none;">📈 Ver reporte de atribución y clics</a></div>' +
      '</div>' +
      '<div class="card" style="margin-top:16px;">' +
        '<div class="card-title"><span>Registro en Tiempo Real de Envíos</span><button class="btn btn-secondary btn-sm" onclick="refreshCurrentCampaign()">Refrescar</button></div>' +
        '<div style="overflow-y:auto; max-height:320px; border:1px solid #1e293b; border-radius:6px;">' +
          '<table class="log-table"><thead><tr><th>Teléfono</th><th>Nombre</th><th>Mensaje Renderizado (Spintax)</th><th>Estado</th></tr></thead>' +
          '<tbody id="logTbody"><tr><td colspan="4" style="text-align:center; color:#64748b; padding:24px;">No hay despachos activos en este momento.</td></tr></tbody></table>' +
        '</div>' +
      '</div>';
    creatorWrap.appendChild(left);
    creatorWrap.appendChild(right);
    testSpintax();
    if (campaignId) startMonitoring(campaignId);
    creatorWrap.scrollIntoView({ behavior: 'smooth' });
  }

  function fillCsvFromContacts() {
    api('/api/contacts?limit=200').then(function (r) {
      var contacts = r.data.contacts || [];
      if (contacts.length === 0) { toast('No hay contactos importados. Usa la pantalla Contactos.', 'info'); return; }
      var lines = ['phone,name'];
      contacts.forEach(function (c) { lines.push(c.phone + ',' + (c.name || '')); });
      document.getElementById('cmpCsv').value = lines.join('\\n');
      toast(contacts.length + ' contactos cargados en la audiencia');
      previewCsv();
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando contactos', 'err'); });
  }

  // Funciones del creador/monitor EXISTENTES (mismos nombres que campaign-studio-html.ts)
  async function generateNeuroSpintax() {
    var productName = document.getElementById('cmpName').value || 'Nuestra Solución';
    var country = document.getElementById('neuroCountry').value;
    var benefit = document.getElementById('neuroBenefit').value;
    var pain = document.getElementById('neuroPain').value;
    try {
      var res = await api('/api/ai/neuromarketing/generate-spintax', { method: 'POST', body: JSON.stringify({ productName: productName, country: country, mainBenefit: benefit, painPoint: pain }) });
      if (res.data.spintaxTemplate) {
        document.getElementById('cmpTemplate').value = res.data.spintaxTemplate;
        testSpintax();
      }
    } catch (e) {
      if (String(e.message) !== 'SESSION_EXPIRED') toast('Error al generar Spintax: ' + e.message, 'err');
    }
  }
  async function testSpintax() {
    var templateEl = document.getElementById('cmpTemplate');
    if (!templateEl) return;
    var template = templateEl.value;
    var box = document.getElementById('spintaxPreview');
    box.textContent = '';
    for (var i = 1; i <= 5; i++) {
      try {
        var res = await api('/api/spintax/preview', { method: 'POST', body: JSON.stringify({ template: template, name: 'Juan Pérez' }) });
        var div = document.createElement('div');
        div.className = 'preview-item';
        div.textContent = i + '. ' + res.data.rendered;
        box.appendChild(div);
      } catch (e) {
        if (String(e.message) !== 'SESSION_EXPIRED') box.textContent = 'Error generando preview: ' + e.message;
      }
    }
  }
  async function previewCsv() {
    var csv = document.getElementById('cmpCsv').value;
    try {
      var res = await api('/api/audiences/preview-csv', { method: 'POST', body: JSON.stringify({ csvContent: csv }) });
      var d = res.data;
      toast('Audiencia: ' + d.validCount + ' válidos · ' + d.invalidCount + ' inválidos · ' + d.duplicatesCount + ' duplicados', 'info');
    } catch (e) {
      if (String(e.message) !== 'SESSION_EXPIRED') toast('Error en validación: ' + e.message, 'err');
    }
  }
  async function createAndStartCampaign() {
    var name = document.getElementById('cmpName').value.trim();
    var template = document.getElementById('cmpTemplate').value;
    var csv = document.getElementById('cmpCsv').value;
    if (!name) { toast('Ponle un nombre a la campaña', 'err'); return; }
    if (!csv.trim()) { toast('Pega una audiencia CSV o usa «Usar contactos importados»', 'err'); return; }
    try {
      var res = await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: name, templateSpintax: template, csvContent: csv }) });
      var campaign = res.data;
      toast('✅ Campaña encolada (' + campaign.totalTargets + ' destinatarios)');
      loadCampaignsList();
      startMonitoring(campaign.id);
    } catch (e) {
      if (String(e.message) !== 'SESSION_EXPIRED') toast('Error creando campaña: revisa plantilla y CSV', 'err');
    }
  }
  function startMonitoring(campaignId) {
    window.activeCampaignId = campaignId;
    if (window.pollInterval) clearInterval(window.pollInterval);
    refreshCurrentCampaign();
    window.pollInterval = setInterval(refreshCurrentCampaign, 2000);
    var link = document.getElementById('attrLink');
    if (link) {
      link.style.display = 'inline';
      link.setAttribute('href', '/api/attribution/report/' + encodeURIComponent(campaignId));
    }
  }
  async function refreshCurrentCampaign() {
    if (!window.activeCampaignId) return;
    try {
      var res = await api('/api/campaigns/' + encodeURIComponent(window.activeCampaignId));
      var cmp = res.data.campaign;
      var items = res.data.items || [];
      document.getElementById('mTotal').textContent = cmp.total_targets;
      document.getElementById('mSent').textContent = cmp.sent_count;
      document.getElementById('mSkipped').textContent = cmp.skipped_count;
      document.getElementById('mFailed').textContent = cmp.failed_count;
      var total = cmp.total_targets || 1;
      var done = (cmp.sent_count + cmp.skipped_count + cmp.failed_count);
      var pct = Math.min(100, Math.round((done / total) * 100));
      document.getElementById('progressBar').style.width = pct + '%';
      document.getElementById('cmpProgressText').textContent = pct + '% completado';
      document.getElementById('cmpStatus').textContent = 'Estado: ' + cmp.status;
      var tbody = document.getElementById('logTbody');
      tbody.textContent = '';
      if (items.length === 0) {
        var er = document.createElement('tr'); var ed = document.createElement('td'); ed.colSpan = 4;
        ed.className = 'state-box'; ed.textContent = 'Sin envíos registrados todavía.';
        er.appendChild(ed); tbody.appendChild(er);
        return;
      }
      items.slice(0, 30).forEach(function (it) {
        var tr = document.createElement('tr');
        var badgeClass = it.status === 'SENT' ? 'badge-sent' : (it.status === 'PENDING' ? 'badge-pending' : (it.status.indexOf('EXCLUDED') >= 0 || it.status === 'SUPPRESSED' ? 'badge-skipped' : 'badge-failed'));
        var td1 = document.createElement('td'); td1.style.fontWeight = '600'; td1.textContent = '+' + (it.contact_phone || '');
        var td2 = document.createElement('td'); td2.textContent = it.contact_name || '-';
        var td3 = document.createElement('td'); td3.style.cssText = 'color:#cbd5e1; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'; td3.textContent = it.rendered_text || '-';
        var td4 = document.createElement('td');
        var span = document.createElement('span'); span.className = 'badge-status ' + badgeClass; span.textContent = it.status;
        td4.appendChild(span);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        tbody.appendChild(tr);
      });
    } catch (e) { /* el monitor tolera fallos transitorios de polling */ }
  }
  async function pauseCampaign() { if (!window.activeCampaignId) return; await api('/api/campaigns/' + window.activeCampaignId + '/pause', { method: 'POST' }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo pausar', 'err'); }); refreshCurrentCampaign(); }
  async function resumeCampaign() { if (!window.activeCampaignId) return; await api('/api/campaigns/' + window.activeCampaignId + '/resume', { method: 'POST' }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo reanudar', 'err'); }); refreshCurrentCampaign(); }
  async function cancelCampaign() { if (!window.activeCampaignId) return; await api('/api/campaigns/' + window.activeCampaignId + '/cancel', { method: 'POST' }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo cancelar', 'err'); }); refreshCurrentCampaign(); }

  // ============================================================
  // VISTA: Respuestas rápidas
  // ============================================================
  function viewQuickReplies() {
    setTitle('Respuestas rápidas');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:12px;';
    var bNew = document.createElement('button'); bNew.className = 'btn btn-accent btn-sm'; bNew.textContent = '＋ Nueva respuesta';
    bNew.addEventListener('click', function () { openQuickReplyModal(null); });
    bar.appendChild(bNew);
    root.appendChild(bar);
    var wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.id = 'qrWrap';
    wrap.innerHTML = '<div class="skeleton" style="margin:12px; width:50%"></div>';
    root.appendChild(wrap);
    loadQuickReplies();
  }
  function loadQuickReplies() {
    var wrap = document.getElementById('qrWrap');
    if (!wrap) return;
    api('/api/quick-replies').then(function (r) {
      var list = r.data.quickReplies || [];
      wrap.textContent = '';
      if (list.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = 'Sin respuestas rápidas. Crea atajos como /precio para insertarlos en el chat.';
        wrap.appendChild(empty);
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead'); var hr = document.createElement('tr');
      ['Atajo', 'Título', 'Cuerpo', 'Acciones'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      list.forEach(function (q) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.style.fontWeight = '700'; td1.textContent = '/' + q.shortcut;
        var td2 = document.createElement('td'); td2.textContent = q.title;
        var td3 = document.createElement('td'); td3.style.cssText = 'max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted);'; td3.textContent = q.body;
        var td4 = document.createElement('td'); td4.style.whiteSpace = 'nowrap';
        var bE = document.createElement('button'); bE.className = 'btn btn-secondary btn-sm'; bE.textContent = '✏️';
        bE.addEventListener('click', function () { openQuickReplyModal(q); });
        var bD = document.createElement('button'); bD.className = 'btn btn-danger btn-sm'; bD.style.marginLeft = '4px'; bD.textContent = '🗑';
        bD.addEventListener('click', function () {
          api('/api/quick-replies/' + encodeURIComponent(q.id), { method: 'DELETE' })
            .then(function () { toast('Respuesta borrada'); loadQuickReplies(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo borrar', 'err'); });
        });
        td4.appendChild(bE); td4.appendChild(bD);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; wrap.innerHTML = '<div class="state-box">Error cargando respuestas rápidas.</div>'; } });
  }
  function openQuickReplyModal(qr) {
    var isEdit = !!qr;
    openModal(
      '<h3>' + (isEdit ? 'Editar respuesta rápida' : 'Nueva respuesta rápida') + '</h3>' +
      '<div class="form-group"><label>Atajo (ej. precio)</label><input id="mShortcut" value="' + (isEdit ? esc(qr.shortcut) : '') + '"></div>' +
      '<div class="form-group"><label>Título</label><input id="mTitle" value="' + (isEdit ? esc(qr.title) : '') + '"></div>' +
      '<div class="form-group"><label>Cuerpo del mensaje</label><textarea id="mBody" rows="4">' + (isEdit ? esc(qr.body) : '') + '</textarea></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mSave">Guardar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mSave').addEventListener('click', function () {
      var payload = {
        shortcut: document.getElementById('mShortcut').value.trim(),
        title: document.getElementById('mTitle').value.trim(),
        body: document.getElementById('mBody').value.trim()
      };
      if (!payload.shortcut || !payload.title || !payload.body) { toast('Atajo, título y cuerpo son obligatorios', 'err'); return; }
      var req = isEdit
        ? api('/api/quick-replies/' + encodeURIComponent(qr.id), { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/quick-replies', { method: 'POST', body: JSON.stringify(payload) });
      req.then(function () { closeModal(); toast('Respuesta rápida guardada'); loadQuickReplies(); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'No se pudo guardar (¿atajo duplicado?)';
          toast(msg, 'err');
        });
    });
  }

  // ============================================================
  // VISTA: Etiquetas
  // ============================================================
  function viewTags() {
    setTitle('Etiquetas');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:12px;';
    var bNew = document.createElement('button'); bNew.className = 'btn btn-accent btn-sm'; bNew.textContent = '＋ Nueva etiqueta';
    bNew.addEventListener('click', function () { openTagModal(null); });
    bar.appendChild(bNew);
    root.appendChild(bar);
    var wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.id = 'tagsWrap';
    wrap.innerHTML = '<div class="skeleton" style="margin:12px; width:50%"></div>';
    root.appendChild(wrap);
    loadTags();
  }
  function loadTags() {
    var wrap = document.getElementById('tagsWrap');
    if (!wrap) return;
    api('/api/tags').then(function (r) {
      var list = r.data.tags || [];
      wrap.textContent = '';
      if (list.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = 'Sin etiquetas. Úsalas para segmentar contactos y campañas.';
        wrap.appendChild(empty);
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead'); var hr = document.createElement('tr');
      ['Nombre', 'Color', 'Contactos', 'Acciones'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      list.forEach(function (t) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.style.fontWeight = '700'; td1.textContent = t.name;
        var td2 = document.createElement('td');
        var dot = document.createElement('span'); dot.style.cssText = 'display:inline-block; width:14px; height:14px; border-radius:4px; background:' + (t.color || '#334155') + ';';
        td2.appendChild(dot);
        var td3 = document.createElement('td'); td3.textContent = String(t.contactCount);
        var td4 = document.createElement('td'); td4.style.whiteSpace = 'nowrap';
        var bE = document.createElement('button'); bE.className = 'btn btn-secondary btn-sm'; bE.textContent = '✏️';
        bE.addEventListener('click', function () { openTagModal(t); });
        var bD = document.createElement('button'); bD.className = 'btn btn-danger btn-sm'; bD.style.marginLeft = '4px'; bD.textContent = '🗑';
        bD.addEventListener('click', function () {
          api('/api/tags/' + encodeURIComponent(t.id), { method: 'DELETE' })
            .then(function () { toast('Etiqueta borrada y desasignada'); loadTags(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo borrar', 'err'); });
        });
        td4.appendChild(bE); td4.appendChild(bD);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; wrap.innerHTML = '<div class="state-box">Error cargando etiquetas.</div>'; } });
  }
  function openTagModal(tag) {
    var isEdit = !!tag;
    openModal(
      '<h3>' + (isEdit ? 'Editar etiqueta' : 'Nueva etiqueta') + '</h3>' +
      '<div class="form-group"><label>Nombre</label><input id="mTagName" value="' + (isEdit ? esc(tag.name) : '') + '"></div>' +
      '<div class="form-group"><label>Color</label><input type="color" id="mTagColor" value="' + (isEdit && tag.color ? esc(tag.color) : '#3b82f6') + '" style="height:38px; padding:4px;"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mSave">Guardar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mSave').addEventListener('click', function () {
      var name = document.getElementById('mTagName').value.trim();
      var color = document.getElementById('mTagColor').value;
      if (!name) { toast('El nombre es obligatorio', 'err'); return; }
      var req = isEdit
        ? api('/api/tags/' + encodeURIComponent(tag.id), { method: 'PUT', body: JSON.stringify({ name: name, color: color }) })
        : api('/api/tags', { method: 'POST', body: JSON.stringify({ name: name, color: color }) });
      req.then(function () { closeModal(); toast('Etiqueta guardada'); loadTags(); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'No se pudo guardar (¿nombre duplicado?)';
          toast(msg, 'err');
        });
    });
  }

  // ============================================================
  // VISTA: Agentes
  // ============================================================
  function viewAgents() {
    setTitle('Agentes');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:12px;';
    var bNew = document.createElement('button'); bNew.className = 'btn btn-accent btn-sm'; bNew.textContent = '＋ Nuevo agente';
    bNew.addEventListener('click', function () { openAgentModal(null); });
    bar.appendChild(bNew);
    root.appendChild(bar);
    var wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.id = 'agentsWrap';
    wrap.innerHTML = '<div class="skeleton" style="margin:12px; width:50%"></div>';
    root.appendChild(wrap);
    loadAgents();
  }
  function loadAgents() {
    var wrap = document.getElementById('agentsWrap');
    if (!wrap) return;
    api('/api/agents').then(function (r) {
      var list = r.data.agents || [];
      wrap.textContent = '';
      if (list.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = 'Sin agentes. Añade a tu equipo para asignar conversaciones.';
        wrap.appendChild(empty);
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead'); var hr = document.createElement('tr');
      ['Nombre', 'Email', 'Rol', 'Activo', 'Conversaciones', 'Acciones'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      list.forEach(function (a) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.style.fontWeight = '700'; td1.textContent = a.name;
        var td2 = document.createElement('td'); td2.textContent = a.email || '-';
        var td3 = document.createElement('td');
        var sp = document.createElement('span'); sp.className = 'badge-status ' + (a.role === 'admin' ? 'badge-pending' : 'badge-neutral'); sp.textContent = a.role;
        td3.appendChild(sp);
        var td4 = document.createElement('td');
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!a.active; chk.style.width = 'auto';
        chk.addEventListener('change', function () {
          api('/api/agents/' + encodeURIComponent(a.id), { method: 'PUT', body: JSON.stringify({ active: chk.checked }) })
            .then(function () { toast('Estado actualizado'); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo actualizar', 'err'); });
        });
        td4.appendChild(chk);
        var td5 = document.createElement('td'); td5.textContent = String(a.assignedConversations);
        var td6 = document.createElement('td'); td6.style.whiteSpace = 'nowrap';
        var bE = document.createElement('button'); bE.className = 'btn btn-secondary btn-sm'; bE.textContent = '✏️';
        bE.addEventListener('click', function () { openAgentModal(a); });
        var bD = document.createElement('button'); bD.className = 'btn btn-danger btn-sm'; bD.style.marginLeft = '4px'; bD.textContent = '🗑';
        bD.addEventListener('click', function () {
          api('/api/agents/' + encodeURIComponent(a.id), { method: 'DELETE' })
            .then(function () { toast('Agente borrado (conversaciones desasignadas)'); loadAgents(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo borrar', 'err'); });
        });
        td6.appendChild(bE); td6.appendChild(bD);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4); tr.appendChild(td5); tr.appendChild(td6);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; wrap.innerHTML = '<div class="state-box">Error cargando agentes.</div>'; } });
  }
  function openAgentModal(agent) {
    var isEdit = !!agent;
    openModal(
      '<h3>' + (isEdit ? 'Editar agente' : 'Nuevo agente') + '</h3>' +
      '<div class="form-group"><label>Nombre</label><input id="mAgentName" value="' + (isEdit ? esc(agent.name) : '') + '"></div>' +
      '<div class="form-group"><label>Email</label><input id="mAgentEmail" value="' + (isEdit ? esc(agent.email || '') : '') + '"></div>' +
      '<div class="form-group"><label>Rol</label><select id="mAgentRole"><option value="agente"' + (isEdit && agent.role === 'agente' ? ' selected' : '') + '>Agente</option><option value="admin"' + (isEdit && agent.role === 'admin' ? ' selected' : '') + '>Admin</option></select></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-accent" id="mSave">Guardar</button></div>'
    );
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mSave').addEventListener('click', function () {
      var payload = {
        name: document.getElementById('mAgentName').value.trim(),
        email: document.getElementById('mAgentEmail').value.trim(),
        role: document.getElementById('mAgentRole').value
      };
      if (!payload.name) { toast('El nombre es obligatorio', 'err'); return; }
      var req = isEdit
        ? api('/api/agents/' + encodeURIComponent(agent.id), { method: 'PUT', body: JSON.stringify(payload) })
        : api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
      req.then(function () { closeModal(); toast('Agente guardado'); loadAgents(); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'No se pudo guardar';
          toast(msg, 'err');
        });
    });
  }

  // ============================================================
  // VISTA: Integraciones
  // ============================================================
  function viewIntegrations() {
    setTitle('Integraciones WhatsApp / API');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<div class="card-title"><span>Transporte de salida</span></div>' +
      '<div class="form-group"><label>Motor</label><select id="tEngine"><option value="daemon">Daemon WhatsApp del CRM (Baileys, localhost:3002)</option><option value="meta_cloud">Meta WhatsApp Cloud API (por organización)</option></select></div>' +
      '<div id="baileysRiskWarning" style="display:flex;gap:8px;align-items:flex-start;margin:8px 0 14px;padding:10px 12px;border:1px solid #f0b429;background:rgba(240,180,41,0.12);border-radius:8px;">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<p style="font-size:12px;color:var(--text);margin:0;">' +
          '<strong>Aviso Importante:</strong> el canal Baileys es un canal <strong>NO oficial</strong> de WhatsApp. Su uso conlleva riesgo inherente de bloqueo o suspensión del número por parte de Meta. Se recomienda calentar líneas (envíos graduales con pacing) y usar números secundarios, nunca el número principal del negocio.' +
        '</p>' +
      '</div>' +
      '<div id="daemonFields">' +
        '<div class="form-group"><label>URL del daemon (ej. http://localhost:3002)</label><input id="tDaemonUrl" placeholder="http://localhost:3002"></div>' +
        '<div class="form-group"><label>Nuevo secreto del daemon (OPCIONAL — solo se guarda la máscara de los últimos 4; el real vive en INTERNAL_API_SECRET del entorno)</label><input id="tDaemonSecret" type="password" placeholder="sin cambios"></div>' +
      '</div>' +
      '<div id="metaFields" style="display:none;">' +
        '<div class="form-group"><label>Phone Number ID de Meta</label><input id="tMetaPhone" placeholder="1234567890"></div>' +
        '<p style="font-size:11px;color:var(--text-muted);">El token de Meta NO se guarda: se usa solo al pulsar «Probar conexión» (máscara almacenada si lo escribes al guardar).</p>' +
      '</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
        '<button class="btn btn-accent" id="tSave">Guardar configuración</button>' +
        '<button class="btn btn-secondary" id="tTest">🔌 Probar conexión (real)</button>' +
        '<input id="tTestToken" type="password" placeholder="token Meta (solo para probar)" style="max-width:220px; display:none;">' +
      '</div>' +
      '<div id="tResult" style="margin-top:12px; font-size:12px; color:var(--text-muted);"></div>';
    var card2 = document.createElement('div'); card2.className = 'card'; card2.style.marginTop = '16px';
    card2.innerHTML = '<div class="card-title"><span>Webhook de mensajes entrantes (HMAC v2)</span></div>' +
      '<p style="font-size:12px; color:var(--text-muted); line-height:1.6;">URL pública: <code>POST /api/audiences/webhook-message</code><br>' +
      'Cabeceras: <code>X-Org-Id</code>, <code>X-Timestamp</code> (epoch ms, ±5 min), <code>X-Signature-SHA256</code> = hex(HMAC-SHA256(secreto_de_la_org, orgId + "." + timestamp + "." + body)).<br>' +
      'Cuerpo: <code>{ "eventId", "phone", "name?", "text", "messageId?", "campaignId?" }</code>. Secreto: misma variable <code>WEBHOOK_LEAD_SECRETS</code> del ingesta de leads (rotación con «actual|previo»). Rate limit 30/min y anti-replay durable compartidos con la ingesta de leads.</p>';
    root.appendChild(card);
    root.appendChild(card2);
    api('/api/integrations/transport').then(function (r) {
      var cfg = r.data;
      document.getElementById('tEngine').value = cfg.engine;
      document.getElementById('tDaemonUrl').value = cfg.daemonUrl || '';
      document.getElementById('tMetaPhone').value = cfg.metaPhoneNumberId || '';
      toggleTransportFields();
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando configuración', 'err'); });
    document.getElementById('tEngine').addEventListener('change', toggleTransportFields);
    function toggleTransportFields() {
      var engine = document.getElementById('tEngine').value;
      document.getElementById('daemonFields').style.display = engine === 'daemon' ? 'block' : 'none';
      document.getElementById('metaFields').style.display = engine === 'meta_cloud' ? 'block' : 'none';
      document.getElementById('tTestToken').style.display = engine === 'meta_cloud' ? 'inline-block' : 'none';
    }
    document.getElementById('tSave').addEventListener('click', function () {
      var engine = document.getElementById('tEngine').value;
      var payload = { engine: engine };
      if (engine === 'daemon') {
        payload.daemonUrl = document.getElementById('tDaemonUrl').value.trim() || null;
        var ds = document.getElementById('tDaemonSecret').value;
        if (ds) payload.daemonSecret = ds;
      } else {
        payload.metaPhoneNumberId = document.getElementById('tMetaPhone').value.trim() || null;
        var tk = document.getElementById('tTestToken').value;
        if (tk) payload.metaToken = tk;
      }
      api('/api/integrations/transport', { method: 'PUT', body: JSON.stringify(payload) })
        .then(function () { toast('Configuración guardada'); renderTransportStatus(); viewIntegrations(); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'No se pudo guardar';
          toast(msg, 'err');
        });
    });
    document.getElementById('tTest').addEventListener('click', function () {
      var resultEl = document.getElementById('tResult');
      resultEl.textContent = 'Probando conexión real…';
      var engine = document.getElementById('tEngine').value;
      var payload = { engine: engine };
      if (engine === 'daemon') payload.daemonUrl = document.getElementById('tDaemonUrl').value.trim();
      else payload.metaPhoneNumberId = document.getElementById('tMetaPhone').value.trim(), payload.token = document.getElementById('tTestToken').value;
      api('/api/integrations/transport/test', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (r) {
          var d = r.data;
          if (d.ok) resultEl.innerHTML = '✅ Conexión OK — HTTP ' + d.status + ' en ' + d.latencyMs + ' ms (' + d.target + ')';
          else resultEl.innerHTML = '❌ Falló: HTTP ' + (d.status != null ? d.status : '—') + (d.error ? ' · ' + esc(d.error) : '');
        })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'Error de red';
          resultEl.textContent = '❌ ' + msg;
        });
    });
  }

  // ============================================================
  // VISTA: Ajustes
  // ============================================================
  function viewSettings() {
    setTitle('Ajustes');
    var root = document.getElementById('viewRoot');
    root.textContent = '';
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<div class="card-title"><span>Perfil y ritmo por defecto</span></div>' +
      '<div class="form-group"><label>Marca / negocio</label><input id="sBrand" placeholder="Mi negocio"></div>' +
      '<div class="form-group"><label>País</label><select id="sCountry"><option value="">—</option><option value="CO">Colombia</option><option value="MX">México</option><option value="AR">Argentina</option><option value="CL">Chile</option><option value="ES">España</option></select></div>' +
      '<div class="form-group" style="display:flex; gap:12px;">' +
        '<div style="flex:1;"><label>Delay mínimo (seg)</label><input id="sPaceMin" type="number" min="5" max="600"></div>' +
        '<div style="flex:1;"><label>Delay máximo (seg)</label><input id="sPaceMax" type="number" min="5" max="600"></div>' +
        '<div style="flex:1;"><label>Lote de enfriamiento</label><input id="sCooldown" type="number" min="5" max="200"></div>' +
      '</div>' +
      '<button class="btn btn-accent" id="sSave">Guardar ajustes</button>';
    var card2 = document.createElement('div'); card2.className = 'card'; card2.style.marginTop = '16px';
    card2.innerHTML = '<div class="card-title"><span>Lista de supresión (bajas / opt-out)</span><button class="btn btn-secondary btn-sm" id="sAddSup">＋ Añadir</button></div>' +
      '<div class="table-wrap" id="supWrap"><div class="skeleton" style="margin:12px; width:50%"></div></div>';
    root.appendChild(card);
    root.appendChild(card2);
    // F10: estado y caducidad de la sesion.
    var card3 = document.createElement('div'); card3.className = 'card'; card3.style.marginTop = '16px';
    card3.innerHTML = '<div class="card-title"><span>Sesión</span></div>' +
      '<p id="sSessionInfo" style="font-size:12px;color:var(--text-muted);">Comprobando sesión…</p>' +
      '<div class="modal-actions" style="justify-content:flex-start;"><button class="btn btn-secondary btn-sm" id="sSessionRefresh">Actualizar</button><button class="btn btn-ghost btn-sm" id="sSessionLogout">Cerrar sesión</button></div>';
    root.appendChild(card3);
    function renderSession() {
      var el = document.getElementById('sSessionInfo');
      if (!el) return;
      api('/api/session').then(function (r) {
        var s = r.data;
        if (!s.expiresAt) { el.textContent = 'Sesión activa (no se pudo leer la caducidad de la cookie).'; return; }
        var left = Math.max(0, Math.round((s.expiresAt - s.now) / 60000));
        el.textContent = 'Sesión activa · caduca a las ' + new Date(s.expiresAt).toLocaleTimeString('es') + ' (quedan ' + left + ' de ' + Math.round(s.ttlSeconds / 60) + ' min). Al caducar, la próxima petición te devuelve a /login?expired=1.';
      }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') el.textContent = 'No se pudo leer el estado de la sesión.'; });
    }
    renderSession();
    document.getElementById('sSessionRefresh').addEventListener('click', renderSession);
    document.getElementById('sSessionLogout').addEventListener('click', function () { doLogout(); });
    api('/api/settings').then(function (r) {
      var s = r.data;
      document.getElementById('sBrand').value = s.brandName || '';
      document.getElementById('sCountry').value = s.country || '';
      document.getElementById('sPaceMin').value = s.pacingMinSeconds || 20;
      document.getElementById('sPaceMax').value = s.pacingMaxSeconds || 45;
      document.getElementById('sCooldown').value = s.cooldownBatchSize || 25;
      if (!s.onboardingCompletedAt) showOnboarding();
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Error cargando ajustes', 'err'); });
    document.getElementById('sSave').addEventListener('click', function () {
      var payload = {
        brandName: document.getElementById('sBrand').value.trim(),
        country: document.getElementById('sCountry').value,
        pacingMinSeconds: parseInt(document.getElementById('sPaceMin').value, 10),
        pacingMaxSeconds: parseInt(document.getElementById('sPaceMax').value, 10),
        cooldownBatchSize: parseInt(document.getElementById('sCooldown').value, 10)
      };
      api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
        .then(function () { toast('Ajustes guardados'); })
        .catch(function (e) {
          if (String(e.message) === 'SESSION_EXPIRED') return;
          var msg = (e && e.data && e.data.error) ? e.data.error : 'No se pudo guardar';
          toast(msg, 'err');
        });
    });
    loadSuppression();
    document.getElementById('sAddSup').addEventListener('click', function () {
      openModal('<h3>Añadir a lista de supresión</h3>' +
        '<div class="form-group"><label>Teléfono E.164</label><input id="mSupPhone" placeholder="573001234567"></div>' +
        '<div class="form-group"><label>Motivo</label><input id="mSupReason" value="opt_out"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancelar</button><button class="btn btn-danger" id="mOk">Suprimir</button></div>');
      document.getElementById('mCancel').addEventListener('click', closeModal);
      document.getElementById('mOk').addEventListener('click', function () {
        var phone = document.getElementById('mSupPhone').value.trim();
        var reason = document.getElementById('mSupReason').value.trim() || 'opt_out';
        api('/api/suppression', { method: 'POST', body: JSON.stringify({ phone: phone, reason: reason }) })
          .then(function () { closeModal(); toast('Contacto suprimido (no recibirá envíos)'); loadSuppression(); })
          .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('Teléfono inválido', 'err'); });
      });
    });
  }
  function loadSuppression() {
    var wrap = document.getElementById('supWrap');
    if (!wrap) return;
    api('/api/suppression').then(function (r) {
      var list = r.data.suppression || [];
      wrap.textContent = '';
      if (list.length === 0) {
        var empty = document.createElement('div'); empty.className = 'state-box';
        empty.textContent = 'Nadie está suprimido. Los opt-out («BAJA»/«STOP») y bajas del circuito aparecen aquí.';
        wrap.appendChild(empty);
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead'); var hr = document.createElement('tr');
      ['Teléfono', 'Motivo', 'Desde', 'Acciones'].forEach(function (h) { var th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      list.forEach(function (s) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.style.fontWeight = '700'; td1.textContent = '+' + s.phone;
        var td2 = document.createElement('td'); td2.textContent = s.reason;
        var td3 = document.createElement('td'); td3.textContent = fmtTime(s.createdAt);
        var td4 = document.createElement('td');
        var bD = document.createElement('button'); bD.className = 'btn btn-secondary btn-sm'; bD.textContent = 'Quitar';
        bD.addEventListener('click', function () {
          api('/api/suppression/' + encodeURIComponent(s.phone), { method: 'DELETE' })
            .then(function () { toast('Supresión retirada'); loadSuppression(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo retirar', 'err'); });
        });
        td4.appendChild(bD);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }).catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') { wrap.textContent = ''; wrap.innerHTML = '<div class="state-box">Error cargando supresión.</div>'; } });
  }

  // ============================================================
  // Onboarding (primera vez)
  // ============================================================
  function showOnboarding() {
    var step = 1;
    function draw() {
      openModal(
        '<h3>Bienvenido a WhatsPower-Ultra</h3>' +
        '<div class="onb-steps"><div class="onb-step' + (step > 1 ? ' done' : '') + '"></div><div class="onb-step' + (step > 2 ? ' done' : '') + '"></div><div class="onb-step' + (step > 3 ? ' done' : '') + '"></div></div>' +
        (step === 1
          ? '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Paso 1 de 3 — Perfil del negocio</p>' +
            '<div class="form-group"><label>Marca / negocio</label><input id="obBrand"></div>' +
            '<div class="form-group"><label>País principal</label><select id="obCountry"><option value="CO">Colombia</option><option value="MX">México</option><option value="AR">Argentina</option><option value="CL">Chile</option><option value="ES">España</option></select></div>'
          : step === 2
          ? '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Paso 2 de 3 — Transporte de salida (puedes comprobarlo de verdad)</p>' +
            '<div class="form-group"><label>Motor</label><select id="obEngine"><option value="daemon">Daemon WhatsApp del CRM</option><option value="meta_cloud">Meta Cloud API</option></select></div>' +
            '<div class="form-group"><label>URL del daemon (si aplica)</label><input id="obDaemonUrl" placeholder="http://localhost:3002"></div>' +
            '<button class="btn btn-secondary btn-sm" id="obTest">🔌 Probar conexión real</button>' +
            '<div id="obTestResult" style="font-size:12px; color:var(--text-muted); margin-top:8px;"></div>'
          : '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Paso 3 de 3 — Tus contactos</p>' +
            '<p style="font-size:13px; line-height:1.6;">Todo listo. Ve a <b>Contactos</b> para importar tu primer CSV (el validador normaliza prefijos +57/+34 y descarta duplicados) o crea tu primera campaña con spintax anti-ban.</p>'
        ) +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" id="obSkip">Saltar</button>' +
          (step < 3 ? '<button class="btn btn-accent" id="obNext">Siguiente</button>' : '<button class="btn btn-accent" id="obDone">Empezar</button>') +
        '</div>'
      );
      document.getElementById('obSkip').addEventListener('click', finish);
      if (step === 1) {
        document.getElementById('obNext').addEventListener('click', function () {
          api('/api/settings', { method: 'PUT', body: JSON.stringify({ brandName: document.getElementById('obBrand').value.trim(), country: document.getElementById('obCountry').value }) })
            .then(function () { step = 2; draw(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo guardar', 'err'); });
        });
      }
      if (step === 2) {
        document.getElementById('obTest').addEventListener('click', function () {
          var out = document.getElementById('obTestResult');
          out.textContent = 'Probando…';
          api('/api/integrations/transport/test', { method: 'POST', body: JSON.stringify({ engine: document.getElementById('obEngine').value, daemonUrl: document.getElementById('obDaemonUrl').value.trim() }) })
            .then(function (r) { out.textContent = r.data.ok ? ('✅ Conectado en ' + r.data.latencyMs + ' ms') : ('❌ Sin conexión: ' + (r.data.error || ('HTTP ' + r.data.status))); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') out.textContent = '❌ ' + ((e && e.data && e.data.error) || 'error'); });
        });
        document.getElementById('obNext').addEventListener('click', function () {
          api('/api/integrations/transport', { method: 'PUT', body: JSON.stringify({ engine: document.getElementById('obEngine').value, daemonUrl: document.getElementById('obDaemonUrl').value.trim() || null }) })
            .then(function () { step = 3; draw(); renderTransportStatus(); })
            .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') toast('No se pudo guardar', 'err'); });
        });
      }
      if (step === 3) {
        document.getElementById('obDone').addEventListener('click', finish);
      }
    }
    function finish() {
      api('/api/settings', { method: 'PUT', body: JSON.stringify({ onboardingCompleted: true }) })
        .then(function () { closeModal(); toast('¡Configuración inicial lista!'); })
        .catch(function (e) { if (String(e.message) !== 'SESSION_EXPIRED') closeModal(); });
    }
    draw();
  }

  // ============================================================
  // Router principal
  // ============================================================
  var VIEWS = {
    summary: viewSummary,
    conversations: viewConversations,
    contacts: viewContacts,
    pipeline: viewPipeline,
    campaigns: viewCampaigns,
    'quick-replies': viewQuickReplies,
    tags: viewTags,
    agents: viewAgents,
    integrations: viewIntegrations,
    settings: viewSettings
  };
  function route() {
    clearViewTimers();
    if (window.pollInterval) { clearInterval(window.pollInterval); window.pollInterval = null; }
    if (window._summaryTimer) { clearInterval(window._summaryTimer); window._summaryTimer = null; }
    renderNav();
    var view = currentView();
    (VIEWS[view] || viewSummary)();
    closeSidebar();
  }
  window.addEventListener('hashchange', route);

  // Verificación de sesión al cargar: 401 → /login (api() ya redirige)
  api('/api/settings').then(function (r) {
    renderTransportStatus();
    refreshUnreadBadge();
    route();
    if (!r.data.onboardingCompletedAt) showOnboarding();
  }).catch(function (e) {
    if (String(e.message) !== 'SESSION_EXPIRED') route();
  });

  // Exponer las funciones onclick del creador/monitor (mismo contrato que el studio)
  window.generateNeuroSpintax = generateNeuroSpintax;
  window.testSpintax = testSpintax;
  window.previewCsv = previewCsv;
  window.createAndStartCampaign = createAndStartCampaign;
  window.refreshCurrentCampaign = refreshCurrentCampaign;
  window.pauseCampaign = pauseCampaign;
  window.resumeCampaign = resumeCampaign;
  window.cancelCampaign = cancelCampaign;
  window.fillCsvFromContacts = fillCsvFromContacts;
  window.toggleSidebar = toggleSidebar;
  window.closeSidebar = closeSidebar;
  window.doLogout = doLogout;
  </script>
</body>
</html>`
}