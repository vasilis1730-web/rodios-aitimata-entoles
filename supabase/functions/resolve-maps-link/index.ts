import {handleOptions, json} from '../_shared/http.ts';

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if(options) return options;
  if(req.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
  let body: {url?: string};
  try { body = await req.json(); }
  catch { return json({error: 'invalid_json'}, 400); }
  let target: URL;
  try { target = new URL(String(body.url || '')); }
  catch { return json({error: 'invalid_url'}, 400); }
  if(target.protocol !== 'https:' || !['maps.app.goo.gl', 'goo.gl'].includes(target.hostname)) {
    return json({error: 'unsupported_map_host'}, 400);
  }
  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {'User-Agent': 'RODIOS-Link-Resolver/1.0'}
    });
    return json({finalUrl: response.url || target.toString()});
  } catch(error) {
    return json({error: error instanceof Error ? error.message : 'resolve_failed'}, 502);
  }
});
