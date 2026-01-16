/**
 * Deno VLESS Proxy (Optimized & Secured)
 * 
 * Env Variables:
 * - UUID: (Optional) Your specific UUID. If not set, a random one is generated.
 * - PROXYIP: (Optional) Proxy IP for CDN/Cloudflare IP selection.
 */

// Global Configuration
const envUUID = Deno.env.get('UUID');
const proxyIP = Deno.env.get('PROXYIP') || '';
// If no UUID is set in Env, generate a random one (Note: Random UUID changes on every restart)
const userID = envUUID && isValidUUID(envUUID) ? envUUID : crypto.randomUUID();

console.log(`✅ Server Started`);
console.log(`🔑 UUID: ${userID}`);

// Main Entry Point
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  
  // 1. Handle VLESS via WebSocket
  if (upgrade.toLowerCase() === 'websocket') {
    return await vlessOverWSHandler(request);
  }

  // 2. Handle Web Page (UI)
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/': {
      return new Response(renderHomePage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    
    case `/${userID}`: {
      return new Response(renderConfigPage(url.hostname, url.port || (url.protocol === 'https:' ? '443' : '80')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    default:
      return new Response('404 Not Found', { status: 404 });
  }
});

// ==========================================
// VLESS LOGIC
// ==========================================

async function vlessOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  let address = '';
  let portWithRandomLog = '';
  
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  
  let remoteSocketWrapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      
      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(new Uint8Array(chunk));
        writer.releaseLock();
        return;
      }

      const vlessData = processVlessHeader(chunk, userID);
      
      if (vlessData.hasError) {
        console.error(`[VLESS Error] ${vlessData.message}`);
        // Instead of throwing errors that crash the stream immediately, 
        // we can just return to ignore bad packets or close gracefully.
        return; 
      }

      const {
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP,
      } = vlessData;

      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;

      // Handle UDP
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          // Note: Deno Deploy restricts arbitrary UDP. 
          // We allow the code to proceed, but it might fail depending on the platform.
          // Keeping DNS optimization enabled.
          console.log(`[UDP] Unknown UDP traffic to ${portRemote}. Might fail on serverless env.`);
        }
      }

      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isDns) {
        const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }

      await handleTCPOutBound(
        remoteSocketWrapper,
        addressRemote,
        portRemote,
        rawClientData,
        socket,
        vlessResponseHeader,
        log
      );
    },
    close() {
      log(`ReadableWebSocketStream closed`);
    },
    abort(reason) {
      log(`ReadableWebSocketStream aborted`, JSON.stringify(reason));
    },
  })).catch((err) => {
    log('ReadableWebSocketStream pipeTo error', err);
  });

  return response;
}

// ==========================================
// OUTBOUND HANDLERS
// ==========================================

async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({ port: port, hostname: address });
    remoteSocket.value = tcpSocket;
    log(`Connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
  } catch (e) {
    log(`TCP Connect failed: ${e.message}`);
    // If direct connection fails and we have a proxyIP, try that (simple fallback logic)
    if (proxyIP && addressRemote !== proxyIP) {
        log(`Retrying with ProxyIP: ${proxyIP}`);
        retry();
    } else {
        safeCloseWebSocket(webSocket);
    }
  }
}

async function remoteSocketToWS(remoteSocket: Deno.TcpConn, webSocket: WebSocket, vlessResponseHeader: Uint8Array | null, retry: (() => Promise<void>) | null, log: (info: string, event?: string) => void) {
  let hasIncomingData = false;
  
  await remoteSocket.readable.pipeTo(
    new WritableStream({
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WebSocket.OPEN) {
          controller.error('WebSocket is not open');
        }
        if (vlessResponseHeader) {
          webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
          vlessResponseHeader = null;
        } else {
          webSocket.send(chunk);
        }
      },
      close() {
        log(`Remote Socket closed`);
      },
      abort(reason) {
        console.error(`Remote Socket aborted`, reason);
      },
    })
  ).catch((error) => {
    console.error(`remoteSocketToWS error`, error);
    safeCloseWebSocket(webSocket);
  });

  if (hasIncomingData === false && retry) {
    log(`No incoming data, retrying...`);
    retry();
  }
}

async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: (info: string) => void) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
      
      if (webSocket.readyState === WebSocket.OPEN) {
        log(`DOH success, length: ${udpSize}`);
        if (isVlessHeaderSent) {
          webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
        } else {
          webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
          isVlessHeaderSent = true;
        }
      }
    },
  })).catch((error) => {
    log('DNS UDP error: ' + error);
  });

  const writer = transformStream.writable.getWriter();
  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}

// ==========================================
// HELPERS
// ==========================================

function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: (info: string, event?: string) => void) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket Server Error');
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream canceled`, reason);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
  return stream;
}

function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data length' };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  
  const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
  const uuidString = stringifyUUID(uuidBytes);
  
  if (uuidString !== userID) {
    return { hasError: true, message: 'Invalid UUID' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  let isUDP = false;
  if (command === 2) {
    isUDP = true;
  } else if (command !== 1) {
    return { hasError: true, message: `Command ${command} not supported (01=TCP, 02=UDP)` };
  }

  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid addressType: ${addressType}` };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

function base64ToArrayBuffer(base64Str: string) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function stringifyUUID(arr: Uint8Array): string {
  const byteToHex = [];
  for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
  return (
    byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' +
    byteToHex[arr[4]] + byteToHex[arr[5]] + '-' +
    byteToHex[arr[6]] + byteToHex[arr[7]] + '-' +
    byteToHex[arr[8]] + byteToHex[arr[9]] + '-' +
    byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] +
    byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]]
  ).toLowerCase();
}

function safeCloseWebSocket(socket: WebSocket) {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

// ==========================================
// UI TEMPLATES
// ==========================================

function renderHomePage() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Deno Proxy</title>
      <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .card { background: #161b22; padding: 40px; border-radius: 12px; border: 1px solid #30363d; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #58a6ff; margin-bottom: 10px; }
          p { margin-bottom: 20px; color: #8b949e; }
          .btn { background: #238636; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; transition: 0.2s; }
          .btn:hover { background: #2ea043; }
      </style>
  </head>
  <body>
      <div class="card">
          <h1>🚀 System Operational</h1>
          <p>The VLESS Proxy Node is running securely.</p>
          <a href="/${userID}" class="btn">Get Configuration</a>
      </div>
  </body>
  </html>`;
}

function renderConfigPage(hostName: string, port: string) {
  const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F#Deno-Proxy`;
  const clashConfig = `
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${userID}
  network: ws
  tls: true
  udp: true
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/"
    headers:
      host: ${hostName}`;

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>VLESS Config</title>
      <style>
          body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 20px; max-width: 800px; margin: 0 auto; }
          h2 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 10px; }
          .box { background: #161b22; padding: 15px; border-radius: 6px; border: 1px solid #30363d; overflow-x: auto; margin-bottom: 20px; position: relative; }
          pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: #a5d6ff; }
          button { position: absolute; top: 10px; right: 10px; background: #238636; border: none; color: white; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
          button:active { transform: scale(0.95); }
      </style>
  </head>
  <body>
      <h2>VLESS URI</h2>
      <div class="box">
          <pre id="vless">${vlessMain}</pre>
          <button onclick="copy('vless')">Copy</button>
      </div>

      <h2>Clash Meta (YAML)</h2>
      <div class="box">
          <pre id="clash">${clashConfig.trim()}</pre>
          <button onclick="copy('clash')">Copy</button>
      </div>

      <script>
          function copy(id) {
              navigator.clipboard.writeText(document.getElementById(id).innerText);
              alert('Copied!');
          }
      </script>
  </body>
  </html>`;
}
