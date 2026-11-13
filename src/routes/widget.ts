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
  var equipment = ['rammer', 'plate', 'saw', 'generator', 'dpu130', 'cutter', 'lf100', 'bps1550', 'koop', 'tide'];
  var equipmentType = equipment.indexOf(data.equipmentType) >= 0 ? data.equipmentType : '';
  if (!equipmentType) {
    var previousEquipment = '';
    try { previousEquipment = sessionStorage.getItem('bakaut-ai-equipment') || ''; } catch (_) {}
    var choices = equipment.filter(function(item){ return item !== previousEquipment; });
    equipmentType = choices[Math.floor(Math.random() * choices.length)];
    try { sessionStorage.setItem('bakaut-ai-equipment', equipmentType); } catch (_) {}
  }
  var equipmentBase = data.equipmentBase || baseUrl + '/assets';
  var equipmentImage = managerPhoto || trimTrailingSlashes(equipmentBase) + '/equipment-v4-' + equipmentType + '.png';
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
  launcher.setAttribute('aria-label', 'Открыть чат по технике');
  launcher.innerHTML =
    '<span class="bakaut-ai-widget-label"><img class="bakaut-ai-widget-icon" alt="" src="' + esc(trimTrailingSlashes(equipmentBase) + '/chat-message-circle-more.svg') + '">' +
    '<span class="bakaut-ai-widget-label-copy"><strong>ЧАТ ПО ТЕХНИКЕ</strong><small>Подбор • сравнение • вопросы</small></span></span>' +
    '<span class="bakaut-ai-widget-avatar"><img alt="" style="display:none" src="' + esc(equipmentImage) + '"></span>';

  var launcherImage = launcher.querySelector('.bakaut-ai-widget-avatar img');
  function showLauncherImage() {
    if (launcherImage.naturalWidth) launcherImage.style.display = 'block';
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
    '#bakaut-ai-widget-launcher{position:relative;display:flex;align-items:center;justify-content:flex-end;width:320px;height:128px;padding:0;border:0;background:transparent;color:#fff;cursor:pointer;overflow:visible;pointer-events:auto;touch-action:manipulation;transition:transform .18s ease}' +
    '#bakaut-ai-widget-launcher:hover{transform:translateY(-2px)}#bakaut-ai-widget-launcher:focus-visible{outline:3px solid #f97316;outline-offset:3px}' +
    '.bakaut-ai-widget-label{width:225px;min-height:48px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:6px 9px;background:#121212;border:1px solid rgba(255,255,255,.9);border-radius:8px;box-shadow:0 5px 14px rgba(0,0,0,.22);text-align:left;position:relative} .bakaut-ai-widget-label:after{content:"";position:absolute;right:-7px;top:50%;border-top:7px solid transparent;border-bottom:7px solid transparent;border-left:7px solid #121212;transform:translateY(-50%)}' +
    '.bakaut-ai-widget-icon{width:23px;height:23px;filter:invert(1);flex:none}.bakaut-ai-widget-label-copy{display:flex;flex-direction:column;gap:2px;min-width:0;border-left:1px solid #bbb;padding-left:8px}.bakaut-ai-widget-label-copy strong{font-size:13px;line-height:1.1;white-space:nowrap}.bakaut-ai-widget-label-copy small{font-size:9px;line-height:1.15;white-space:nowrap}' +
    '.bakaut-ai-widget-avatar{width:95px;height:120px;flex:none;display:grid;place-items:center}.bakaut-ai-widget-avatar img{width:100%;height:100%;object-fit:contain}' +
    '' +
    '#bakaut-ai-widget-panel{display:none;position:absolute;bottom:0;width:' + width + ';height:' + height + ';max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);opacity:0;transform:translateY(16px) scale(.96);pointer-events:none;transition:opacity .2s ease,transform .2s ease}' +
    '#bakaut-ai-widget-root[data-position="left"] #bakaut-ai-widget-panel{left:0}#bakaut-ai-widget-root[data-position="right"] #bakaut-ai-widget-panel{right:0}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-launcher{opacity:0;transform:translateY(10px) scale(.92);pointer-events:none}' +
    '#bakaut-ai-widget-root.bakaut-ai-open #bakaut-ai-widget-panel{display:block;opacity:1;transform:translateY(0) scale(1);pointer-events:auto}' +
    '#bakaut-ai-widget-frame{width:100%;height:100%;border:0;border-radius:12px;box-shadow:0 18px 48px rgba(15,23,42,.28);background:#fff;overflow:hidden}' +
    '#bakaut-ai-widget-close{position:absolute;top:-12px;right:-12px;width:32px;height:32px;border:0;border-radius:999px;background:#111827;color:#fff;font-size:24px;line-height:28px;box-shadow:0 10px 24px rgba(15,23,42,.28);cursor:pointer;z-index:2}' +
    '@media (max-width:768px){#bakaut-ai-widget-root{left:auto!important;right:12px!important;bottom:calc(74px + env(safe-area-inset-bottom,0px))!important;width:auto!important;height:auto!important}#bakaut-ai-widget-launcher{width:min(270px,calc(100vw - 24px));height:90px}.bakaut-ai-widget-label{width:190px;min-height:48px}.bakaut-ai-widget-label-copy strong{font-size:12px}.bakaut-ai-widget-label-copy small{font-size:9px}.bakaut-ai-widget-avatar{width:75px;height:85px}#bakaut-ai-widget-panel{position:fixed;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100svh!important;max-width:none!important;max-height:none!important}#bakaut-ai-widget-frame{border-radius:0;box-shadow:none}#bakaut-ai-widget-close{top:10px;right:10px;background:rgba(15,23,42,.72)}}';

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
