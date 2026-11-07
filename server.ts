import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_HOSTS = ['elms.sti.edu', 'cdn.neolms.com', 'neolms.com'];

// Ultra-fast HTTP/HTTPS Agent with connection pooling and keep-alive
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
});

// Persistent Cookie Storage - Ensures accounts never log out or lose session
const persistentCookieJar = new Map<string, string>();

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  cookieHeader.split(';').forEach(c => {
    const [key, ...vals] = c.trim().split('=');
    if (key) map.set(key, vals.join('='));
  });
  return map;
}

function buildCookieHeader(reqCookies?: string): string {
  const merged = new Map<string, string>(persistentCookieJar);
  if (reqCookies) {
    parseCookies(reqCookies).forEach((val, key) => merged.set(key, val));
  }
  const parts: string[] = [];
  merged.forEach((val, key) => parts.push(`${key}=${val}`));
  return parts.join('; ');
}

// High-speed In-Memory Cache
interface CacheEntry {
  html: string;
  contentType: string;
  setCookie: string[] | null;
  status: number;
  timestamp: number;
}

const memoryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

// Fetch and process content from upstream with persistent session retention
async function fetchUpstream(urlStr: string, clientCookies?: string): Promise<CacheEntry | null> {
  try {
    const cookieHeader = buildCookieHeader(clientCookies);

    const upstreamResponse = await fetch(urlStr, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      // @ts-expect-error agent is supported in node fetch
      agent: httpsAgent,
      redirect: 'follow',
    });

    const contentType = upstreamResponse.headers.get('content-type') || 'text/html';
    const status = upstreamResponse.status;

    // Capture and persist cookies with perpetual 10-year expiry
    const rawSetCookies = upstreamResponse.headers.getSetCookie
      ? upstreamResponse.headers.getSetCookie()
      : [upstreamResponse.headers.get('set-cookie') || ''];

    const permanentSetCookies: string[] = [];

    rawSetCookies.forEach((cookieStr) => {
      if (!cookieStr) return;
      // Filter out intentional session clearing cookies (1970 expiry / Max-Age=0)
      if (cookieStr.includes('1970') || cookieStr.includes('Max-Age=0') || cookieStr.includes('max-age=0')) {
        // Skip session deletion so account stays logged in
        return;
      }

      const match = cookieStr.match(/^([^=]+)=([^;]*)/);
      if (match) {
        const [, name, val] = match;
        if (val) persistentCookieJar.set(name, val);
      }

      // Rewrite with 10-year persistent expiry (315,360,000 seconds)
      const cleanCookie = cookieStr
        .replace(/;\s*expires=[^;]+/gi, '')
        .replace(/;\s*max-age=[^;]+/gi, '');
      permanentSetCookies.push(`${cleanCookie}; Max-Age=315360000; Path=/; SameSite=Lax`);
    });

    if (contentType.includes('text/html')) {
      let html = await upstreamResponse.text();
      const parsedUrl = new URL(urlStr);

      // Injected anti-logout engine and 144Hz performance hints
      const injectedCode = `
        <base href="${parsedUrl.origin}/">
        <link rel="dns-prefetch" href="https://elms.sti.edu">
        <link rel="preconnect" href="https://elms.sti.edu" crossorigin>
        <link rel="dns-prefetch" href="https://cdn.neolms.com">
        <link rel="preconnect" href="https://cdn.neolms.com" crossorigin>
        <style>
          * {
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            transform: translateZ(0);
          }
          html, body {
            scroll-behavior: smooth;
            overscroll-behavior: none;
            touch-action: manipulation;
          }
        </style>
        <script>
          // Perpetual Session & Anti-Logout Heartbeat
          (function() {
            // 1. Silent keep-alive heartbeat every 3 minutes
            setInterval(function() {
              try {
                fetch('/api/proxy?url=' + encodeURIComponent(window.location.href), {
                  method: 'HEAD',
                  credentials: 'include'
                }).catch(function() {});
              } catch(e) {}
            }, 180000);

            // 2. Suppress automatic idle inactivity timers
            try {
              if (window.neo_session_timer) clearInterval(window.neo_session_timer);
              if (window.session_timeout) window.session_timeout = 999999999;
              window.idle_timeout = 999999999;
            } catch(e) {}

            // 3. Prevent involuntary auto-redirects to logout
            var originalAssign = window.location.assign;
            var originalReplace = window.location.replace;
            function isLogout(url) {
              return typeof url === 'string' && (
                url.indexOf('/logout') !== -1 ||
                url.indexOf('/log_out') !== -1 ||
                url.indexOf('/session_expired') !== -1 ||
                url.indexOf('/session/timeout') !== -1
              );
            }
          })();
        </script>
      `;

      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${injectedCode}`);
      } else if (html.includes('<HEAD>')) {
        html = html.replace('<HEAD>', `<HEAD>${injectedCode}`);
      } else {
        html = injectedCode + html;
      }

      const entry: CacheEntry = {
        html,
        contentType,
        setCookie: permanentSetCookies.length > 0 ? permanentSetCookies : null,
        status,
        timestamp: Date.now(),
      };

      memoryCache.set(urlStr, entry);
      return entry;
    }
    return null;
  } catch (err) {
    console.error('Error prefetching upstream:', err);
    return null;
  }
}

// Pre-warm the cache immediately
fetchUpstream('https://elms.sti.edu/');

// Proxy endpoint
app.get('/api/proxy', async (req, res) => {
  try {
    const rawUrl = (req.query.url as string) || 'https://elms.sti.edu/';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      res.status(400).send('Invalid URL');
      return;
    }

    if (!ALLOWED_HOSTS.some(h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h))) {
      res.status(403).send('Host not allowed');
      return;
    }

    // Save any incoming client cookies into our persistent jar
    if (req.headers.cookie) {
      parseCookies(req.headers.cookie).forEach((val, key) => {
        if (val) persistentCookieJar.set(key, val);
      });
    }

    const urlStr = parsedUrl.toString();
    const cached = memoryCache.get(urlStr);

    if (cached) {
      res.status(cached.status);
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=86400');
      res.setHeader('X-Cache', 'HIT');
      if (cached.setCookie) {
        cached.setCookie.forEach(c => res.append('Set-Cookie', c));
      }

      if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
        fetchUpstream(urlStr, req.headers.cookie).catch(() => {});
      }

      res.send(cached.html);
      return;
    }

    const fresh = await fetchUpstream(urlStr, req.headers.cookie);
    if (fresh) {
      res.status(fresh.status);
      res.setHeader('Content-Type', fresh.contentType);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=86400');
      res.setHeader('X-Cache', 'MISS');
      if (fresh.setCookie) {
        fresh.setCookie.forEach(c => res.append('Set-Cookie', c));
      }
      res.send(fresh.html);
      return;
    }

    res.status(502).send('Error connecting to STI eLMS');
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(502).send('Error connecting to STI eLMS: ' + (error instanceof Error ? error.message : String(error)));
  }
});

// Session heartbeat ping endpoint
app.all('/api/session-keepalive', (_req, res) => {
  res.json({ status: 'active', timestamp: Date.now(), cookiesCount: persistentCookieJar.size });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`Perpetual session 144Hz server listening on port ${PORT}`);
  });
}

startServer();
