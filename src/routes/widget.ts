import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const clientDist = path.join(process.cwd(), 'dist', 'client');

function devWidgetHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=overlays-content"
    />
    <title>БАКАУТ AI ассистент</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${config.WEB_DEV_ORIGIN}/main.tsx"></script>
  </body>
</html>`;
}

function sendClientHtml(reply: FastifyReply) {
  const indexPath = path.join(clientDist, 'index.html');
  reply.type('text/html; charset=utf-8');
  if (fs.existsSync(indexPath)) return reply.send(fs.readFileSync(indexPath, 'utf8'));
  return reply.send(devWidgetHtml());
}

function embedScript(baseUrl: string) {
  return `(function(){
  var existing = document.getElementById('bakaut-ai-widget-root');
  if (existing) return;
  var script = document.currentScript;
  var data = script && script.dataset ? script.dataset : {};
  var baseUrl = (data.chatSrc || ${JSON.stringify(baseUrl)}).replace(/\\/+$/, '');
  var title = data.title || 'БАКАУТ — ЧАТ ПОДДЕРЖКИ';
  var subtitle = data.subtitle || 'Строительное и силовое оборудование';
  var managerName = data.managerName || 'Алексей';
  var managerRole = data.managerRole || 'Менеджер';
  var managerPhoto = data.managerPhoto || '';
  var position = data.position === 'left' ? 'left' : 'right';
  function sizeAtLeast(value, fallback, minPx) {
    var raw = String(value || fallback).trim();
    var px = raw.match(/^(\\d+(?:\\.\\d+)?)px$/i);
    if (px && Number(px[1]) < minPx) return minPx + 'px';
    return raw || fallback;
  }
  var width = sizeAtLeast(data.width, '640px', 640);
  var height = sizeAtLeast(data.height, '820px', 820);
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  var root = document.createElement('div');
  root.id = 'bakaut-ai-widget-root';
  root.setAttribute('data-position', position);

  var launcher = document.createElement('button');
  launcher.id = 'bakaut-ai-widget-launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', title);
  launcher.innerHTML =
    '<span class="bakaut-ai-widget-pulse"></span>' +
    '<span class="bakaut-ai-widget-avatar">' + (managerPhoto ? '<img alt="" src="' + esc(managerPhoto) + '">' : '<span>AI</span>') + '</span>' +
    '<span class="bakaut-ai-widget-copy"><strong>' + esc(title) + '</strong><small>' + esc(managerName) + ' · ' + esc(managerRole) + '</small><em>' + esc(subtitle) + '</em></span>' +
    '<span class="bakaut-ai-widget-prompt">\\u0417\\u0430\\u0434\\u0430\\u0439\\u0442\\u0435 \\u043c\\u043d\\u0435 \\u0432\\u043e\\u043f\\u0440\\u043e\\u0441</span>';

  var panel = document.createElement('div');
  panel.id = 'bakaut-ai-widget-panel';
  panel.setAttribute('aria-hidden', 'true');

  var close = document.createElement('button');
  close.id = 'bakaut-ai-widget-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть чат');
  close.textContent = '×';

  var frame = document.createElement('iframe');
  frame.id = 'bakaut-ai-widget-frame';
  frame.title = title;
  frame.src = baseUrl + '/widget?pageUrl=' + encodeURIComponent(location.href);
  frame.setAttribute('allow', 'clipboard-write');
  frame.setAttribute('scrolling', 'no');

  panel.appendChild(close);
  panel.appendChild(frame);
  root.appendChild(launcher);
  root.appendChild(panel);

  var style = document.createElement('style');
  style.textContent =
    '#bakaut-ai-widget-root{position:fixed;bottom:16px;z-index:2147483647;font-family:Inter,Arial,sans-serif;color:#111827;pointer-events:none}' +
    '#bakaut-ai-widget-root[data-position="left"]{left:16px}#bakaut-ai-widget-root[data-position="right"]{right:16px}' +
    '#bakaut-ai-widget-launcher{position:relative;display:flex;align-items:center;gap:12px;min-width:252px;max-width:min(360px,calc(100vw - 32px));padding:12px 14px;border:0;border-radius:999px;background:#111827;color:#fff;box-shadow:0 16px 42px rgba(15,23,42,.30);cursor:pointer;overflow:hidden;pointer-events:auto;transition:transform .18s ease,box-shadow .18s ease;background-image:linear-gradient(135deg,#111827,#1f2937 55%,#0f766e)}' +
    '#bakaut-ai-widget-launcher:hover{transform:translateY(-2px);box-shadow:0 20px 52px rgba(15,23,42,.38)}' +
    '#bakaut-ai-widget-launcher:active{transform:translateY(0) scale(.99)}' +
    '.bakaut-ai-widget-pulse{position:absolute;inset:0;border-radius:999px;box-shadow:0 0 0 0 rgba(20,184,166,.55);animation:bakautAiPulse 2.2s infinite;pointer-events:none}' +
    '.bakaut-ai-widget-avatar{width:44px;height:44px;flex:0 0 44px;border-radius:999px;background:#f97316;display:grid;place-items:center;font-weight:800;overflow:hidden;box-shadow:0 0 0 3px rgba(255,255,255,.16)}' +
    '.bakaut-ai-widget-avatar img{width:100%;height:100%;object-fit:cover;display:block}.bakaut-ai-widget-copy{display:flex;flex-direction:column;align-items:flex-start;min-width:0;text-align:left;line-height:1.15}.bakaut-ai-widget-copy strong{font-size:13px;white-space:nowrap;max-width:245px;overflow:hidden;text-overflow:ellipsis}.bakaut-ai-widget-copy small{margin-top:3px;font-size:12px;color:#d1fae5}.bakaut-ai-widget-copy em{margin-top:2px;font-style:normal;font-size:11px;color:#cbd5e1;white-space:nowrap;max-width:245px;overflow:hidden;text-overflow:ellipsis}.bakaut-ai-widget-prompt{display:none}' +
    '#bakaut-ai-widget-panel{position:absolute;bottom:0;width:' + width + ';height:' + height + ';max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);opacity:0;transform:translateY(16px) scale(.96);pointer-events:none;transition:opacity .2s ease,transform .2s ease}' +
    '#bakaut-ai-widget-root[data-position="left"] #bakaut-ai-widget-panel{left:0}#bakaut-ai-widget-root[data-position="right"] #bakaut-ai-widget-panel{right:0}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-launcher{opacity:0;transform:translateY(10px) scale(.92);pointer-events:none}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-panel{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}' +
    '#bakaut-ai-widget-frame{width:100%;height:100%;border:0;border-radius:12px;box-shadow:0 18px 48px rgba(15,23,42,.28);background:#fff;overflow:hidden}' +
    '#bakaut-ai-widget-close{position:absolute;top:-12px;right:-12px;width:32px;height:32px;border:0;border-radius:999px;background:#111827;color:#fff;font-size:24px;line-height:28px;box-shadow:0 10px 24px rgba(15,23,42,.28);cursor:pointer;z-index:2}' +
    '@keyframes bakautAiPulse{0%{box-shadow:0 0 0 0 rgba(20,184,166,.55)}70%{box-shadow:0 0 0 18px rgba(20,184,166,0)}100%{box-shadow:0 0 0 0 rgba(20,184,166,0)}}' +
    '@keyframes bakautAiQuestion{0%,55%,100%{opacity:0;transform:translateY(8px) scale(.96)}8%,42%{opacity:1;transform:translateY(0) scale(1)}}' +
    '@media (max-width:640px){#bakaut-ai-widget-root{left:0!important;right:0!important;bottom:0!important}#bakaut-ai-widget-launcher{margin:0 18px calc(164px + env(safe-area-inset-bottom,0px)) auto;min-width:72px;width:72px;height:72px;padding:0;display:grid;place-items:center;border-radius:999px;overflow:visible;background:#0f766e;background-image:radial-gradient(circle at 32% 28%,rgba(255,255,255,.32),rgba(255,255,255,0) 34%),linear-gradient(135deg,#111827,#0f766e);box-shadow:0 18px 42px rgba(15,23,42,.34),0 0 0 1px rgba(255,255,255,.18)}.bakaut-ai-widget-prompt{display:block;position:absolute;right:0;bottom:calc(100% + 12px);width:max-content;max-width:220px;padding:9px 12px;border-radius:14px;background:#fff;color:#111827;font-size:13px;font-weight:700;line-height:1.2;box-shadow:0 14px 32px rgba(15,23,42,.22);pointer-events:none;opacity:0;animation:bakautAiQuestion 8s ease-in-out infinite}.bakaut-ai-widget-prompt::after{content:"";position:absolute;right:18px;bottom:-6px;width:12px;height:12px;background:#fff;transform:rotate(45deg);box-shadow:4px 4px 14px rgba(15,23,42,.12)}.bakaut-ai-widget-pulse{inset:-8px;animation:bakautAiPulse 1.8s infinite}.bakaut-ai-widget-avatar{width:54px;height:54px;flex-basis:54px}.bakaut-ai-widget-copy{display:none}#bakaut-ai-widget-panel{left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100svh!important;max-width:none!important;max-height:none!important}#bakaut-ai-widget-frame{border-radius:0;box-shadow:none}#bakaut-ai-widget-close{top:10px;right:10px;background:rgba(15,23,42,.72)}}';

  launcher.addEventListener('click', function(){
    root.classList.add('bakaut-ai-open');
    panel.setAttribute('aria-hidden', 'false');
  });
  close.addEventListener('click', function(event){
    event.preventDefault();
    root.classList.remove('bakaut-ai-open');
    panel.setAttribute('aria-hidden', 'true');
  });
  document.head.appendChild(style);
  document.body.appendChild(root);
})();`;
}

export async function registerWidgetRoutes(app: FastifyInstance) {
  const assetsDir = path.join(clientDist, 'assets');
  if (fs.existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/'
    });
  }

  app.get('/', async (_request, reply) => reply.redirect('/widget'));

  app.get('/widget', async (_request, reply) => {
    return sendClientHtml(reply);
  });

  app.get('/admin', async (_request, reply) => {
    return sendClientHtml(reply);
  });

  const sendEmbedScript = async (request: FastifyRequest, reply: FastifyReply) => {
    const protocol = request.headers['x-forwarded-proto'] ?? 'http';
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    const inferredBase = host ? `${protocol}://${host}` : config.PUBLIC_BASE_URL;
    const baseUrl = config.PUBLIC_BASE_URL !== 'http://localhost:3010' ? config.PUBLIC_BASE_URL : inferredBase;
    reply.type('application/javascript; charset=utf-8');
    return reply.send(embedScript(baseUrl));
  };

  app.get('/embed.js', sendEmbedScript);
  app.get('/widget.js', sendEmbedScript);
}
