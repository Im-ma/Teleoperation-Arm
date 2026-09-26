import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.mp4':'video/mp4','.stl':'application/octet-stream','.urdf':'application/xml'};
export function startServer(port=8610) {
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      let path=resolve(root,'.'+decodeURIComponent(url.pathname === '/' ? '/demo3d/index.html' : url.pathname));
      if(!path.startsWith(root+sep)) {res.writeHead(403);res.end();return;}
      if((await stat(path)).isDirectory()) path=resolve(path,'index.html');
      const body=await readFile(path);
      res.writeHead(200,{'Content-Type':types[extname(path).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});res.end(body);
    } catch {res.writeHead(404);res.end('Not found');}
  });
  return new Promise(resolve=>server.listen(port,'127.0.0.1',()=>resolve(server)));
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 await startServer(Number(process.env.PORT||8610));
 console.log('MIMIC demonstration: http://127.0.0.1:8610/demo3d/');
}
