// ============================================
// XPLITLEAKS API - CLOUDFLARE WORKER v5.1
// Fixed: Schema alignment, logo/SVG/favicon support, config completeness
// ============================================

// In-memory cache for catalog stats (refreshes every 5 minutes)
let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Crawler user agents that need OG tags
const CRAWLER_UAS = [
  'telegrambot','facebookexternalhit','twitterbot','linkedinbot',
  'whatsapp','discordbot','slackbot','googlebot','bingbot',
  'applebot','yandexbot','duckduckbot','baiduspider',
  'embark','xayn','pinterestbot','redditbot','vkshare',
  'skypeuripreview','snapchat','mastodon','line','kakaotalk'
];

function isCrawler(request) {
  const ua = (request.headers.get('User-Agent') || '').toLowerCase();
  return CRAWLER_UAS.some(bot => ua.includes(bot));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ============================================
    // CORS HEADERS
    // ============================================
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id, X-Creator-Token, X-Admin-Token, Accept, X-Watch-History',
      'Access-Control-Max-Age': '86400',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    const errorResponse = (message, status = 400) =>
      jsonResponse({ error: message, status, timestamp: new Date().toISOString() }, status);

    const htmlResponse = (html, status = 200) =>
      new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });

    // ============================================
    // URL NORMALIZATION
    // ============================================
    function normalizeUrl(urlStr) {
      if (!urlStr || typeof urlStr !== 'string') return urlStr;
      urlStr = urlStr.trim();
      if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) return urlStr;
      if (urlStr.startsWith('//')) return 'https:' + urlStr;
      return 'https://' + urlStr.replace(/^\/+/, '');
    }

    function normalizeVideo(video) {
      if (!video) return video;
      return {
        ...video,
        videoUrl: normalizeUrl(video.videoUrl),
        thumbnail: normalizeUrl(video.thumbnail)
      };
    }

    // ============================================
    // AUTH HELPERS
    // ============================================
    const checkAdminAuth = () => {
      const auth = request.headers.get('Authorization')?.replace('Bearer ', '') ||
                  request.headers.get('X-Admin-Token');
      return auth === env.ADMIN_TOKEN;
    };

    const checkCreatorAuth = async () => {
      const token = request.headers.get('X-Creator-Token') ||
                   request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!token) return null;

      const creator = await env.DB.prepare(
        'SELECT * FROM creators WHERE token = ? AND status = \'approved\''
      ).bind(token).first();

      return creator;
    };

    const getSessionId = () =>
      request.headers.get('X-Session-Id') || crypto.randomUUID();

    const getClientIP = () =>
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')?.split(',')[0] ||
      'unknown';

    // ============================================
    // PARSE CLIENT-SIDE WATCH HISTORY
    // ============================================
    function parseClientHistory() {
      const header = request.headers.get('X-Watch-History');
      if (!header) return { watchedIds: [], recentIds: [], creatorCounts: {}, tagPrefs: {}, categoryPrefs: {} };

      try {
        const data = JSON.parse(header);
        return {
          watchedIds: data.watchedIds || [],
          recentIds: data.recentIds || [],
          creatorCounts: data.creatorCounts || {},
          tagPrefs: data.tagPrefs || {},
          categoryPrefs: data.categoryPrefs || {}
        };
      } catch (e) {
        return { watchedIds: [], recentIds: [], creatorCounts: {}, tagPrefs: {}, categoryPrefs: {} };
      }
    }

    // ============================================
    // CACHED CATALOG STATS (Reduces D1 reads)
    // ============================================
    async function getCatalogStats(env) {
      const now = Date.now();

      if (catalogCache && (now - catalogCacheTime) < CATALOG_CACHE_TTL) {
        return catalogCache;
      }

      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as totalShorts,
          COUNT(DISTINCT creatorId) as totalCreators
        FROM shorts
        WHERE status = 'active'
      `).first();

      catalogCache = {
        totalShorts: stats?.totalShorts || 0,
        totalCreators: stats?.totalCreators || 0,
        isSingleCreator: (stats?.totalCreators || 0) === 1,
        isSmallCatalog: (stats?.totalShorts || 0) <= 10,
        timestamp: now
      };
      catalogCacheTime = now;

      return catalogCache;
    }

    // ============================================
    // OG TAG HTML GENERATOR
    // ============================================
    // ALL content types use thumbnail-only preview (og:type='website')
    // No inline video player - users must click through to the site
    async function generateOGPage(title, description, image, videoUrl, type, contentId, videoWidth, videoHeight) {
      const siteName = 'Xplitleaks';
      const isShort = type === 'short';
      const pagePath = isShort ? 'shorts' : 'video';
      const pageUrl = `${url.origin}/${pagePath}.html?id=${contentId}`;
      const thumb = normalizeUrl(image) || '';

      // Content type label for the preview
      const contentLabel = isShort ? 'Short' : 'Video';

      // Use consistent large image dimensions for ALL content types
      // Telegram/Facebook show the same size preview regardless of content type
      const ogImageWidth = '1200';
      const ogImageHeight = '630';

      // Build OG tags - ALWAYS thumbnail-only preview for all content types
      // Using og:type="website" prevents platforms from embedding inline video players
      const ogTags = `
  <meta property="og:title" content="${escapeHtml(title)} - ${siteName}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${thumb}">
  <meta property="og:image:width" content="${ogImageWidth}">
  <meta property="og:image:height" content="${ogImageHeight}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${siteName}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)} - ${siteName}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${thumb}">
  <meta name="twitter:site" content="@xplitleaks">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="xplitleaks:content_type" content="${isShort ? 'short' : 'video'}">
  <meta name="xplitleaks:content_label" content="${contentLabel}">`;

      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - ${siteName}</title>${ogTags}
  <link rel="canonical" href="${pageUrl}">
  <style>body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:40px}a{color:#ff0050;text-decoration:none;font-size:18px}</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  ${thumb ? `<img src="${thumb}" style="max-width:480px;border-radius:12px;margin:20px auto;display:block;">` : ''}
  <p><a href="${pageUrl}">Watch on ${siteName}</a></p>
</body>
</html>`;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // ============================================
    // STATIC FILE SERVING WITH OG INJECTION
    // ============================================
    async function serveStaticWithOG(pathname) {
      if (!env.BUCKET) return null;

      const obj = await env.BUCKET.get(pathname.replace(/^\//, ''));
      if (!obj) return null;

      const html = await obj.text();

      // Only inject OG tags for crawlers on video/short pages
      if (!isCrawler(request)) {
        return new Response(html, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'text/html',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      // Check for video ID in query
      const videoId = url.searchParams.get('id');
      if (!videoId) {
        return new Response(html, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'text/html',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      // Determine content type from path
      const isShort = pathname.includes('shorts');
      const isVideo = pathname.includes('video');

      if (!isShort && !isVideo) {
        return new Response(html, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'text/html',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      // Fetch content data from D1
      const table = isShort ? 'shorts' : 'videos';
      const content = await env.DB.prepare(`
        SELECT * FROM ${table}
        WHERE (numericId = ? OR id = ?) AND status = 'active'
      `).bind(videoId, videoId).first();

      if (!content) {
        return new Response(html, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'text/html',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      // Generate OG page - ALWAYS thumbnail-only preview
      const ogHtml = await generateOGPage(
        content.title || (isShort ? 'Short Video' : 'Video'),
        content.description || `Watch ${content.title || 'this video'} on Xplitleaks`,
        content.thumbnail,
        null,  // No video URL needed for thumbnail-only previews
        isShort ? 'short' : 'video',
        content.numericId || content.id
      );

      return htmlResponse(ogHtml);
    }

    // ============================================
    // MAIN ROUTER
    // ============================================
    try {

      // ============================================
      // STATIC FILES + OG TAGS (Non-API routes)
      // ============================================
      if (!path.startsWith('/api/')) {
        // ============================================
        // GITHUB PAGES PROXY + OG INJECTION FOR CRAWLERS
        // ============================================

        const GITHUB_PAGES_URL = 'https://dylan-404-max.github.io/frame';

        // For crawlers on video/short pages, fetch from GitHub Pages and inject OG tags
        if (isCrawler(request) && (path.includes('video') || path.includes('shorts'))) {
          const videoId = url.searchParams.get('id');

          if (videoId) {
            // Fetch the HTML from GitHub Pages
            const ghUrl = GITHUB_PAGES_URL + path + url.search;
            const ghResponse = await fetch(ghUrl, {
              headers: { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' }
            });

            if (ghResponse.ok) {
              let html = await ghResponse.text();

              // Determine content type and fetch from D1
              const isShort = path.includes('shorts');
              const table = isShort ? 'shorts' : 'videos';

              const content = await env.DB.prepare(`
                SELECT title, description, thumbnail, videoUrl, numericId, id
                FROM ${table}
                WHERE (numericId = ? OR id = ?) AND status = 'active'
              `).bind(videoId, videoId).first();

              if (content) {
                const siteName = 'Xplitleaks';
                const title = escapeHtml(content.title || (isShort ? 'Short Video' : 'Video'));
                const description = escapeHtml(content.description || `Watch ${content.title || 'this video'} on ${siteName}`);
                const thumb = normalizeUrl(content.thumbnail) || '';
                const videoUrl = normalizeUrl(content.videoUrl) || '';
                const pageUrl = url.href;
                const contentId = content.numericId || content.id;

                // Detect if this is a short based on the path or content type
                const contentType = isShort ? 'short' : 'video';

                // ALL content uses thumbnail-only preview (og:type='website')
                // No inline video player - users must click through to the site
                const ogType = 'website';
                const contentLabel = isShort ? 'Short' : 'Video';

                // Consistent large image dimensions for all content types
                const ogImageWidth = '1200';
                const ogImageHeight = '630';

                // Build OG tags - ALWAYS thumbnail-only for all content types
                let ogTags = `
  <meta property="og:title" content="${title} - ${siteName}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${thumb}">
  <meta property="og:image:width" content="${ogImageWidth}">
  <meta property="og:image:height" content="${ogImageHeight}">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="${siteName}">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title} - ${siteName}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${thumb}">
  <meta name="description" content="${description}">
  <meta name="xplitleaks:content_type" content="${contentType}">
  <meta name="xplitleaks:content_label" content="${contentLabel}">
  <title>${title} - ${siteName}</title>`;

                // Remove existing dynamic OG meta tags and title to avoid duplicates
                html = html.replace(/<meta[^>]*id="ogTitle"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="ogDescription"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="ogImage"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="ogUrl"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="twitterTitle"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="twitterDescription"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="twitterImage"[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*id="metaDescription"[^>]*>/gi, '');
                html = html.replace(/<title[^>]*>.*?<\/title>/gi, '');

                // Inject OG tags after <head>
                html = html.replace('<head>', '<head>' + ogTags);

                return new Response(html, {
                  status: 200,
                  headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'public, max-age=300',
                    'X-OG-Injected': 'true'
                  }
                });
              }
            }
          }
        }

        // For all other requests (non-crawlers or non-video pages), proxy to GitHub Pages
        const proxyUrl = GITHUB_PAGES_URL + path + url.search;
        const proxyResponse = await fetch(proxyUrl, {
          headers: {
            'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
            'Accept': request.headers.get('Accept') || '*/*'
          }
        });

        if (proxyResponse.ok) {
          // Clone the response to modify headers if needed
          const newHeaders = new Headers(proxyResponse.headers);
          newHeaders.set('X-Proxy-By', 'Xplitleaks-Worker');

          return new Response(proxyResponse.body, {
            status: proxyResponse.status,
            statusText: proxyResponse.statusText,
            headers: newHeaders
          });
        }

        // Fallback to original R2 static serving if GitHub Pages fails
        const staticResponse = await serveStaticWithOG(path);
        if (staticResponse) return staticResponse;

        return errorResponse('Not found', 404);
      }

      // ============================================
      // PUBLIC ENDPOINTS
      // ============================================

      if (path === '/api/health' && method === 'GET') {
        return jsonResponse({
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '5.1.0'
        });
      }

      // ----- Config (includes branding/logo/favicon) -----
      if (path === '/api/config' && method === 'GET') {
        const config = await env.DB.prepare(
          `SELECT siteName, siteLogo, siteLogoSvg, faviconUrl, siteDescription, defaultOgImage,
            vastTagUrl, outstreamAdTags, placementUrls, primaryColor, r2PublicUrl, registrationEnabled
          FROM site_config WHERE id = 1`
        ).first();

        return jsonResponse(config || {
          siteName: 'Xplitleaks',
          siteLogo: null,
          siteLogoSvg: '',
          faviconUrl: '',
          siteDescription: '',
          defaultOgImage: '',
          vastTagUrl: null,
          placementUrls: '[]',
          outstreamAdTags: '[]',
          primaryColor: '#ff0050',
          r2PublicUrl: null,
          registrationEnabled: true
        });
      }

      if (path === '/api/categories' && method === 'GET') {
        const categories = await env.DB.prepare('SELECT * FROM categories ORDER BY sortOrder, name').all();
        const tags = await env.DB.prepare('SELECT * FROM tags ORDER BY name').all();
        return jsonResponse({
          categories: categories.results || [],
          tags: tags.results || []
        });
      }

      // ============================================
      // VIDEO ENDPOINTS
      // ============================================

      if (path === '/api/videos' && method === 'GET') {
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const limit = Math.min(50, parseInt(url.searchParams.get('limit')) || 15);
        const offset = (page - 1) * limit;
        const search = url.searchParams.get('search') || '';
        const category = url.searchParams.get('category') || 'all';

        let whereClause = "WHERE v.status = 'active'";
        const params = [];

        if (search) {
          whereClause += ' AND (v.title LIKE ? OR v.description LIKE ?)';
          params.push(`%${search}%`, `%${search}%`);
        }

        if (category && category !== 'all') {
          whereClause += ' AND v.category = ?';
          params.push(category);
        }

        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) as total FROM videos v ${whereClause}`
        ).bind(...params).first();

        const { results } = await env.DB.prepare(`
          SELECT
            v.id, v.numericId, v.title, v.videoUrl, v.thumbnail, v.duration,
            v.uploadDate, v.category, v.tags, v.description, v.creatorId,
            v.type, v.status, v.addedAt, v.updatedAt,
            c.username as creatorName,
            CASE
              WHEN v.realViews >= 1000 THEN v.views
              ELSE v.fakeViews + v.realViews
            END as displayViews,
            v.views, v.realViews, v.fakeViews
          FROM videos v
          LEFT JOIN creators c ON v.creatorId = c.id
          ${whereClause}
          ORDER BY v.addedAt DESC
          LIMIT ? OFFSET ?
        `).bind(...params, limit, offset).all();

        return jsonResponse({
          videos: (results || []).map(normalizeVideo),
          pagination: {
            page, limit,
            total: countResult?.total || 0,
            totalPages: Math.ceil((countResult?.total || 0) / limit)
          }
        });
      }

      if (path === '/api/videos/related' && method === 'GET') {
        const videoId = url.searchParams.get('videoId') || '';
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const limit = Math.min(24, parseInt(url.searchParams.get('limit')) || 12);
        const offset = (page - 1) * limit;
        const category = url.searchParams.get('category') || '';

        let videoCategory = category;
        if (videoId) {
          const vidInfo = await env.DB.prepare(
            'SELECT category FROM videos WHERE numericId = ? OR id = ?'
          ).bind(videoId, videoId).first();
          if (vidInfo) videoCategory = vidInfo.category;
        }

        let whereClause = "WHERE v.status = 'active'";
        const params = [];

        if (videoId) {
          whereClause += ' AND v.numericId != ? AND v.id != ?';
          params.push(videoId, videoId);
        }

        let orderClause = 'ORDER BY v.addedAt DESC';
        if (videoCategory) {
          orderClause = `ORDER BY CASE WHEN v.category = ? THEN 0 ELSE 1 END, v.addedAt DESC`;
          params.push(videoCategory);
        }

        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) as total FROM videos v ${whereClause}`
        ).bind(...params).first();

        const { results } = await env.DB.prepare(`
          SELECT
            v.id, v.numericId, v.title, v.videoUrl, v.thumbnail,
            v.duration, v.uploadDate, v.category, v.addedAt,
            c.username as creatorName,
            CASE
              WHEN v.realViews >= 1000 THEN v.views
              ELSE v.fakeViews + v.realViews
            END as displayViews,
            v.views
          FROM videos v
          LEFT JOIN creators c ON v.creatorId = c.id
          ${whereClause}
          ${orderClause}
          LIMIT ? OFFSET ?
        `).bind(...params, limit, offset).all();

        return jsonResponse({
          videos: (results || []).map(normalizeVideo),
          pagination: {
            page, limit,
            total: countResult?.total || 0,
            totalPages: Math.ceil((countResult?.total || 0) / limit)
          }
        });
      }

      if (path.match(/^\/api\/video\/[a-zA-Z0-9_-]+$/) && method === 'GET') {
        const id = path.split('/')[3];

        let video = await env.DB.prepare(`
          SELECT
            v.*, c.username as creatorName,
            CASE
              WHEN v.realViews >= 1000 THEN v.views
              ELSE v.fakeViews + v.realViews
            END as displayViews
          FROM videos v
          LEFT JOIN creators c ON v.creatorId = c.id
          WHERE (v.numericId = ? OR v.id = ?) AND v.status = 'active'
        `).bind(id, id).first();

        if (!video) {
          return errorResponse('Video not found', 404);
        }

        ctx.waitUntil(
          env.DB.prepare(`
            UPDATE videos SET views = views + 1, realViews = realViews + 1
            WHERE numericId = ?
          `).bind(id).run()
        );

        return jsonResponse(normalizeVideo(video));
      }

      if (path === '/api/video/view' && method === 'POST') {
        const { videoId, watchDuration } = await request.json().catch(() => ({}));
        const sessionId = getSessionId();

        if (!videoId) {
          return errorResponse('Video ID required', 400);
        }

        await env.DB.prepare(`
          INSERT INTO video_views (videoId, sessionId, watchDuration, ipAddress, viewedAt)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).bind(videoId, sessionId, watchDuration || 0, getClientIP()).run();

        return jsonResponse({ success: true });
      }

      // ============================================
      // SHORTS ENDPOINTS
      // ============================================

      if (path === '/api/shorts' && method === 'GET') {
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const limit = Math.min(50, parseInt(url.searchParams.get('limit')) || 15);
        const offset = (page - 1) * limit;
        const excludeIds = url.searchParams.get('exclude')?.split(',').filter(Boolean) || [];

        let whereClause = "WHERE s.status = 'active'";
        const params = [];

        if (excludeIds.length > 0) {
          const placeholders = excludeIds.map(() => '?').join(',');
          whereClause += ` AND s.numericId NOT IN (${placeholders})`;
          params.push(...excludeIds);
        }

        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) as total FROM shorts s ${whereClause}`
        ).bind(...params).first();

        const { results } = await env.DB.prepare(`
          SELECT
            s.*, c.username as creatorName,
            CASE
              WHEN s.realViews >= 1000 THEN s.views
              ELSE s.fakeViews + s.realViews
            END as displayViews
          FROM shorts s
          LEFT JOIN creators c ON s.creatorId = c.id
          ${whereClause}
          ORDER BY s.engagementScore DESC, s.views DESC
          LIMIT ? OFFSET ?
        `).bind(...params, limit, offset).all();

        return jsonResponse({
          shorts: (results || []).map(normalizeVideo),
          pagination: {
            page, limit,
            total: countResult?.total || 0,
            totalPages: Math.ceil((countResult?.total || 0) / limit)
          }
        });
      }

      // ============================================
      // ADVANCED SHORTS RECOMMENDATION v5.1
      // Client-Side History + Smart Rotation
      // ============================================
      if (path === '/api/shorts/recommend' && method === 'GET') {
        const sessionId = getSessionId();
        const limit = Math.min(50, parseInt(url.searchParams.get('limit')) || 10);
        const excludeIds = url.searchParams.get('exclude')?.split(',').filter(Boolean) || [];
        const currentId = url.searchParams.get('currentId') || null;

        const clientHistory = parseClientHistory();
        const watchedIds = clientHistory.watchedIds || [];
        const recentIds = clientHistory.recentIds || [];
        const creatorCounts = clientHistory.creatorCounts || {};
        const userTags = clientHistory.tagPrefs || {};
        const userCategories = clientHistory.categoryPrefs || {};

        const catalog = await getCatalogStats(env);

        const excludeCurrent = [...excludeIds];
        if (currentId) excludeCurrent.push(currentId);

        let recentToExclude = [];
        if (!catalog.isSmallCatalog) {
          recentToExclude = recentIds.slice(0, 5);
        }
        const allExcluded = [...new Set([...excludeCurrent, ...recentToExclude])];

        let query = `
          SELECT
            s.*, c.username as creatorName,
            COALESCE((s.likes * 2 + s.shares * 3) / MAX(s.views, 1), 0) as engagementRate,
            CASE
              WHEN s.realViews >= 1000 THEN s.views
              ELSE s.fakeViews + s.realViews
            END as displayViews,
            COALESCE(julianday('now') - julianday(s.addedAt), 0) as ageDays
          FROM shorts s
          LEFT JOIN creators c ON s.creatorId = c.id
          WHERE s.status = 'active'
        `;

        const params = [];

        if (allExcluded.length > 0) {
          const placeholders = allExcluded.map(() => '?').join(',');
          query += ` AND s.numericId NOT IN (${placeholders})`;
          params.push(...allExcluded);
        }

        query += ` ORDER BY s.addedAt DESC LIMIT 200`;

        const { results: candidates } = await env.DB.prepare(query).bind(...params).all();

        if (!candidates || candidates.length === 0) {
          const fallbackQuery = `
            SELECT
              s.*, c.username as creatorName,
              COALESCE((s.likes * 2 + s.shares * 3) / MAX(s.views, 1), 0) as engagementRate,
              CASE
                WHEN s.realViews >= 1000 THEN s.views
                ELSE s.fakeViews + s.realViews
              END as displayViews,
              COALESCE(julianday('now') - julianday(s.addedAt), 0) as ageDays
            FROM shorts s
            LEFT JOIN creators c ON s.creatorId = c.id
            WHERE s.status = 'active'
            ${excludeIds.length > 0 ? `AND s.numericId NOT IN (${excludeIds.map(() => '?').join(',')})` : ''}
            ORDER BY s.addedAt DESC
            LIMIT 200
          `;
          const fallback = await env.DB.prepare(fallbackQuery)
            .bind(...(excludeIds.length > 0 ? excludeIds : []))
            .all();

          if (!fallback.results || fallback.results.length === 0) {
            return jsonResponse([]);
          }

          return jsonResponse(scoreAndRank(
            fallback.results, watchedIds, recentIds, creatorCounts,
            userTags, userCategories, catalog, limit
          ).map(normalizeVideo));
        }

        const scored = scoreAndRank(
          candidates, watchedIds, recentIds, creatorCounts,
          userTags, userCategories, catalog, limit
        );

        return jsonResponse(scored.map(normalizeVideo));
      }

      // ============================================
      // SCORING FUNCTION - Smart Rotation Algorithm
      // ============================================
      function scoreAndRank(candidates, watchedIds, recentIds, creatorCounts, userTags, userCategories, catalog, limit) {
        const maxAge = Math.max(...candidates.map(c => c.ageDays || 0));
        const minAge = Math.min(...candidates.map(c => c.ageDays || 0));
        const ageRange = Math.max(1, maxAge - minAge);

        const watchFreq = {};
        watchedIds.forEach(id => {
          watchFreq[id] = (watchFreq[id] || 0) + 1;
        });

        const recentPosition = {};
        recentIds.forEach((id, idx) => {
          recentPosition[id] = idx;
        });

        const scored = candidates.map(short => {
          const id = short.numericId || short.id;
          const creatorId = short.creatorId || 'unknown';
          let score = 0;

          const timesWatched = watchFreq[id] || 0;
          if (timesWatched === 0) {
            score += 60;
          } else if (timesWatched === 1) {
            score += 30;
          } else if (timesWatched === 2) {
            score += 10;
          } else {
            score += 0;
          }

          const recentIdx = recentPosition[id];
          if (recentIdx !== undefined) {
            if (recentIdx < 5) {
              score -= 50;
            } else if (recentIdx < 20) {
              score -= 20;
            } else {
              score -= 5;
            }
          }

          const creatorShownCount = creatorCounts[creatorId] || 0;
          if (catalog.isSingleCreator) {
            score += 0;
          } else if (catalog.isSmallCatalog) {
            if (creatorShownCount > 10) {
              score -= (creatorShownCount - 10) * 2;
            }
          } else {
            if (creatorShownCount > 5) {
              score -= (creatorShownCount - 5) * 3;
            }
          }

          const ageDays = short.ageDays || 0;
          const freshnessScore = 1 - ((ageDays - minAge) / ageRange);
          score += freshnessScore * 15;

          const engagementRate = Math.min(short.engagementRate || 0, 1);
          score += engagementRate * 10;

          let tagScore = 0;
          let categoryScore = 0;

          try {
            const tags = short.tags ? JSON.parse(short.tags) : [];
            if (tags.length > 0 && Object.keys(userTags).length > 0) {
              const matchCount = tags.filter(t => userTags[t]).length;
              tagScore = (matchCount / tags.length) * 20;
            }
          } catch (e) {}

          if (short.category && userCategories[short.category]) {
            categoryScore = Math.min(userCategories[short.category], 1) * 15;
          }

          if (Object.keys(userTags).length > 0 || Object.keys(userCategories).length > 0) {
            score += tagScore + categoryScore;
          } else {
            score += engagementRate * 15 + freshnessScore * 10;
          }

          const jitter = (Math.random() - 0.5) * 0.2 * Math.abs(score);
          score += jitter;

          return { ...short, score };
        });

        scored.sort((a, b) => b.score - a.score);

        const selected = [];
        const resultCreatorCounts = {};
        const maxPerCreator = catalog.isSingleCreator ? 100 :
                             catalog.isSmallCatalog ? 10 : 5;

        for (const short of scored) {
          const creatorId = short.creatorId || 'unknown';
          const currentCount = resultCreatorCounts[creatorId] || 0;

          if (currentCount < maxPerCreator) {
            resultCreatorCounts[creatorId] = currentCount + 1;
            selected.push(short);
            if (selected.length >= limit) break;
          }
        }

        if (selected.length < limit) {
          const selectedIds = new Set(selected.map(s => s.numericId || s.id));
          for (const short of scored) {
            if (!selectedIds.has(short.numericId || short.id)) {
              selected.push(short);
              if (selected.length >= limit) break;
            }
          }
        }

        return selected;
      }

      // Get Single Short
      if (path.match(/^\/api\/short\/[a-zA-Z0-9_-]+$/) && method === 'GET') {
        const id = path.split('/')[3];

        let short = await env.DB.prepare(`
          SELECT
            s.*, c.username as creatorName,
            CASE
              WHEN s.realViews >= 1000 THEN s.views
              ELSE s.fakeViews + s.realViews
            END as displayViews
          FROM shorts s
          LEFT JOIN creators c ON s.creatorId = c.id
          WHERE (s.numericId = ? OR s.id = ?) AND s.status = 'active'
        `).bind(id, id).first();

        if (!short) {
          return errorResponse('Short not found', 404);
        }

        ctx.waitUntil(
          env.DB.prepare(`
            UPDATE shorts SET views = views + 1, realViews = realViews + 1
            WHERE numericId = ?
          `).bind(id).run()
        );

        return jsonResponse(normalizeVideo(short));
      }

      // Track Short View
      if (path === '/api/short/view' && method === 'POST') {
        const { shortId, watchDuration, watchTime } = await request.json().catch(() => ({}));
        const sessionId = getSessionId();

        if (!shortId) {
          return errorResponse('Short ID required', 400);
        }

        const shouldTrack = watchDuration >= 0.5 || watchTime >= 15 || watchDuration >= 0.9;

        if (!shouldTrack) {
          return jsonResponse({ success: true, tracked: false, reason: 'threshold_not_met' });
        }

        const action = watchDuration >= 0.9 ? 'complete' : 'view';

        await env.DB.prepare(`
          INSERT INTO short_interactions (shortId, sessionId, action, metadata, ipAddress, timestamp)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).bind(shortId, sessionId, action, JSON.stringify({ watchDuration, watchTime }), getClientIP()).run();

        return jsonResponse({ success: true, tracked: true });
      }

      // Like/Unlike Short
      if (path === '/api/short/like' && method === 'POST') {
        const { shortId } = await request.json().catch(() => ({}));
        const sessionId = getSessionId();

        if (!shortId) {
          return errorResponse('Short ID required', 400);
        }

        const existing = await env.DB.prepare(
          'SELECT * FROM short_interactions WHERE shortId = ? AND sessionId = ? AND action = \'like\''
        ).bind(shortId, sessionId).first();

        if (existing) {
          await env.DB.prepare('DELETE FROM short_interactions WHERE id = ?').bind(existing.id).run();
          await env.DB.prepare('UPDATE shorts SET likes = MAX(likes - 1, 0) WHERE numericId = ?').bind(shortId).run();
          return jsonResponse({ success: true, action: 'unliked' });
        } else {
          await env.DB.prepare(`
            INSERT INTO short_interactions (shortId, sessionId, action, ipAddress, timestamp)
            VALUES (?, ?, 'like', ?, datetime('now'))
          `).bind(shortId, sessionId, getClientIP()).run();
          await env.DB.prepare('UPDATE shorts SET likes = likes + 1 WHERE numericId = ?').bind(shortId).run();
          return jsonResponse({ success: true, action: 'liked' });
        }
      }

      // ============================================
      // REPORT ENDPOINT
      // ============================================
      if (path === '/api/report' && method === 'POST') {
        const { contentId, contentType, reason, details, reporterEmail, reporterName, reporterPhone } =
            await request.json().catch(() => ({}));

        if (!contentId || !contentType || !reason) {
          return errorResponse('Missing required fields', 400);
        }

        if (reporterEmail && !reporterEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
          return errorResponse('Invalid email format', 400);
        }

        await env.DB.prepare(`
          INSERT INTO reports (contentId, contentType, reason, details,
            reporterEmail, reporterName, reporterPhone, reporterSession, status, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
        `).bind(contentId, contentType, reason, details || '',
            reporterEmail || null, reporterName || null, reporterPhone || null,
            getSessionId()).run();

        return jsonResponse({ success: true, message: 'Report submitted successfully' });
      }

      // ============================================
      // CREATOR AUTHENTICATION
      // ============================================

      if (path === '/api/creator/signup' && method === 'POST') {
        const data = await request.json().catch(() => ({}));

        if (!data.username || !data.email || !data.password) {
          return errorResponse('Username, email, and password required', 400);
        }

        // Validate username and email format
        if (data.username.length > 50) {
          return errorResponse('Username too long (max 50 chars)', 400);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
          return errorResponse('Invalid email format', 400);
        }

        const existing = await env.DB.prepare(
          'SELECT * FROM creators WHERE email = ? OR username = ?'
        ).bind(data.email, data.username).first();

        if (existing) {
          return errorResponse('Email or username already exists', 409);
        }

        const token = crypto.randomUUID();
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO creators (username, email, password, token, status, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).bind(data.username, data.email, data.password, token, now, now).run();

        return jsonResponse({
          success: true,
          message: 'Signup successful. Waiting for admin approval.',
          token
        });
      }

      if (path === '/api/creator/login' && method === 'POST') {
        const data = await request.json().catch(() => ({}));

        const creator = await env.DB.prepare(
          'SELECT * FROM creators WHERE (email = ? OR username = ?) AND password = ? AND status = \'approved\''
        ).bind(data.email || data.username, data.username || data.email, data.password).first();

        if (!creator) {
          return errorResponse('Invalid credentials or account not approved', 401);
        }

        await env.DB.prepare(
          'UPDATE creators SET lastLogin = datetime(\'now\') WHERE id = ?'
        ).bind(creator.id).run();

        return jsonResponse({
          success: true,
          token: creator.token,
          username: creator.username,
          email: creator.email
        });
      }

      if (path === '/api/creator/profile' && method === 'GET') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const videoCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM videos WHERE creatorId = ?'
        ).bind(creator.id).first();

        const shortCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM shorts WHERE creatorId = ?'
        ).bind(creator.id).first();

        const totalViews = await env.DB.prepare(`
          SELECT COALESCE(SUM(realViews), 0) as views FROM videos WHERE creatorId = ?
        `).bind(creator.id).first();

        return jsonResponse({
          ...creator,
          password: undefined,
          stats: {
            videos: videoCount?.count || 0,
            shorts: shortCount?.count || 0,
            totalViews: totalViews?.views || 0
          }
        });
      }

      // ============================================
      // CREATOR UPLOADS
      // ============================================

      if (path === '/api/creator/upload/video' && method === 'POST') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const data = await request.json().catch(() => ({}));

        if (!data.title || !data.videoUrl) {
          return errorResponse('Title and videoUrl required', 400);
        }

        const maxIdResult = await env.DB.prepare(
          'SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM videos'
        ).first();
        const maxId = maxIdResult?.maxId || 0;
        const numericId = String(maxId + 1).padStart(6, '0');
        const urlFriendlyId = data.title.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .substring(0, 50) || `video-${numericId}`;

        const now = new Date().toISOString();
        const fakeViews = Math.floor(Math.random() * 99000) + 1000;

        await env.DB.prepare(`
          INSERT INTO videos (id, numericId, title, videoUrl, thumbnail, duration,
            category, tags, description, creatorId, creatorName, uploadDate, type, views, realViews, fakeViews, status, addedAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).bind(urlFriendlyId, numericId, data.title, data.videoUrl, data.thumbnail || '',
            data.duration || '0:00', data.category || 'uncategorized', JSON.stringify(data.tags || []),
            data.description || '', creator.id, creator.username, data.uploadDate || now.split('T')[0], data.type || 'r2',
            fakeViews, 0, fakeViews, now, now).run();

        if (data.tags && Array.isArray(data.tags)) {
          for (const tag of data.tags) {
            await env.DB.prepare(`
              INSERT INTO tags (name, slug, usageCount) VALUES (?, ?, 1)
              ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
            `).bind(tag.toLowerCase(), tag.toLowerCase()).run();
          }
        }

        return jsonResponse({ success: true, numericId, id: urlFriendlyId });
      }

      if (path === '/api/creator/upload/short' && method === 'POST') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const data = await request.json().catch(() => ({}));

        if (!data.title || !data.videoUrl) {
          return errorResponse('Title and videoUrl required', 400);
        }

        const maxIdResult = await env.DB.prepare(
          'SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM shorts'
        ).first();
        const maxId = maxIdResult?.maxId || 0;
        const numericId = String(maxId + 1).padStart(6, '0');
        const shortId = `short-${numericId}`;
        const now = new Date().toISOString();
        const fakeViews = Math.floor(Math.random() * 99000) + 1000;

        await env.DB.prepare(`
          INSERT INTO shorts (id, numericId, title, videoUrl, thumbnail, duration,
            category, tags, creatorId, creatorName, uploadDate, views, realViews, fakeViews,
            likes, shares, engagementScore, status, addedAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0.0, 'active', ?, ?)
        `).bind(shortId, numericId, data.title, data.videoUrl, data.thumbnail || '',
            data.duration || '0:00', data.category || 'uncategorized', JSON.stringify(data.tags || []),
            creator.id, creator.username, data.uploadDate || now.split('T')[0], fakeViews, 0, fakeViews, now, now).run();

        if (data.tags && Array.isArray(data.tags)) {
          for (const tag of data.tags) {
            await env.DB.prepare(`
              INSERT INTO tags (name, slug, usageCount) VALUES (?, ?, 1)
              ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
            `).bind(tag.toLowerCase(), tag.toLowerCase()).run();
          }
        }

        return jsonResponse({ success: true, numericId });
      }

      if (path === '/api/creator/content' && method === 'GET') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const type = url.searchParams.get('type') || 'all';

        let videos = [], shorts = [];

        if (type === 'all' || type === 'videos') {
          const { results } = await env.DB.prepare(`
            SELECT *, CASE WHEN realViews >= 1000 THEN views ELSE fakeViews + realViews END as displayViews
            FROM videos WHERE creatorId = ? ORDER BY addedAt DESC
          `).bind(creator.id).all();
          videos = results || [];
        }

        if (type === 'all' || type === 'shorts') {
          const { results } = await env.DB.prepare(`
            SELECT *, CASE WHEN realViews >= 1000 THEN views ELSE fakeViews + realViews END as displayViews
            FROM shorts WHERE creatorId = ? ORDER BY addedAt DESC
          `).bind(creator.id).all();
          shorts = results || [];
        }

        return jsonResponse({
          videos: videos.map(normalizeVideo),
          shorts: shorts.map(normalizeVideo)
        });
      }

      // ============================================
      // R2 File Upload
      // ============================================
      if (path === '/api/upload/file' && method === 'POST') {
        const creator = await checkCreatorAuth();
        const isAdmin = checkAdminAuth();

        if (!creator && !isAdmin) {
          return errorResponse('Unauthorized', 401);
        }

        try {
          const formData = await request.formData();
          const file = formData.get('file');
          const storagePath = formData.get('path') || 'uploads';
          const filename = formData.get('filename');

          if (!file) {
            return errorResponse('No file provided', 400);
          }

          if (!env.BUCKET) {
            return errorResponse('R2 Bucket not configured', 500);
          }

          const finalFilename = filename || `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
          const key = `${storagePath}/${finalFilename}`;

          const object = await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'application/octet-stream' }
          });

          let r2Host = (env.R2_PUBLIC_URL || '').trim();
          r2Host = r2Host.replace(/^https?:\/\//, '');
          r2Host = r2Host.replace(/\/+$/, '');

          if (!r2Host) {
            return errorResponse('R2_PUBLIC_URL not configured', 500);
          }

          const publicUrl = `https://${r2Host}/${key}`;

          return jsonResponse({
            success: true, url: publicUrl, key: key, size: object.size, etag: object.etag
          });

        } catch (error) {
          console.error('R2 upload error:', error);
          return errorResponse('Upload failed: ' + error.message, 500);
        }
      }


      // ============================================
      // CREATOR CONTENT MANAGEMENT (Delete own content)
      // ============================================

      if (path === '/api/creator/video/delete' && method === 'DELETE') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('Video ID required', 400);

        // Verify ownership before deleting
        const video = await env.DB.prepare(
          'SELECT creatorId FROM videos WHERE numericId = ? OR id = ?'
        ).bind(id, id).first();

        if (!video) return errorResponse('Video not found', 404);
        if (video.creatorId !== creator.id) {
          return errorResponse('You can only delete your own content', 403);
        }

        await env.DB.prepare(`
          UPDATE videos SET status = 'removed', updatedAt = datetime('now')
          WHERE numericId = ? OR id = ?
        `).bind(id, id).run();

        return jsonResponse({ success: true, message: 'Video removed' });
      }

      if (path === '/api/creator/short/delete' && method === 'DELETE') {
        const creator = await checkCreatorAuth();
        if (!creator) {
          return errorResponse('Unauthorized', 401);
        }

        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('Short ID required', 400);

        // Verify ownership before deleting
        const short = await env.DB.prepare(
          'SELECT creatorId FROM shorts WHERE numericId = ? OR id = ?'
        ).bind(id, id).first();

        if (!short) return errorResponse('Short not found', 404);
        if (short.creatorId !== creator.id) {
          return errorResponse('You can only delete your own content', 403);
        }

        await env.DB.prepare(`
          UPDATE shorts SET status = 'removed', updatedAt = datetime('now')
          WHERE numericId = ? OR id = ?
        `).bind(id, id).run();

        return jsonResponse({ success: true, message: 'Short removed' });
      }

      // ============================================
      // ADMIN AUTH
      // ============================================

      // Admin login - single password/token approach
      if (path === '/api/admin/login' && method === 'POST') {
        const data = await request.json().catch(() => ({}));
        const { password } = data;

        if (!password) {
          return errorResponse('Password required', 400);
        }

        // Check against ADMIN_TOKEN env variable (simple single-password auth)
        if (password !== env.ADMIN_TOKEN) {
          return errorResponse('Invalid credentials', 401);
        }

        return jsonResponse({
          success: true,
          token: env.ADMIN_TOKEN,
          username: 'admin'
        });
      }

      // Admin verify
      if (path === '/api/admin/verify' && method === 'GET') {
        if (!checkAdminAuth()) {
          return errorResponse('Unauthorized', 401);
        }
        return jsonResponse({ valid: true, username: 'admin' });
      }

      // ============================================
      // ADMIN ENDPOINTS (require auth)
      // ============================================

      if (!checkAdminAuth()) {
        return errorResponse('Unauthorized', 401);
      }

      // Admin stats
      if (path === '/api/admin/stats' && method === 'GET') {
        const videoCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM videos WHERE status = \'active\''
        ).first();

        const shortCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM shorts WHERE status = \'active\''
        ).first();

        const iframeCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM videos WHERE type = \'iframe\' AND status = \'active\''
        ).first();

        const creatorCount = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM creators WHERE status = \'approved\''
        ).first();

        const pendingCreators = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM creators WHERE status = \'pending\''
        ).first();

        const totalVideoViews = await env.DB.prepare(
          'SELECT COALESCE(SUM(realViews), 0) as total FROM videos'
        ).first();

        const totalShortViews = await env.DB.prepare(
          'SELECT COALESCE(SUM(realViews), 0) as total FROM shorts'
        ).first();

        const totalRealViews = (totalVideoViews?.total || 0) + (totalShortViews?.total || 0);

        const pendingReports = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM reports WHERE status = \'pending\''
        ).first();

        const totalReports = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM reports'
        ).first();

        const dailyStats = await env.DB.prepare(`
          SELECT date(addedAt) as date, COUNT(*) as count, COALESCE(SUM(realViews), 0) as views
          FROM videos WHERE addedAt >= datetime('now', '-30 days')
          GROUP BY date(addedAt) ORDER BY date DESC LIMIT 30
        `).all();

        const dailyShortStats = await env.DB.prepare(`
          SELECT date(addedAt) as date, COUNT(*) as count, COALESCE(SUM(realViews), 0) as views
          FROM shorts WHERE addedAt >= datetime('now', '-30 days')
          GROUP BY date(addedAt) ORDER BY date DESC LIMIT 30
        `).all();

        return jsonResponse({
          overview: {
            totalVideos: videoCount?.count || 0,
            totalShorts: shortCount?.count || 0,
            totalIframes: iframeCount?.count || 0,
            totalCreators: creatorCount?.count || 0,
            pendingCreators: pendingCreators?.count || 0,
            totalViews: totalRealViews,
            totalReports: totalReports?.count || 0,
            pendingReports: pendingReports?.count || 0
          },
          dailyStats: dailyStats?.results || [],
          dailyShortStats: dailyShortStats?.results || [],
          viewLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          viewData: [1200, 1900, 1500, 2200, 2800, 3200, 2600]
        });
      }

      // Admin config - PUT (full update)
      if (path === '/api/admin/config' && method === 'PUT') {
        const data = await request.json().catch(() => ({}));

        if (!data || typeof data !== 'object') {
          return errorResponse('Invalid data format', 400);
        }

        const placementUrls = Array.isArray(data.placementUrls)
          ? JSON.stringify(data.placementUrls) : (data.placementUrls || '[]');
        const outstreamAdTags = Array.isArray(data.outstreamAdTags)
          ? JSON.stringify(data.outstreamAdTags) : (data.outstreamAdTags || '[]');

        try {
          await env.DB.prepare(`
            UPDATE site_config SET
              siteName = ?, siteLogo = ?, siteLogoSvg = ?, faviconUrl = ?,
              vastTagUrl = ?, placementUrls = ?, outstreamAdTags = ?,
              primaryColor = ?, r2PublicUrl = ?, registrationEnabled = ?,
              siteDescription = ?, updatedAt = datetime('now')
            WHERE id = 1
          `).bind(
            data.siteName || 'Xplitleaks',
            data.siteLogo || null,
            data.siteLogoSvg || '',
            data.faviconUrl || '',
            data.vastTagUrl || null,
            placementUrls,
            outstreamAdTags,
            data.primaryColor || '#ff0050',
            data.r2PublicUrl || null,
            data.registrationEnabled !== undefined ? (data.registrationEnabled ? 1 : 0) : 1,
            data.siteDescription || ''
          ).run();

          return jsonResponse({ success: true, message: 'Config updated' });
        } catch (error) {
          console.error('Config update error:', error);
          return errorResponse('Failed to update config: ' + error.message, 500);
        }
      }

      // Admin config - POST (partial/dynamic update)
      if (path === '/api/admin/config' && method === 'POST') {
        const body = await request.json().catch(() => ({}));

        const existing = await env.DB.prepare('SELECT id FROM site_config LIMIT 1').first();

        if (existing) {
          const updates = [];
          const params = [];
          if (body.siteName !== undefined) { updates.push('siteName = ?'); params.push(body.siteName); }
          if (body.primaryColor !== undefined) { updates.push('primaryColor = ?'); params.push(body.primaryColor); }
          if (body.siteLogo !== undefined) { updates.push('siteLogo = ?'); params.push(body.siteLogo); }
          if (body.siteLogoSvg !== undefined) { updates.push('siteLogoSvg = ?'); params.push(body.siteLogoSvg); }
          if (body.faviconUrl !== undefined) { updates.push('faviconUrl = ?'); params.push(body.faviconUrl); }
          if (body.siteDescription !== undefined) { updates.push('siteDescription = ?'); params.push(body.siteDescription); }
          if (body.r2PublicUrl !== undefined) { updates.push('r2PublicUrl = ?'); params.push(body.r2PublicUrl); }
          if (body.vastTagUrl !== undefined) { updates.push('vastTagUrl = ?'); params.push(body.vastTagUrl); }
          if (body.outstreamAdTags !== undefined) { updates.push('outstreamAdTags = ?'); params.push(body.outstreamAdTags); }
          if (body.placementUrls !== undefined) { updates.push('placementUrls = ?'); params.push(body.placementUrls); }
          if (body.registrationEnabled !== undefined) { updates.push('registrationEnabled = ?'); params.push(body.registrationEnabled ? 1 : 0); }

          if (updates.length > 0) {
            params.push(existing.id);
            await env.DB.prepare(`UPDATE site_config SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
          }
        } else {
          await env.DB.prepare(
            `INSERT INTO site_config (siteName, primaryColor, siteLogo, siteLogoSvg, faviconUrl, siteDescription, r2PublicUrl, vastTagUrl, outstreamAdTags, placementUrls, registrationEnabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            body.siteName || 'Xplitleaks',
            body.primaryColor || '#ff0050',
            body.siteLogo || '',
            body.siteLogoSvg || '',
            body.faviconUrl || '',
            body.siteDescription || '',
            body.r2PublicUrl || '',
            body.vastTagUrl || '',
            body.outstreamAdTags || '[]',
            body.placementUrls || '[]',
            body.registrationEnabled !== false ? 1 : 0
          ).run();
        }
        return jsonResponse({ success: true });
      }

      // Admin: get creators
      if (path === '/api/admin/creators' && method === 'GET') {
        const status = url.searchParams.get('status');

        let query = `
          SELECT
            id, username, email, status, createdAt, lastLogin,
            (SELECT COUNT(*) FROM videos WHERE creatorId = creators.id) as videoCount,
            (SELECT COUNT(*) FROM shorts WHERE creatorId = creators.id) as shortCount
          FROM creators
        `;
        const params = [];

        if (status && status !== 'all') {
          query += ' WHERE status = ?';
          params.push(status);
        }

        query += ' ORDER BY createdAt DESC';

        const { results } = await env.DB.prepare(query).bind(...params).all();
        return jsonResponse(results || []);
      }

      // Admin: update creator status (PUT - full status control)
      if (path === '/api/admin/creator/status' && method === 'PUT') {
        const { creatorId, status } = await request.json().catch(() => ({}));

        if (!creatorId || !['approved', 'rejected', 'suspended', 'pending'].includes(status)) {
          return errorResponse('Invalid parameters', 400);
        }

        await env.DB.prepare(`
          UPDATE creators SET status = ?, updatedAt = datetime('now') WHERE id = ?
        `).bind(status, creatorId).run();

        return jsonResponse({ success: true, message: `Creator ${status}` });
      }

      // Admin: approve creator (POST convenience endpoint)
      if (path === '/api/admin/creator/approve' && method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('ID required', 400);
        await env.DB.prepare('UPDATE creators SET status = ?, updatedAt = datetime(\'now\') WHERE id = ?')
          .bind('approved', id).run();
        return jsonResponse({ success: true });
      }

      // Admin: reject creator (POST convenience endpoint)
      if (path === '/api/admin/creator/reject' && method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('ID required', 400);
        await env.DB.prepare('UPDATE creators SET status = ?, updatedAt = datetime(\'now\') WHERE id = ?')
          .bind('rejected', id).run();
        return jsonResponse({ success: true });
      }

      // Admin: reset creator (POST convenience endpoint)
      if (path === '/api/admin/creator/reset' && method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('ID required', 400);
        await env.DB.prepare('UPDATE creators SET status = ?, updatedAt = datetime(\'now\') WHERE id = ?')
          .bind('pending', id).run();
        return jsonResponse({ success: true });
      }

      // Admin: get videos
      if (path === '/api/admin/videos' && method === 'GET') {
        const filter = url.searchParams.get('filter') || 'all';

        let query = `
          SELECT
            v.*, c.username as creatorName,
            CASE WHEN v.realViews >= 1000 THEN v.views ELSE v.fakeViews + v.realViews END as displayViews
          FROM videos v
          LEFT JOIN creators c ON v.creatorId = c.id
        `;
        if (filter === 'reported') query += ' WHERE v.reported = 1';
        query += ' ORDER BY v.addedAt DESC LIMIT 500';

        const { results } = await env.DB.prepare(query).all();
        return jsonResponse({ videos: results || [] });
      }

      // Admin: get shorts
      if (path === '/api/admin/shorts' && method === 'GET') {
        const filter = url.searchParams.get('filter') || 'all';

        let query = `
          SELECT
            s.*, c.username as creatorName,
            CASE WHEN s.realViews >= 1000 THEN s.views ELSE s.fakeViews + s.realViews END as displayViews
          FROM shorts s
          LEFT JOIN creators c ON s.creatorId = c.id
        `;
        if (filter === 'reported') query += ' WHERE s.reported = 1';
        query += ' ORDER BY s.addedAt DESC LIMIT 500';

        const { results } = await env.DB.prepare(query).all();
        return jsonResponse({ shorts: results || [] });
      }

      // Admin: get iframe videos
      if (path === '/api/admin/iframes' && method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT
            v.*, c.username as creatorName,
            CASE WHEN v.realViews >= 1000 THEN v.views ELSE v.fakeViews + v.realViews END as displayViews
          FROM videos v
          LEFT JOIN creators c ON v.creatorId = c.id
          WHERE v.type = 'iframe'
          ORDER BY v.addedAt DESC LIMIT 500
        `).all();
        return jsonResponse(results || []);
      }

      // Admin: delete video (soft delete - set status to removed)
      if (path === '/api/admin/video/delete' && method === 'DELETE') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('Video ID required', 400);

        await env.DB.prepare(`
          UPDATE videos SET status = 'removed', updatedAt = datetime('now')
          WHERE numericId = ? OR id = ?
        `).bind(id, id).run();

        return jsonResponse({ success: true, message: 'Video removed' });
      }

      // Admin: delete short (soft delete - set status to removed)
      if (path === '/api/admin/short/delete' && method === 'DELETE') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('Short ID required', 400);

        await env.DB.prepare(`
          UPDATE shorts SET status = 'removed', updatedAt = datetime('now')
          WHERE numericId = ? OR id = ?
        `).bind(id, id).run();

        return jsonResponse({ success: true, message: 'Short removed' });
      }

      // Admin: get reports
      if (path === '/api/admin/reports' && method === 'GET') {
        const status = url.searchParams.get('status') || 'all';

        let whereClause = '';
        const params = [];

        if (status !== 'all') {
          whereClause = 'WHERE r.status = ?';
          params.push(status);
        }

        const { results } = await env.DB.prepare(`
          SELECT r.*,
            CASE WHEN r.contentType = 'short' THEN
              (SELECT title FROM shorts WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
            ELSE
              (SELECT title FROM videos WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
            END as contentTitle
          FROM reports r ${whereClause} ORDER BY r.createdAt DESC LIMIT 200
        `).bind(...params).all();

        return jsonResponse(results || []);
      }

      // Admin: get single report
      if (path.match(/^\/api\/admin\/report\/[0-9]+$/) && method === 'GET') {
        const reportId = path.split('/')[4];
        const report = await env.DB.prepare(`
          SELECT r.*,
            CASE WHEN r.contentType = 'short' THEN
              (SELECT title FROM shorts WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
            ELSE
              (SELECT title FROM videos WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
            END as contentTitle
          FROM reports r WHERE r.id = ?
        `).bind(reportId).first();

        if (!report) return errorResponse('Report not found', 404);
        return jsonResponse(report);
      }

      // Admin: update report status
      if (path === '/api/admin/report/status' && method === 'PUT') {
        const { reportId, status } = await request.json().catch(() => ({}));

        if (!reportId || !['pending', 'resolved', 'dismissed'].includes(status)) {
          return errorResponse('Invalid parameters', 400);
        }

        await env.DB.prepare(`
          UPDATE reports SET status = ?, resolvedAt = datetime('now') WHERE id = ?
        `).bind(status, reportId).run();

        return jsonResponse({ success: true, message: `Report ${status}` });
      }

      // Admin: resolve report (POST convenience endpoint)
      if (path === '/api/admin/report/resolve' && method === 'POST') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('ID required', 400);
        await env.DB.prepare('UPDATE reports SET status = ?, resolvedAt = datetime(\'now\') WHERE id = ?')
          .bind('resolved', id).run();
        return jsonResponse({ success: true });
      }

      // Admin: delete report
      if (path === '/api/admin/report/delete' && method === 'DELETE') {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse('Report ID required', 400);
        await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // Admin: add category
      if (path === '/api/admin/category' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const name = body.name?.trim();
        if (!name) return errorResponse('Name is required', 400);
        if (name.length > 50) return errorResponse('Name too long', 400);

        const existing = await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first();
        if (existing) return errorResponse('Category already exists', 400);

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await env.DB.prepare(`
          INSERT INTO categories (name, slug, videoCount, createdAt) VALUES (?, ?, 0, datetime('now'))
        `).bind(name, slug).run();
        return jsonResponse({ success: true });
      }

      // Admin: update category
      if (path.match(/^\/api\/admin\/category\/[a-zA-Z0-9_-]+$/) && method === 'PUT') {
        const id = path.split('/')[4];
        const body = await request.json().catch(() => ({}));
        const name = body.name?.trim();
        if (!name) return errorResponse('Name is required', 400);

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await env.DB.prepare('UPDATE categories SET name = ?, slug = ? WHERE id = ?').bind(name, slug, id).run();
        return jsonResponse({ success: true });
      }

      // Admin: delete category
      if (path.match(/^\/api\/admin\/category\/[a-zA-Z0-9_-]+$/) && method === 'DELETE') {
        const id = path.split('/')[4];
        const cat = await env.DB.prepare('SELECT slug FROM categories WHERE id = ?').bind(id).first();
        if (cat) {
          await env.DB.prepare('UPDATE videos SET category = ? WHERE category = ?').bind('other', cat.slug).run();
          await env.DB.prepare('UPDATE shorts SET category = ? WHERE category = ?').bind('other', cat.slug).run();
        }
        await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      // Admin: add tag
      if (path === '/api/admin/tag' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const name = body.name?.trim().toLowerCase();
        if (!name) return errorResponse('Name is required', 400);
        if (name.length > 30) return errorResponse('Name too long', 400);

        const existing = await env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
        if (existing) return errorResponse('Tag already exists', 400);

        await env.DB.prepare(`
          INSERT INTO tags (name, slug, usageCount, createdAt) VALUES (?, ?, 0, datetime('now'))
        `).bind(name, name).run();
        return jsonResponse({ success: true });
      }

      // Admin: update tag
      if (path.match(/^\/api\/admin\/tag\/[a-zA-Z0-9_-]+$/) && method === 'PUT') {
        const id = path.split('/')[4];
        const body = await request.json().catch(() => ({}));
        const name = body.name?.trim().toLowerCase();
        if (!name) return errorResponse('Name is required', 400);

        await env.DB.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').bind(name, name, id).run();
        return jsonResponse({ success: true });
      }

      // Admin: delete tag
      if (path.match(/^\/api\/admin\/tag\/[a-zA-Z0-9_-]+$/) && method === 'DELETE') {
        const id = path.split('/')[4];
        await env.DB.prepare('DELETE FROM video_tags WHERE tagId = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      }

      return errorResponse('Endpoint not found', 404);

    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse('Internal server error: ' + error.message, 500);
    }
  }
};
