import { logger } from '../util/logger'

// Rate limiting constants - easily configurable
export const RATE_LIMIT_CONFIG = {
  // Token bucket capacity (max burst size)
  BUCKET_CAPACITY: 10,
  // Tokens refilled per second (sustained rate)
  REFILL_RATE: 2,
  // How often to refill tokens (in milliseconds)
  REFILL_INTERVAL_MS: 1000,
  // How long to keep rate limit records in memory (cleanup after inactivity)
  CLEANUP_AFTER_MS: 5 * 60 * 1000, // 5 minutes
} as const

interface TokenBucket {
  tokens: number
  lastRefill: number
  capacity: number
  refillRate: number
}

interface RateLimitRecord {
  bucket: TokenBucket
  lastAccess: number
  isCurrentlyRateLimited: boolean
  lastRateLimitLog: number
}

// In-memory store for rate limiting per user
const rateLimitStore = new Map<string, RateLimitRecord>()

// Cleanup interval for removing stale entries
let cleanupInterval: NodeJS.Timeout | undefined

/**
 * Initialize the rate limiter with periodic cleanup
 */
export function initializeRateLimiter() {
  // Clean up stale entries every minute
  cleanupInterval = setInterval(() => {
    const now = Date.now()
    const entriesToDelete: string[] = []

    for (const [userId, record] of rateLimitStore.entries()) {
      if (now - record.lastAccess > RATE_LIMIT_CONFIG.CLEANUP_AFTER_MS) {
        entriesToDelete.push(userId)
      }
    }

    for (const userId of entriesToDelete) {
      rateLimitStore.delete(userId)
    }

    if (entriesToDelete.length > 0) {
      logger.debug(
        { cleanedUpUsers: entriesToDelete.length },
        'Cleaned up stale rate limit entries',
      )
    }
  }, 60 * 1000) // Run cleanup every minute
}

/**
 * Cleanup the rate limiter resources
 */
export function cleanupRateLimiter() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }
  rateLimitStore.clear()
}

/**
 * Create a new token bucket for a user
 */
function createTokenBucket(): TokenBucket {
  return {
    tokens: RATE_LIMIT_CONFIG.BUCKET_CAPACITY,
    lastRefill: Date.now(),
    capacity: RATE_LIMIT_CONFIG.BUCKET_CAPACITY,
    refillRate: RATE_LIMIT_CONFIG.REFILL_RATE,
  }
}

/**
 * Refill tokens in the bucket based on elapsed time
 */
function refillTokens(bucket: TokenBucket): void {
  const now = Date.now()
  const timeSinceLastRefill = now - bucket.lastRefill

  if (timeSinceLastRefill >= RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS) {
    const intervalsElapsed = Math.floor(
      timeSinceLastRefill / RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS,
    )
    const tokensToAdd = intervalsElapsed * bucket.refillRate

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now
  }
}

/**
 * Check if a user is rate limited and consume a token if available
 * @param userId - The user ID to check rate limits for
 * @returns true if rate limited (should reject), false if allowed
 */
export function isRateLimited(userId: string): boolean {
  const now = Date.now()

  // Get or create rate limit record for user
  let record = rateLimitStore.get(userId)
  if (!record) {
    record = {
      bucket: createTokenBucket(),
      lastAccess: now,
      isCurrentlyRateLimited: false,
      lastRateLimitLog: 0,
    }
    rateLimitStore.set(userId, record)
  }

  // Update last access time
  record.lastAccess = now

  // Check if user was previously rate limited before refilling tokens
  const wasRateLimited = record.isCurrentlyRateLimited

  // Refill tokens based on elapsed time
  refillTokens(record.bucket)

  // Check if we have tokens available
  if (record.bucket.tokens >= 1) {
    // Consume one token
    record.bucket.tokens -= 1

    // If user was previously rate limited but now has tokens, log recovery
    if (wasRateLimited) {
      record.isCurrentlyRateLimited = false
      logger.info(
        {
          userId,
          tokensRemaining: record.bucket.tokens,
          bucketCapacity: record.bucket.capacity,
        },
        'User rate limit removed - tokens refilled',
      )
    }

    return false // Not rate limited
  }

  // No tokens available, rate limited
  if (!record.isCurrentlyRateLimited) {
    // First time hitting rate limit - log it
    record.isCurrentlyRateLimited = true
    record.lastRateLimitLog = now
    logger.warn(
      {
        userId,
        tokensRemaining: record.bucket.tokens,
        bucketCapacity: record.bucket.capacity,
        refillRate: record.bucket.refillRate,
        nextRefillIn:
          RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS -
          (now - record.bucket.lastRefill),
      },
      'User hit rate limit',
    )
  }

  return true // Rate limited
}

/**
 * Get current rate limit status for a user (for debugging/monitoring)
 */
export function getRateLimitStatus(userId: string): {
  tokensRemaining: number
  capacity: number
  refillRate: number
  nextRefillIn: number
} {
  const record = rateLimitStore.get(userId)
  if (!record) {
    return {
      tokensRemaining: RATE_LIMIT_CONFIG.BUCKET_CAPACITY,
      capacity: RATE_LIMIT_CONFIG.BUCKET_CAPACITY,
      refillRate: RATE_LIMIT_CONFIG.REFILL_RATE,
      nextRefillIn: 0,
    }
  }

  refillTokens(record.bucket)

  const timeSinceLastRefill = Date.now() - record.bucket.lastRefill
  const nextRefillIn = Math.max(
    0,
    RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS - timeSinceLastRefill,
  )

  return {
    tokensRemaining: record.bucket.tokens,
    capacity: record.bucket.capacity,
    refillRate: record.bucket.refillRate,
    nextRefillIn,
  }
}

/**
 * Get rate limiting statistics (for monitoring)
 */
export function getRateLimitStats(): {
  activeUsers: number
  totalTokensInCirculation: number
  config: typeof RATE_LIMIT_CONFIG
} {
  let totalTokens = 0

  for (const record of rateLimitStore.values()) {
    refillTokens(record.bucket)
    totalTokens += record.bucket.tokens
  }

  return {
    activeUsers: rateLimitStore.size,
    totalTokensInCirculation: totalTokens,
    config: RATE_LIMIT_CONFIG,
  }
}
