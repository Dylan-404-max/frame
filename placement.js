/**
 * Cross-Page Placement Engine v2.0 with URL Rotation
 * Enhanced: Configurable cooldown, weight-based rotation, anti-rapid-click, better mobile
 * Single file, auto-initializing on DOMContentLoaded.
 * Include via <script src="placement.js" defer></script> on index.html, shorts.html, video.html
 *
 * Zero network requests. Session cookies only. Capture phase click handler.
 */

(function () {
    "use strict";

    // ===== IFRAME: Do not initialize inside iframes =====
    if (window.self !== window.top) return;

    // ===== CONFIGURATION (from meta tags) =====
    var PLACEMENT_CONFIG = {
        // Cooldown time in milliseconds (default: 60s = 60000ms)
        cooldownMs: 60000,
        // Video page cooldown (default: 60s)
        videoCooldownMs: 60000,
        // Rapid click threshold - max clicks within time window
        maxRapidClicks: 3,
        rapidClickWindowMs: 5000,
        // Debounce time to prevent double-firing
        debounceMs: 500,
        // Touch swipe threshold (pixels)
        swipeThresholdPx: 10,
        // Whether to use weighted rotation (URLs with higher weight appear more often)
        useWeightedRotation: false
    };

    // Load config from meta tags if present
    function loadConfig() {
        var metaCooldown = document.querySelector('meta[name="placement-cooldown"]');
        if (metaCooldown) {
            var val = parseInt(metaCooldown.getAttribute("content"), 10);
            if (!isNaN(val) && val >= 5000) PLACEMENT_CONFIG.cooldownMs = val;
        }

        var metaVideoCooldown = document.querySelector('meta[name="placement-video-cooldown"]');
        if (metaVideoCooldown) {
            var vval = parseInt(metaVideoCooldown.getAttribute("content"), 10);
            if (!isNaN(vval) && vval >= 5000) PLACEMENT_CONFIG.videoCooldownMs = vval;
        }

        var metaRapid = document.querySelector('meta[name="placement-rapid-clicks"]');
        if (metaRapid) {
            var rval = parseInt(metaRapid.getAttribute("content"), 10);
            if (!isNaN(rval) && rval > 0) PLACEMENT_CONFIG.maxRapidClicks = rval;
        }

        var metaWeighted = document.querySelector('meta[name="placement-weighted"]');
        if (metaWeighted) {
            PLACEMENT_CONFIG.useWeightedRotation = metaWeighted.getAttribute("content") === 'true';
        }
    }

    // ===== COOKIE HELPERS =====
    var Cookies = {
        set: function(name, value, options) {
            options = options || {};
            var expires = options.expires;
            if (expires) {
                if (typeof expires === 'number') {
                    var d = new Date();
                    d.setTime(d.getTime() + expires * 1000);
                    expires = d;
                }
                expires = expires.toUTCString ? expires.toUTCString() : expires;
            }
            var cookieStr = name + '=' + encodeURIComponent(value);
            if (expires) cookieStr += '; expires=' + expires;
            cookieStr += '; path=/; SameSite=Lax';
            if (options.secure) cookieStr += '; Secure';
            document.cookie = cookieStr;
        },
        get: function(name) {
            var match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]*)"));
            return match ? decodeURIComponent(match[2]) : null;
        },
        delete: function(name) {
            document.cookie = name + "=; path=/; SameSite=Lax; expires=Thu, 01 Jan 1970 00:00:00 GMT";
        }
    };

    // ===== URL SOURCE & CACHING (Zero Network Requests) =====
    var placementUrls = [];
    var urlsLoaded = false;

    function loadPlacementUrls() {
        if (urlsLoaded) return;
        urlsLoaded = true;

        // Primary: JSON array from meta tag
        var arrayMeta = document.querySelector('meta[name="placement-urls"]');
        if (arrayMeta) {
            try {
                var parsed = JSON.parse(arrayMeta.getAttribute("content"));
                if (Array.isArray(parsed) && parsed.length > 0) {
                    placementUrls = normalizeUrls(parsed);
                    return;
                }
            } catch (e) {
                // Invalid JSON, fall through
            }
        }

        // Fallback: single URL meta tag
        var singleMeta = document.querySelector('meta[name="placement-url"]');
        if (singleMeta) {
            var url = singleMeta.getAttribute("content");
            if (url) {
                placementUrls = [{ url: url, weight: 1 }];
                return;
            }
        }

        // Fallback: read from global siteConfig object (set by site-config.js loaders)
        var globalConfig = (typeof siteConfig !== 'undefined' && siteConfig) ? siteConfig : null;
        if (!globalConfig && typeof window !== 'undefined' && window.siteConfig) {
            globalConfig = window.siteConfig;
        }
        if (!globalConfig && typeof window !== 'undefined' && window.SITE_CONFIG) {
            globalConfig = window.SITE_CONFIG;
        }

        if (globalConfig && globalConfig.placementUrls) {
            try {
                var configUrls = globalConfig.placementUrls;
                var parsedUrls = null;
                if (typeof configUrls === 'string') {
                    parsedUrls = JSON.parse(configUrls);
                } else if (Array.isArray(configUrls)) {
                    parsedUrls = configUrls;
                }
                if (Array.isArray(parsedUrls) && parsedUrls.length > 0) {
                    placementUrls = normalizeUrls(parsedUrls);
                    return;
                }
            } catch (e) {
                // Invalid config URLs, fall through
            }
        }

        // No meta tags or global config found — placementUrls is empty,
        // click handler will exit early without interfering
        placementUrls = [];
    }

    // Normalize URL entries - support both strings and objects {url, weight}
    function normalizeUrls(raw) {
        return raw.map(function(item) {
            if (typeof item === 'string') return { url: item, weight: 1 };
            if (item && typeof item === 'object' && item.url) {
                return { url: item.url, weight: parseInt(item.weight, 10) || 1 };
            }
            return { url: String(item), weight: 1 };
        }).filter(function(item) {
            return item.url && item.url.length > 0 && item.url.startsWith('http');
        });
    }

    function getTotalWeight() {
        return placementUrls.reduce(function(sum, item) { return sum + item.weight; }, 0);
    }

    function getNextRotatedUrl() {
        if (placementUrls.length === 0) return null;

        if (placementUrls.length === 1) return placementUrls[0].url;

        if (PLACEMENT_CONFIG.useWeightedRotation) {
            return getWeightedUrl();
        } else {
            return getSequentialUrl();
        }
    }

    function getSequentialUrl() {
        var idx = parseInt(Cookies.get("plcmnt_url_idx") || "0", 10);
        if (isNaN(idx)) idx = 0;

        var item = placementUrls[idx % placementUrls.length];
        var url = item ? item.url : null;

        // Write back next index
        Cookies.set("plcmnt_url_idx", String((idx + 1) % placementUrls.length));

        return url;
    }

    function getWeightedUrl() {
        var idx = parseInt(Cookies.get("plcmnt_url_idx_w") || "0", 10);
        if (isNaN(idx)) idx = 0;

        var totalWeight = getTotalWeight();
        if (totalWeight === 0) return placementUrls[0] ? placementUrls[0].url : null;

        var target = idx % totalWeight;
        var cumulative = 0;
        var selected = placementUrls[0];

        for (var i = 0; i < placementUrls.length; i++) {
            cumulative += placementUrls[i].weight;
            if (cumulative > target) {
                selected = placementUrls[i];
                break;
            }
        }

        // Increment by 1 for fine-grained rotation within weights
        Cookies.set("plcmnt_url_idx_w", String((idx + 1) % totalWeight));

        return selected ? selected.url : null;
    }

    // ===== PAGE DETECTION =====
    function detectPage() {
        var pathname = window.location.pathname;
        if (pathname.includes("shorts")) return "shorts";
        if (pathname.includes("video")) return "video";
        // Only index, shorts, and video pages are supported
        // Return null for unsupported pages (admin, upload, report, etc.)
        if (pathname === "/" || pathname === "" || pathname.endsWith("index.html")) return "index";
        return null; // Unsupported page — script stays inactive
    }

    // Page is not supported for placement; go inactive
    var activePage = detectPage();
    if (!activePage) return; // Early exit for unsupported pages

    // ===== CLICK CLASSIFICATION =====
    function classifyClick(target) {
        var link = target.closest("a[href]");
        if (link) {
            var href = link.getAttribute("href") || "";
            // Type A: Links with real href (not #, javascript:, or empty)
            if (
                href.length > 0 &&
                !href.startsWith("#") &&
                !href.startsWith("javascript:")
            ) {
                return { type: "A", href: href };
            }
        }

        // Check for button clicks (type B - same behavior as type X)
        var button = target.closest("button");
        if (button) {
            return { type: "B" };
        }

        // Type X: Everything else
        return { type: "X" };
    }

    // ===== SHORTS TRACKING =====
    var currentShortsId = "";

    function initShortsTracking() {
        var observer = new IntersectionObserver(
            function(entries) {
                entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                        var el = entry.target.closest("[data-shorts-id]");
                        if (el) {
                            currentShortsId = el.getAttribute("data-shorts-id");
                        }
                    }
                });
            },
            { threshold: 0.6 }
        );

        document.querySelectorAll("[data-shorts-id]").forEach(function(el) {
            observer.observe(el);
        });

        // Also observe dynamically added elements
        var mutationObserver = new MutationObserver(function() {
            document.querySelectorAll("[data-shorts-id]").forEach(function(el) {
                if (!el._placementObserved) {
                    el._placementObserved = true;
                    observer.observe(el);
                }
            });
        });

        mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ===== CONTEXT SAVE =====
    function saveContext() {
        var page = detectPage();
        var ctx = { page: page };

        if (page === "index") {
            ctx.scrollY = window.scrollY;
        }
        if (page === "shorts") {
            ctx.shortsId = currentShortsId;
        }
        if (page === "video") {
            var phase = parseInt(Cookies.get("plcmnt_vid_phase") || "0", 10);
            // ONLY save videoTime if we are currently in Phase 1
            if (phase === 1) {
                var video = document.querySelector("video");
                ctx.videoTime = video ? video.currentTime : 0;
            }
            // Phase 0 intentionally omits videoTime
        }

        Cookies.set("plcmnt_ctx", JSON.stringify(ctx));
    }

    // ===== STATE ADVANCE =====
    function advanceState() {
        var page = detectPage();

        if (page === "index" || page === "shorts") {
            Cookies.set("plcmnt_t", Date.now());
            return;
        }

        if (page === "video") {
            var phase = parseInt(Cookies.get("plcmnt_vid_phase") || "0", 10);
            if (phase === 0) {
                // Phase 0 → Phase 1
                Cookies.set("plcmnt_vid_phase", "1");
            } else if (phase === 1) {
                // Phase 1 → Phase 2 (cooldown STARTS)
                Cookies.set("plcmnt_vid_phase", "2");
                Cookies.set("plcmnt_vid_t", Date.now());
            }
            // Phase 2 never calls advanceState because clicks are blocked.
            // If cooldown expired and phase was reset to 0 in canExecuteTypeX(),
            // then phase here is 0, so it correctly advances to 1.
        }
    }

    // ===== RAPID CLICK DETECTION (Anti-fraud) =====
    var clickTimestamps = [];

    function isRapidClick() {
        var now = Date.now();
        clickTimestamps.push(now);
        // Keep only clicks within the window
        var cutoff = now - PLACEMENT_CONFIG.rapidClickWindowMs;
        clickTimestamps = clickTimestamps.filter(function(t) { return t >= cutoff; });

        return clickTimestamps.length > PLACEMENT_CONFIG.maxRapidClicks;
    }

    // ===== CAN EXECUTE TYPE X =====
    function canExecuteTypeX() {
        var page = detectPage();

        // Anti-rapid-click check
        if (isRapidClick()) return false;

        if (page === "index" || page === "shorts") {
            var t = Cookies.get("plcmnt_t");
            var cooldown = PLACEMENT_CONFIG.cooldownMs;
            // No cooldown set, or cooldown expired
            return !t || Date.now() - parseInt(t, 10) >= cooldown;
        }

        if (page === "video") {
            var phase = parseInt(Cookies.get("plcmnt_vid_phase") || "0", 10);

            // Phase 0: always allow
            // Phase 1: always allow
            if (phase === 0 || phase === 1) return true;

            if (phase === 2) {
                var t = Cookies.get("plcmnt_vid_t");
                var vCooldown = PLACEMENT_CONFIG.videoCooldownMs;
                // Still cooling down
                if (t && Date.now() - parseInt(t, 10) < vCooldown) return false;

                // Cooldown expired: auto-reset to Phase 0 so this click behaves as Phase 0
                Cookies.set("plcmnt_vid_phase", "0");
                Cookies.delete("plcmnt_vid_t");
                return true;
            }
        }

        return false;
    }

    // ===== EXECUTE PLACEMENT =====
    var isProcessing = false;

    function executePlacement(options) {
        if (isProcessing) return;
        isProcessing = true;
        setTimeout(function() {
            isProcessing = false;
        }, PLACEMENT_CONFIG.debounceMs);

        var url = getNextRotatedUrl();
        if (!url) return;

        if (options.saveState) saveContext();
        if (options.advanceState) advanceState();

        var targetUrl = options.href || window.location.href;

        // Open new tab FIRST, then redirect current
        window.open(targetUrl, "_blank");
        window.location.href = url;
    }

    // ===== MASTER CLICK HANDLER =====
    document.addEventListener(
        "click",
        function(e) {
            // Safety guards
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            if (window.getSelection().toString().length > 0) return;

            // CRITICAL: If no placement URLs configured, do not intercept ANY clicks
            // The script should be completely transparent when inactive
            if (placementUrls.length === 0) return;

            // Mobile: check touch delta
            if (window._placementTouchStartY !== undefined) {
                var deltaY = Math.abs(window._placementTouchEndY - window._placementTouchStartY);
                if (deltaY > PLACEMENT_CONFIG.swipeThresholdPx) return; // It's a swipe, not a tap
            }

            var click = classifyClick(e.target);

            // TYPE A: Links always execute, always rotate URL, never touch phases
            if (click.type === "A") {
                e.preventDefault();
                executePlacement({
                    href: click.href,
                    saveState: false,
                    advanceState: false
                });
                return;
            }

            // TYPE B: Buttons - treat same as Type X (page-specific cooldown/phase)
            if (click.type === "B" || click.type === "X") {
                if (!canExecuteTypeX()) return;

                e.preventDefault();
                e.stopImmediatePropagation();
                executePlacement({ saveState: true, advanceState: true });
            }
        },
        true // CAPTURE PHASE
    );

    // ===== MOBILE TOUCH TRACKING =====
    var touchStartY = 0;
    document.addEventListener(
        "touchstart",
        function(e) {
            if (e.touches && e.touches[0]) {
                touchStartY = e.touches[0].clientY;
            }
        },
        { passive: true }
    );

    document.addEventListener(
        "touchend",
        function(e) {
            if (e.changedTouches && e.changedTouches[0]) {
                window._placementTouchStartY = touchStartY;
                window._placementTouchEndY = e.changedTouches[0].clientY;
                // Clear after click handler runs
                setTimeout(function() {
                    window._placementTouchStartY = undefined;
                    window._placementTouchEndY = undefined;
                }, 100);
            }
        },
        { passive: true }
    );

    // ===== KEYBOARD NAVIGATION SUPPORT =====
    // Track keyboard activity to distinguish from programmatic clicks
    var lastKeyTime = 0;
    document.addEventListener('keydown', function(e) {
        lastKeyTime = Date.now();
    });

    // ===== NEW TAB RESTORATION =====
    function restoreContext() {
        var ctxRaw = Cookies.get("plcmnt_ctx");
        if (!ctxRaw) return;

        try {
            var ctx = JSON.parse(ctxRaw);
            if (!ctx.page) return;

            var currentPage = detectPage();
            if (ctx.page !== currentPage) {
                Cookies.delete("plcmnt_ctx");
                return;
            }

            if (ctx.page === "index" && ctx.scrollY != null) {
                window.scrollTo(0, ctx.scrollY);
            }

            if (ctx.page === "shorts" && ctx.shortsId) {
                var el = document.querySelector('[data-shorts-id="' + ctx.shortsId + '"]');
                if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
            }

            if (ctx.page === "video" && ctx.videoTime != null) {
                var video = document.querySelector("video");
                if (video) {
                    video.currentTime = ctx.videoTime;
                }
            }
            // If ctx.videoTime is absent (Phase 0 click), video loads naturally without seeking
        } catch (e) {
            // ignore parse errors
        } finally {
            // Immediately delete so refresh doesn't re-apply
            Cookies.delete("plcmnt_ctx");
        }
    }

    // ===== INITIALIZATION =====
    function init() {
        loadConfig();
        loadPlacementUrls();

        // If no placement URLs configured, click handler still works
        // but executePlacement will return early due to no URL

        if (activePage === "shorts") {
            initShortsTracking();
        }

        // Restore context on new tab
        restoreContext();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
