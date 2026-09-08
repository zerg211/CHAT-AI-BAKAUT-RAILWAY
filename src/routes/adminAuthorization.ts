import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {config} from '../config.js';
import {pool} from '../db/pool.js';

type Scope = 'diagnostics:read' | 'catalog:read' | 'catalog:write' | 'leads:read' | 'conversations:read' |
  'feedback:read' | 'feedback:write' | 'destructive:write' | 'provider:probe';
type RoutePolicy = {scope: Scope; mutation?: boolean};
const routes: Record<string, RoutePolicy> = {
  'GET /api/admin/health': {scope:'diagnostics:read'},
  'GET /api/admin/quality/audit': {scope:'diagnostics:read'},
  'GET /api/admin/openai-usage': {scope:'diagnostics:read'},
  'GET /api/admin/runtime/openai': {scope:'provider:probe',mutation:true},
  'GET /api/admin/products': {scope:'catalog:read'},
  'GET /api/admin/conflicts': {scope:'catalog:read'},
  'GET /api/admin/embedding-coverage': {scope:'catalog:read'},
  'GET /api/admin/catalog/freshness': {scope:'catalog:read'},
  'POST /api/admin/catalog/import-csv': {scope:'catalog:write',mutation:true},
  'POST /api/admin/catalog/sync-site': {scope:'catalog:write',mutation:true},
  'POST /api/admin/catalog/sync-sitemap': {scope:'catalog:write',mutation:true},
  'GET /api/admin/conversations': {scope:'conversations:read'},
  'GET /api/admin/conversations/:id': {scope:'conversations:read'},
  'GET /api/admin/conversations/:id/agent-traces': {scope:'conversations:read'},
  'DELETE /api/admin/conversations/:id': {scope:'destructive:write',mutation:true},
  'PATCH /api/admin/conversations/:id/outcome': {scope:'feedback:write',mutation:true},
  'GET /api/admin/leads': {scope:'leads:read'},
  'GET /api/admin/feedback': {scope:'feedback:read'},
  'PATCH /api/admin/feedback/:id': {scope:'feedback:write',mutation:true},
  'POST /api/admin/feedback/:id/export-candidate': {scope:'feedback:write',mutation:true}
};

function denied(statusCode: number) {
  return Object.assign(new Error(statusCode === 401 ? 'Unauthorized' : 'Forbidden'), {statusCode});
}
function matches(token: string, expected: string) {
  return timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(expected).digest());
}

export function authorizeAdmin(request: Pick<FastifyRequest,'headers'|'method'|'routeOptions'>) {
  const credentials: Array<{actor:string; token?:string; scopes:Scope[]}> = [
    {actor:'debug',token:config.ADMIN_DEBUG_TOKEN,scopes:['diagnostics:read','catalog:read','conversations:read']},
    {actor:'catalog',token:config.ADMIN_CATALOG_TOKEN,scopes:['catalog:read','catalog:write']},
    {actor:'leads',token:config.ADMIN_LEADS_TOKEN,scopes:['leads:read','conversations:read']},
    {actor:'destructive',token:config.ADMIN_DESTRUCTIVE_TOKEN,scopes:['destructive:write','feedback:read','feedback:write','provider:probe']},
    {actor:'eval',token:config.EVAL_SERVICE_TOKEN,scopes:['diagnostics:read']}
  ];
  const configured = credentials.filter(c=>c.token?.trim());
  const supplied = request.headers.authorization;
  const token = supplied?.startsWith('Bearer ') ? supplied.slice(7) : '';
  if (!token) throw denied(401);
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const operation = `${method} ${request.routeOptions.url}`;
  const policy = routes[operation];
  if (!policy) throw denied(403);
  if (!configured.length) {
    const legacy = config.ADMIN_PASSWORD?.trim() || config.ADMIN_API_KEY?.trim();
    if (!legacy || !matches(token,legacy)) throw denied(401);
    return {actor:'legacy-admin',operation,...policy};
  }
  const principals = configured.filter(c=>matches(token,c.token!.trim()));
  if (!principals.length) throw denied(401);
  if (principals.length !== 1 || !principals[0]!.scopes.includes(policy.scope)) throw denied(403);
  return {actor:principals[0]!.actor,operation,...policy};
}

export function registerAdminAuthorization(app: FastifyInstance) {
  const pending = new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async request=>{
    if (!request.routeOptions.url?.startsWith('/api/admin/')) return;
    const principal = authorizeAdmin(request);
    if (!principal.mutation) return;
    const id = randomUUID();
    // Only validated UUID resources are recorded, never arbitrary input paths.
    const candidate = (request.params as {id?:unknown} | undefined)?.id;
    const resource = z.string().uuid().safeParse(candidate).data ?? 'collection';
    await pool.query(`INSERT INTO admin_mutation_audit(id,actor,scope,operation,resource,request_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,principal.actor,principal.scope,principal.operation,resource,String(request.id).slice(0,200)]);
    pending.set(request,id);
  });
  app.addHook('onResponse',async(request,reply)=>{
    const id = pending.get(request);
    if (!id) return;
    try {
      await pool.query('UPDATE admin_mutation_audit SET completed_at=now(),http_status=$2 WHERE id=$1',[id,reply.statusCode]);
    } catch {
      request.log.error({auditId:id},'Admin mutation completion audit unavailable; intent retained');
    }
  });
}
