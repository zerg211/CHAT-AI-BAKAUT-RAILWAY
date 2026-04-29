import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
  var existing = document.getElementById('bakaut-ai-widget-frame');
  if (existing) return;
  var frame = document.createElement('iframe');
  frame.id = 'bakaut-ai-widget-frame';
  frame.title = 'AI консультант БАКАУТ';
  frame.src = '${baseUrl}/widget?pageUrl=' + encodeURIComponent(location.href);
  frame.style.position = 'fixed';
  frame.style.right = '16px';
  frame.style.bottom = '16px';
  frame.style.width = '390px';
  frame.style.height = '620px';
  frame.style.maxWidth = 'calc(100vw - 24px)';
  frame.style.maxHeight = 'calc(100vh - 24px)';
  frame.style.border = '0';
  frame.style.borderRadius = '12px';
  frame.style.boxShadow = '0 18px 48px rgba(15, 23, 42, 0.28)';
  frame.style.zIndex = '2147483647';
  frame.style.overflow = 'hidden';
  frame.setAttribute('allow', 'clipboard-write');
  frame.setAttribute('scrolling', 'no');
  document.body.appendChild(frame);
  var mobileStyle = document.createElement('style');
  mobileStyle.textContent = '@media (max-width: 640px){#bakaut-ai-widget-frame{left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;height:100svh!important;max-width:none!important;max-height:none!important;border-radius:0!important;box-shadow:none!important;}}';
  document.head.appendChild(mobileStyle);
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

  app.get('/embed.js', async (request, reply) => {
    const protocol = request.headers['x-forwarded-proto'] ?? 'http';
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    const inferredBase = host ? `${protocol}://${host}` : config.PUBLIC_BASE_URL;
    const baseUrl = config.PUBLIC_BASE_URL !== 'http://localhost:3010' ? config.PUBLIC_BASE_URL : inferredBase;
    reply.type('application/javascript; charset=utf-8');
    return reply.send(embedScript(baseUrl));
  });
}
