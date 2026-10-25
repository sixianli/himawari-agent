import { createServer } from "node:http";

let downloadBytes = 0;
createServer((request, response) => {
  if (request.url === "/set") {
    response
      .writeHead(200, {
        "Set-Cookie": "himawari=fixture-cookie; Path=/",
        "Content-Type": "text/html",
      })
      .end("<title>set</title>cookie set");
    return;
  }
  if (request.url === "/show") {
    response
      .writeHead(200, { "Content-Type": "text/html" })
      .end(`<title>show</title>cookie=${request.headers.cookie ?? "none"}`);
    return;
  }
  if (request.url === "/download") {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=slow.bin",
    });
    console.log("download-start");
    const chunk = Buffer.alloc(16384, 1);
    const timer = setInterval(() => {
      response.write(chunk);
      downloadBytes += chunk.length;
    }, 100);
    response.on("close", () => {
      clearInterval(timer);
      console.log(`download-closed ${downloadBytes}`);
    });
    return;
  }
  if (request.url === "/bytes") {
    response.end(String(downloadBytes));
    return;
  }
  response.writeHead(404).end();
}).listen(8080, "0.0.0.0");
