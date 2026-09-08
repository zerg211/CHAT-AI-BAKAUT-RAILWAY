import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const {settings,query} = vi.hoisted(()=>({settings: {
  ADMIN_PASSWORD:'legacy-secret',ADMIN_API_KEY:undefined,
  ADMIN_DEBUG_TOKEN:'debug-token',ADMIN_CATALOG_TOKEN:'catalog-token',ADMIN_LEADS_TOKEN:'leads-token',
  ADMIN_DESTRUCTIVE_TOKEN:'destructive-token',EVAL_SERVICE_TOKEN:'evaluation-token'
} as Record<string,string|undefined>,query:vi.fn(async()=>({rows:[]}))}));
vi.mock('../src/config.js',()=>({config:settings}));
vi.mock('../src/db/pool.js',()=>({pool:{query}}));
const {registerAdminAuthorization}=await import('../src/routes/adminAuthorization.js');
async function fixture() {
  const app=Fastify();const action=vi.fn(async()=>({ok:true}));
  registerAdminAuthorization(app);
  app.get('/api/admin/health',action);
  app.get('/api/admin/leads',action);
  app.get('/api/admin/runtime/openai',action);
  app.get('/api/admin/not-authorized-by-default',action);
  app.post('/api/admin/catalog/sync-site',action);
  app.delete('/api/admin/conversations/:id',action);
  app.patch('/api/admin/feedback/:id',action);
  await app.ready();return {app,action};
}
describe('scoped admin routes and durable mutation intent',()=>{
  beforeEach(()=>{vi.clearAllMocks();query.mockResolvedValue({rows:[]});});
  it.each(['evaluation-token','debug-token'])('read-only credential %s cannot mutate or probe a provider',async token=>{
    const {app,action}=await fixture();
    try {
      for(const [method,url] of [
        ['DELETE','/api/admin/conversations/30b1b4b0-c9cd-4c0a-bfbd-06c395fb3c03'],
        ['POST','/api/admin/catalog/sync-site'],['PATCH','/api/admin/feedback/anything'],
        ['GET','/api/admin/runtime/openai'],['GET','/api/admin/leads']
      ] as const) {
        expect((await app.inject({method,url,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(403);
      }
      expect(action).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
      expect((await app.inject({method:'GET',url:'/api/admin/health?operation=delete',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(200);
    } finally {await app.close();}
  });
  it('persists an intent before mutation and records completion without body or credentials',async()=>{
    const {app,action}=await fixture();
    try {
      const response=await app.inject({method:'POST',url:'/api/admin/catalog/sync-site?private=secret',
        payload:{private:'sensitive body'},headers:{authorization:'Bearer catalog-token'}});
      expect(response.statusCode).toBe(200);
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]!);
      expect(query).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(query.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(query.mock.calls)).not.toContain('catalog-token');
      expect(JSON.stringify(query.mock.calls)).not.toContain('sensitive body');
    } finally {await app.close();}
  });
  it('does not mutate if audit intent cannot persist',async()=>{
    const {app,action}=await fixture();query.mockRejectedValueOnce(new Error('database unavailable'));
    try {
      expect((await app.inject({method:'POST',url:'/api/admin/catalog/sync-site',headers:{authorization:'Bearer catalog-token'}})).statusCode).toBe(500);
      expect(action).not.toHaveBeenCalled();
    } finally {await app.close();}
  });
  it('disables legacy access once scopes are configured and rejects unknown routes',async()=>{
    const {app,action}=await fixture();
    try {
      expect((await app.inject({url:'/api/admin/health',headers:{authorization:'Bearer legacy-secret'}})).statusCode).toBe(401);
      expect((await app.inject({url:'/api/admin/not-authorized-by-default',headers:{authorization:'Bearer debug-token'}})).statusCode).toBe(403);
      expect(action).not.toHaveBeenCalled();
    } finally {await app.close();}
  });
  it('denies ambiguous credentials instead of merging their privileges',async()=>{
    const before=settings.ADMIN_DEBUG_TOKEN;settings.ADMIN_DEBUG_TOKEN=settings.ADMIN_CATALOG_TOKEN;
    const {app,action}=await fixture();
    try {
      expect((await app.inject({method:'POST',url:'/api/admin/catalog/sync-site',headers:{authorization:'Bearer catalog-token'}})).statusCode).toBe(403);
      expect(action).not.toHaveBeenCalled();
    } finally {settings.ADMIN_DEBUG_TOKEN=before;await app.close();}
  });
  it('preserves legacy read access while no scoped credentials are configured',async()=>{
    const saved={...settings};for(const key of Object.keys(settings))if(key.endsWith('_TOKEN'))settings[key]=undefined;
    const {app}=await fixture();
    try {
      expect((await app.inject({url:'/api/admin/health',headers:{authorization:'Bearer legacy-secret'}})).statusCode).toBe(200);
    } finally {Object.assign(settings,saved);await app.close();}
  });
});
