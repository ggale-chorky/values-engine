import { createDemoWebServer } from '../web/server.js';
import { isMain } from './db-cli.js';

export function main() {
  const server = createDemoWebServer();
  server.on('error', () => { console.error('Values Engine demo could not start. Check whether port 4310 is available.'); process.exitCode = 1; });
  server.listen(4310, '127.0.0.1', () => console.error('Values Engine founder demo: http://127.0.0.1:4310'));
  return server;
}
if (isMain(import.meta.url)) main();
