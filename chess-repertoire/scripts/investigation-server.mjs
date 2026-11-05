import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
const output = path.resolve('investigation-results/browser');
fs.mkdirSync(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 5177, strictPort: true, hmr: false }, plugins: [{
  name: 'local-engine-investigation',
  configureServer(server) {
    server.middlewares.use('/__engine-investigation', (req, res) => {
      if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:5177') { res.statusCode = 403; res.end(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 10000000) req.destroy(); });
      req.on('end', () => {
        try {
          const entry = JSON.parse(body);
          if (entry.kind === 'tree') fs.writeFileSync(path.join(output, 'tree.json'), JSON.stringify(entry.tree));
          else fs.appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify({at: new Date().toISOString(), ...entry}) + '\n');
          res.end('ok');
        } catch { res.statusCode = 400; res.end(); }
      });
    });
  },
}] });
await server.listen();
server.printUrls();
