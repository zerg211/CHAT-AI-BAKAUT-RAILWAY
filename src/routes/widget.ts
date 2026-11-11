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
  function trimTrailingSlashes(value) {
    var text = String(value || '');
    while (text.endsWith('/')) text = text.slice(0, -1);
    return text;
  }
  var baseUrl = trimTrailingSlashes(data.chatSrc || ${JSON.stringify(baseUrl)});
  var title = data.title || 'БАКАУТ — ЧАТ ПОДДЕРЖКИ';
  var subtitle = data.subtitle || 'Строительное и силовое оборудование';
  var managerName = data.managerName || 'Алексей';
  var managerRole = data.managerRole || 'Менеджер';
  var managerPhoto = data.managerPhoto || '';
  var position = data.position === 'left' ? 'left' : 'right';
  var equipment = ['rammer', 'plate', 'saw', 'generator', 'dpu130', 'cutter'];
  var equipmentType = equipment.indexOf(data.equipmentType) >= 0 ? data.equipmentType : '';
  if (!equipmentType) {
    var previousEquipment = '';
    try { previousEquipment = sessionStorage.getItem('bakaut-ai-equipment') || ''; } catch (_) {}
    var choices = equipment.filter(function(item){ return item !== previousEquipment; });
    equipmentType = choices[Math.floor(Math.random() * choices.length)];
    try { sessionStorage.setItem('bakaut-ai-equipment', equipmentType); } catch (_) {}
  }
  var equipmentBase = data.equipmentBase || baseUrl + '/assets';
  var equipmentImage = managerPhoto || trimTrailingSlashes(equipmentBase) + '/equipment-' + equipmentType + (equipmentType === 'cutter' ? '.webp' : '.png');
  function pixelNumber(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw.endsWith('px')) return null;
    var numberText = raw.slice(0, -2).trim();
    if (!numberText) return null;
    var dotSeen = false;
    for (var i = 0; i < numberText.length; i += 1) {
      var code = numberText.charCodeAt(i);
      var digit = code >= 48 && code <= 57;
      if (digit) continue;
      if (code === 46 && !dotSeen) {
        dotSeen = true;
        continue;
      }
      return null;
    }
    var number = Number(numberText);
    return Number.isFinite(number) ? number : null;
  }
  function sizeAtLeast(value, fallback, minPx) {
    var raw = String(value || fallback).trim();
    var px = pixelNumber(raw);
    if (px !== null && px < minPx) return minPx + 'px';
    return raw || fallback;
  }
  var width = sizeAtLeast(data.width, '640px', 640);
  var height = sizeAtLeast(data.height, '820px', 820);
  function esc(value) {
    var text = String(value);
    var output = '';
    var replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    for (var i = 0; i < text.length; i += 1) {
      var ch = text.charAt(i);
      output += replacements[ch] || ch;
    }
    return output;
  }

  var root = document.createElement('div');
  root.id = 'bakaut-ai-widget-root';
  root.setAttribute('data-position', position);

  var launcher = document.createElement('button');
  launcher.id = 'bakaut-ai-widget-launcher';
  launcher.type = 'button';
  if (!managerPhoto) launcher.setAttribute('data-equipment', equipmentType);
  launcher.setAttribute('aria-label', title);
  launcher.innerHTML =
    '<span class="bakaut-ai-widget-avatar"><img alt="" style="display:none" src="' + esc(equipmentImage) + '"><span style="color:#0f766e">Чат</span></span>' +
    '<span class="bakaut-ai-widget-copy"><strong>' + esc(title) + '</strong><small>' + esc(managerName) + ' · ' + esc(managerRole) + '</small><em>' + esc(subtitle) + '</em></span>' +
    '<span class="bakaut-ai-widget-prompt">\\u0417\\u0430\\u0434\\u0430\\u0439\\u0442\\u0435 \\u043c\\u043d\\u0435 \\u0432\\u043e\\u043f\\u0440\\u043e\\u0441</span>';

  var launcherImage = launcher.querySelector('img');
  function showLauncherImage() {
    if (!launcherImage.naturalWidth) return;
    launcherImage.style.display = 'block';
    launcherImage.nextElementSibling.style.display = 'none';
  }
  launcherImage.addEventListener('load', showLauncherImage);
  if (launcherImage.complete) showLauncherImage();

  var panel = document.createElement('div');
  panel.id = 'bakaut-ai-widget-panel';
  panel.setAttribute('aria-hidden', 'true');

  var close = document.createElement('button');
  close.id = 'bakaut-ai-widget-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть чат');
  close.textContent = '×';

  var frame = null;
  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.id = 'bakaut-ai-widget-frame';
    frame.title = title;
    frame.src = baseUrl + '/widget?pageUrl=' + encodeURIComponent(location.href);
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('scrolling', 'no');
    panel.appendChild(frame);
  }

  panel.appendChild(close);
  root.appendChild(launcher);
  root.appendChild(panel);

  var style = document.createElement('style');
  style.textContent =
    '#bakaut-ai-widget-root{position:fixed;bottom:16px;z-index:2147483647;font-family:Inter,Arial,sans-serif;color:#111827;pointer-events:none}' +
    '#bakaut-ai-widget-root[data-position="left"]{left:32px}#bakaut-ai-widget-root[data-position="right"]{right:32px}' +
    '#bakaut-ai-widget-launcher{position:relative;display:grid;place-items:center;min-width:144px;width:144px;height:144px;padding:0;border:0;border-radius:0;background:transparent;color:#fff;box-shadow:none;cursor:pointer;overflow:visible;pointer-events:auto;touch-action:manipulation;transition:transform .18s ease}' +
    '#bakaut-ai-widget-launcher:hover{transform:translateY(-2px)}' +
    '#bakaut-ai-widget-launcher:active{transform:translateY(0) scale(.99)}' +
    '.bakaut-ai-widget-avatar{width:130px;height:130px;flex:0 0 130px;border-radius:999px;background:transparent;display:grid;place-items:center;font-size:28px;font-weight:800;overflow:visible;box-shadow:none}' +
    '.bakaut-ai-widget-avatar img{width:100%;height:100%;object-fit:contain;display:block}.bakaut-ai-widget-copy{display:none}.bakaut-ai-widget-prompt{display:block;position:absolute;right:0;bottom:calc(100% + 12px);width:max-content;max-width:220px;padding:9px 12px;border-radius:14px;background:#fff;color:#111827;font-size:13px;font-weight:700;line-height:1.2;box-shadow:0 14px 32px rgba(15,23,42,.22);pointer-events:none;opacity:0;animation:bakautAiQuestion 8s ease-in-out infinite}.bakaut-ai-widget-prompt::after{content:"";position:absolute;right:18px;bottom:-6px;width:12px;height:12px;background:#fff;transform:rotate(45deg);box-shadow:4px 4px 14px rgba(15,23,42,.12)}' +
    '#bakaut-ai-widget-launcher[data-equipment="plate"] .bakaut-ai-widget-avatar img{transform:scale(1.4)}#bakaut-ai-widget-launcher[data-equipment="rammer"] .bakaut-ai-widget-avatar img{transform:scale(1.5)}#bakaut-ai-widget-launcher[data-equipment="saw"] .bakaut-ai-widget-avatar img{transform:scale(.9)}#bakaut-ai-widget-launcher[data-equipment="generator"] .bakaut-ai-widget-avatar img{transform:scale(1.25)}#bakaut-ai-widget-launcher[data-equipment="dpu130"] .bakaut-ai-widget-avatar img{transform:scale(1.35)}#bakaut-ai-widget-launcher[data-equipment="cutter"] .bakaut-ai-widget-avatar img{transform:scale(1.4)}' +
    '#bakaut-ai-widget-panel{display:none;position:absolute;bottom:0;width:' + width + ';height:' + height + ';max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);opacity:0;transform:translateY(16px) scale(.96);pointer-events:none;transition:opacity .2s ease,transform .2s ease}' +
    '#bakaut-ai-widget-root[data-position="left"] #bakaut-ai-widget-panel{left:0}#bakaut-ai-widget-root[data-position="right"] #bakaut-ai-widget-panel{right:0}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-launcher{opacity:0;transform:translateY(10px) scale(.92);pointer-events:none}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-panel{display:block;opacity:1;transform:translateY(0) scale(1);pointer-events:auto}' +
    '#bakaut-ai-widget-frame{width:100%;height:100%;border:0;border-radius:12px;box-shadow:0 18px 48px rgba(15,23,42,.28);background:#fff;overflow:hidden}' +
    '#bakaut-ai-widget-close{position:absolute;top:-12px;right:-12px;width:32px;height:32px;border:0;border-radius:999px;background:#111827;color:#fff;font-size:24px;line-height:28px;box-shadow:0 10px 24px rgba(15,23,42,.28);cursor:pointer;z-index:2}' +
    '@keyframes bakautAiQuestion{0%,55%,100%{opacity:0;transform:translateY(8px) scale(.96)}8%,42%{opacity:1;transform:translateY(0) scale(1)}}' +
    '@media (max-width:768px){#bakaut-ai-widget-root{left:auto!important;right:12px!important;bottom:calc(74px + env(safe-area-inset-bottom,0px))!important;width:auto!important;height:auto!important}#bakaut-ai-widget-launcher{min-width:68px;width:68px;height:68px}.bakaut-ai-widget-avatar{width:64px;height:64px;flex-basis:64px;font-size:16px;box-shadow:none}.bakaut-ai-widget-prompt{display:block;right:0;bottom:calc(100% + 10px);max-width:190px;padding:8px 10px;border-radius:12px;font-size:12.5px;line-height:1.18;pointer-events:none}#bakaut-ai-widget-panel{position:fixed;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100svh!important;max-width:none!important;max-height:none!important}#bakaut-ai-widget-frame{border-radius:0;box-shadow:none}#bakaut-ai-widget-close{top:10px;right:10px;background:rgba(15,23,42,.72)}}';

  launcher.addEventListener('click', function(){
    ensureFrame();
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
