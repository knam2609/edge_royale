import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";

const root = resolve(process.cwd());
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "5173", 10);

const contentTypeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function safePath(pathname) {
  const stripped = pathname.split("?")[0].split("#")[0];
  const candidate = normalize(join(root, stripped));
  if (!candidate.startsWith(root)) {
    return null;
  }
  return candidate;
}

const server = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = safePath(reqPath);

  if (!fullPath || !existsSync(fullPath) || statSync(fullPath).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const ext = extname(fullPath).toLowerCase();
  res.setHeader("Content-Type", contentTypeByExt[ext] ?? "application/octet-stream");
  createReadStream(fullPath).pipe(res);
});

server.listen(port, host, () => {
  process.stdout.write(`Dev server listening at http://${host}:${port}\n`);
});
