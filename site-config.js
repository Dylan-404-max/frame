/**
 * Site Configuration File
 * Edit this file to change URLs, branding, and essentials without modifying individual pages.
 * 
 * LOGO OPTIONS:
 * - siteLogo: URL to an image logo (PNG, JPG, etc.) - takes priority if set
 * - siteLogoSvg: Inline SVG markup string - used if siteLogo is empty
 * - siteLogoSvgFile: Path to an SVG file to load and inline
 * 
 * Example SVG logo (paste your SVG markup):
 * siteLogoSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#ff0050"/></svg>'
 * 
 * Or use an SVG file:
 * siteLogoSvgFile: 'logo.svg'
 */
const SITE_CONFIG = {
    // API endpoint - change this if your API moves
    apiEndpoint: 'https://xplitleaks-api.dylancoral.workers.dev/api',

    // Page URLs - change these if page filenames change
    pages: {
        index: 'index.html',
        video: 'video.html',
        shorts: 'shorts.html',
        upload: 'upload.html',
        admin: 'admin.html',
        report: 'report.html'
    },

    // R2 Storage URL
    r2PublicUrl: 'https://90abbd0ed7a82bd4b2fb5845c475ee16.r2.cloudflarestorage.com/xplitleaks',

    // CDN URLs
    cdns: {
        tailwind: 'https://cdn.tailwindcss.com',
        fontAwesome: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
        fluidPlayerCss: 'https://cdn.fluidplayer.com/v3/current/fluidplayer.min.css',
        fluidPlayerJs: 'https://cdn.fluidplayer.com/v3/current/fluidplayer.min.js',
        chartJs: 'https://cdn.jsdelivr.net/npm/chart.js'
    },

    // Placement/Ad URLs (injected via meta tags by backend)
    // These are read from meta tags, not hardcoded here
    // Admin panel sets: vastTagUrl, outstreamAdTags, placementUrls

    // ===== BRANDING (Client-side defaults, overridden by /api/config) =====
    branding: {
        // Image logo URL (overrides SVG if set)
        siteLogo: '',
        // Inline SVG markup for logo
        siteLogoSvg: '',
        // Path to SVG file to load and inline
        siteLogoSvgFile: '',
        // Favicon URL (can be .ico, .png, .svg)
        faviconUrl: '',
        // Default site name
        siteName: 'Xplitleaks',
        // Default primary color
        primaryColor: '#ff0050',
        // Site description for SEO
        siteDescription: 'The best platform for sharing and discovering videos and shorts.',
        // Default OG image for social sharing
        defaultOgImage: ''
    }
};

// Helper to get full API path
function api(path) {
    return SITE_CONFIG.apiEndpoint + path;
}

// Helper to get page URL
function page(name) {
    return SITE_CONFIG.pages[name] || name + '.html';
}

// ===== PLACEMENT META TAG INJECTION =====
/**
 * Injects placement-related meta tags into the document head.
 * Removes any existing placement meta tags first to avoid duplicates.
 * 
 * @param {Object} config - Site config from API containing placementUrls, placementCooldown, etc.
 */
function injectPlacementMeta(config) {
    if (!config || typeof config !== 'object') return;

    // Remove existing placement meta tags to avoid duplicates
    var existingTags = document.querySelectorAll('meta[name^="placement-"]');
    existingTags.forEach(function(tag) { tag.remove(); });

    // Inject placement URLs meta tag
    var placementUrls = config.placementUrls;
    if (placementUrls && placementUrls !== '[]' && placementUrls !== '') {
        var meta = document.createElement('meta');
        meta.name = 'placement-urls';
        meta.content = placementUrls;
        document.head.appendChild(meta);
    }

    // Inject placement cooldown meta tag
    if (config.placementCooldown && !isNaN(config.placementCooldown)) {
        var cooldownMeta = document.createElement('meta');
        cooldownMeta.name = 'placement-cooldown';
        cooldownMeta.content = String(config.placementCooldown);
        document.head.appendChild(cooldownMeta);
    }

    // Inject video cooldown meta tag
    if (config.videoCooldown && !isNaN(config.videoCooldown)) {
        var videoCooldownMeta = document.createElement('meta');
        videoCooldownMeta.name = 'placement-video-cooldown';
        videoCooldownMeta.content = String(config.videoCooldown);
        document.head.appendChild(videoCooldownMeta);
    }

    // Inject rapid clicks threshold meta tag
    if (config.placementRapidClicks && !isNaN(config.placementRapidClicks)) {
        var rapidMeta = document.createElement('meta');
        rapidMeta.name = 'placement-rapid-clicks';
        rapidMeta.content = String(config.placementRapidClicks);
        document.head.appendChild(rapidMeta);
    }

    // Inject weighted rotation meta tag
    if (config.placementWeighted !== undefined) {
        var weightedMeta = document.createElement('meta');
        weightedMeta.name = 'placement-weighted';
        weightedMeta.content = config.placementWeighted ? 'true' : 'false';
        document.head.appendChild(weightedMeta);
    }

    // Notify placement engine that meta tags are now available
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('placementMetaReady'));
    }
}

// ===== LOGO RENDERER =====
/**
 * Renders the site logo into a container element.
 * Supports: image URL, inline SVG string, SVG file path, or fallback text.
 * 
 * @param {HTMLElement} container - The container element to render logo into
 * @param {Object} config - Site config from API (optional, falls back to SITE_CONFIG.branding)
 * @param {string} heightClass - Tailwind height class for the logo (default: 'h-8')
 * @returns {Promise<boolean>} - True if logo was rendered
 */
async function renderSiteLogo(container, config, heightClass) {
    if (!container) return false;

    var branding = config || SITE_CONFIG.branding;
    var height = heightClass || 'h-8';

    // Clear container
    container.innerHTML = '';
    container.classList.remove('hidden');

    // Option 1: Image logo URL (from API config.siteLogo)
    var imgUrl = branding.siteLogo || (config && config.siteLogo) || '';
    if (imgUrl) {
        var img = document.createElement('img');
        img.src = imgUrl;
        img.alt = (branding.siteName || 'Logo');
        img.className = height + ' w-auto object-contain';
        img.onerror = function() {
            // If image fails, try SVG or fallback
            container.innerHTML = '';
            renderSvgOrFallback(container, branding, height);
        };
        container.appendChild(img);
        return true;
    }

    return renderSvgOrFallback(container, branding, height);
}

function renderSvgOrFallback(container, branding, height) {
    // Option 2: Inline SVG string
    var svgMarkup = branding.siteLogoSvg || '';
    if (svgMarkup) {
        container.innerHTML = svgMarkup;
        var svg = container.querySelector('svg');
        if (svg) {
            svg.classList.add(height, 'w-auto');
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', branding.siteName || 'Logo');
        }
        return true;
    }

    // Option 3: SVG file to load
    var svgFile = branding.siteLogoSvgFile || '';
    if (svgFile) {
        loadSvgFile(container, svgFile, height, branding.siteName);
        return true;
    }

    // Option 4: Fallback - show nothing (text logo handled separately)
    container.classList.add('hidden');
    return false;
}

function loadSvgFile(container, filePath, height, siteName) {
    fetch(filePath)
        .then(function(res) { return res.text(); })
        .then(function(svgText) {
            container.innerHTML = svgText;
            var svg = container.querySelector('svg');
            if (svg) {
                svg.classList.add(height, 'w-auto');
                svg.setAttribute('role', 'img');
                svg.setAttribute('aria-label', siteName || 'Logo');
            }
        })
        .catch(function() {
            container.classList.add('hidden');
        });
}

// ===== FAVICON SETTER =====
/**
 * Sets the favicon for the page.
 * @param {string} faviconUrl - URL to favicon (.ico, .png, .svg)
 */
function setFavicon(faviconUrl) {
    if (!faviconUrl) return;

    // Remove existing favicons
    var existing = document.querySelectorAll('link[rel*="icon"]');
    existing.forEach(function(el) { el.remove(); });

    var link = document.createElement('link');
    link.rel = 'icon';
    link.href = faviconUrl;

    // Set type based on extension
    if (faviconUrl.endsWith('.svg')) link.type = 'image/svg+xml';
    else if (faviconUrl.endsWith('.png')) link.type = 'image/png';
    else if (faviconUrl.endsWith('.ico')) link.type = 'image/x-icon';

    document.head.appendChild(link);

    // Also set apple-touch-icon
    var appleLink = document.createElement('link');
    appleLink.rel = 'apple-touch-icon';
    appleLink.href = faviconUrl;
    document.head.appendChild(appleLink);
}

// ===== META TAG UPDATER =====
/**
 * Updates meta tags dynamically for SEO and social sharing.
 * @param {Object} config - Site config with siteName, siteDescription, defaultOgImage
 */
function updateMetaTags(config) {
    if (!config) return;

    var name = config.siteName || SITE_CONFIG.branding.siteName;
    var desc = config.siteDescription || SITE_CONFIG.branding.siteDescription;
    var img = config.defaultOgImage || SITE_CONFIG.branding.defaultOgImage;

    if (desc) {
        var metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) metaDesc.setAttribute('content', desc);
    }

    if (name) {
        var ogSite = document.querySelector('meta[property="og:site_name"]');
        if (ogSite) ogSite.setAttribute('content', name);
    }

    if (img) {
        var ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg && !ogImg.getAttribute('content')) ogImg.setAttribute('content', img);
    }
}

// ===== SITE CONFIG LOADER (Shared across all pages) =====
/**
 * Loads site config from API and applies branding (logo, favicon, colors).
 * Also injects placement meta tags automatically.
 * Call this in each page's DOMContentLoaded handler.
 * 
 * @param {Object} options - Options for branding application
 * @param {boolean} options.applyLogo - Whether to apply logo (default: true)
 * @param {boolean} options.applyFavicon - Whether to apply favicon (default: true)
 * @param {boolean} options.applyColors - Whether to apply primary color (default: true)
 * @param {boolean} options.applyMeta - Whether to update meta tags (default: true)
 * @param {boolean} options.injectPlacement - Whether to inject placement meta tags (default: true)
 * @returns {Promise<Object>} - The site config from API
 */
async function loadSiteConfig(options) {
    options = options || {};
    var applyLogo = options.applyLogo !== false;
    var applyFavicon = options.applyFavicon !== false;
    var applyColors = options.applyColors !== false;
    var applyMeta = options.applyMeta !== false;
    var injectPlacement = options.injectPlacement !== false;

    try {
        var response = await fetch(api('/config'));
        if (!response.ok) return {};
        var config = await response.json();

        // Apply site name to all elements
        if (config.siteName) {
            document.querySelectorAll('[data-site-name]').forEach(function(el) {
                el.textContent = config.siteName;
            });
        }

        // Apply logo
        if (applyLogo) {
            var logoContainers = document.querySelectorAll('[data-site-logo]');
            logoContainers.forEach(function(container) {
                var height = container.dataset.siteLogo || 'h-8';
                renderSiteLogo(container, config, height);
            });
        }

        // Apply favicon
        if (applyFavicon && config.faviconUrl) {
            setFavicon(config.faviconUrl);
        }

        // Apply primary color
        if (applyColors && config.primaryColor) {
            document.documentElement.style.setProperty('--primary', config.primaryColor);
            document.documentElement.style.setProperty('--accent', config.primaryColor);
        }

        // Update meta tags
        if (applyMeta) {
            updateMetaTags(config);
        }

        // Inject placement meta tags
        if (injectPlacement) {
            injectPlacementMeta(config);
        }

        return config;
    } catch (error) {
        return {};
    }
}

// Export for module environments if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SITE_CONFIG, api, page, injectPlacementMeta, renderSiteLogo, setFavicon, updateMetaTags, loadSiteConfig };
}
