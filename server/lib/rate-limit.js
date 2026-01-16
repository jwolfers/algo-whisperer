/**
 * Simple in-memory rate limiter
 * For production use with multiple servers, use Redis-backed rate limiting
 */

// Store request counts per IP
const requestCounts = new Map();

// Clean up old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requestCounts.entries()) {
    if (now - data.windowStart > 60000) {
      requestCounts.delete(key);
    }
  }
}, 60000);

/**
 * Create a rate limiting middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @param {number} options.maxRequests - Maximum requests per window (default: 60)
 * @param {string} options.message - Error message when rate limited
 * @returns {Function} Express middleware
 */
function rateLimit(options = {}) {
  const {
    windowMs = 60000,
    maxRequests = 60,
    message = 'Too many requests, please try again later',
  } = options;

  return (req, res, next) => {
    // Skip rate limiting if disabled via env
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    let data = requestCounts.get(ip);

    if (!data || now - data.windowStart > windowMs) {
      // Start a new window
      data = { count: 1, windowStart: now };
      requestCounts.set(ip, data);
      return next();
    }

    data.count++;

    if (data.count > maxRequests) {
      const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({
        error: message,
        retryAfter,
      });
    }

    next();
  };
}

/**
 * Stricter rate limiter for expensive operations (like AI API calls)
 */
const aiRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 10, // Max 10 AI requests per minute
  message: 'Too many AI requests, please wait before trying again',
});

/**
 * Standard rate limiter for general API endpoints
 */
const apiRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 60, // Max 60 requests per minute
  message: 'Too many requests, please try again later',
});

/**
 * Lenient rate limiter for static/read operations
 */
const readRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 120, // Max 120 requests per minute
  message: 'Too many requests, please try again later',
});

module.exports = {
  rateLimit,
  aiRateLimit,
  apiRateLimit,
  readRateLimit,
};
