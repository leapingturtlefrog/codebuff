import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test'

import {
  RATE_LIMIT_CONFIG,
  isRateLimited,
  getRateLimitStatus,
  getRateLimitStats,
  initializeRateLimiter,
  cleanupRateLimiter,
} from '../websockets/rate-limiter'
import { logger } from '../util/logger'

describe('Rate Limiter', () => {
  let currentTime = 1234567890000

  beforeEach(() => {
    // Reset time and initialize rate limiter for each test
    currentTime = 1234567890000
    spyOn(Date, 'now').mockImplementation(() => currentTime)

    // Clean up any existing state
    cleanupRateLimiter()
    initializeRateLimiter()
  })

  afterEach(() => {
    cleanupRateLimiter()
  })

  afterAll(() => {
    jest.restoreAllMocks()
  })

  describe('Token Bucket Behavior', () => {
    it('should allow requests up to bucket capacity initially', () => {
      const userId = 'test-user-1'

      // Should allow up to BUCKET_CAPACITY requests
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        expect(isRateLimited(userId)).toBe(false)
      }

      // Next request should be rate limited
      expect(isRateLimited(userId)).toBe(true)
    })

    it('should refill tokens over time', () => {
      const userId = 'test-user-2'

      // Consume all tokens
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(userId)
      }

      // Should be rate limited now
      expect(isRateLimited(userId)).toBe(true)

      // Advance time by refill interval
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS

      // Should have REFILL_RATE new tokens available
      for (let i = 0; i < RATE_LIMIT_CONFIG.REFILL_RATE; i++) {
        expect(isRateLimited(userId)).toBe(false)
      }

      // Should be rate limited again
      expect(isRateLimited(userId)).toBe(true)
    })

    it('should not overflow bucket capacity when refilling', () => {
      const userId = 'test-user-3'

      // Consume one token
      isRateLimited(userId)

      // Advance time by multiple refill intervals
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS * 10

      // Should still only have capacity tokens available
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        expect(isRateLimited(userId)).toBe(false)
      }

      // Next request should be rate limited
      expect(isRateLimited(userId)).toBe(true)
    })

    it('should handle partial refill intervals correctly', () => {
      const userId = 'test-user-4'

      // Consume all tokens
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(userId)
      }

      // Advance time by half refill interval (should not refill yet)
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS / 2
      expect(isRateLimited(userId)).toBe(true)

      // Advance to complete the interval
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS / 2

      // Should now have tokens available
      for (let i = 0; i < RATE_LIMIT_CONFIG.REFILL_RATE; i++) {
        expect(isRateLimited(userId)).toBe(false)
      }
    })
  })

  describe('Multiple Users', () => {
    it('should maintain separate buckets for different users', () => {
      const user1 = 'user-1'
      const user2 = 'user-2'

      // Consume all tokens for user1
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(user1)
      }

      // user1 should be rate limited
      expect(isRateLimited(user1)).toBe(true)

      // user2 should still have full capacity
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        expect(isRateLimited(user2)).toBe(false)
      }

      expect(isRateLimited(user2)).toBe(true)
    })

    it('should track usage independently for multiple users', () => {
      const users = ['user-a', 'user-b', 'user-c']

      // Each user consumes different amounts
      isRateLimited(users[0]) // 1 token
      isRateLimited(users[1]) // 1 token
      isRateLimited(users[1]) // 2 tokens
      isRateLimited(users[2]) // 1 token
      isRateLimited(users[2]) // 2 tokens
      isRateLimited(users[2]) // 3 tokens

      const status1 = getRateLimitStatus(users[0])
      const status2 = getRateLimitStatus(users[1])
      const status3 = getRateLimitStatus(users[2])

      expect(status1.tokensRemaining).toBe(
        RATE_LIMIT_CONFIG.BUCKET_CAPACITY - 1,
      )
      expect(status2.tokensRemaining).toBe(
        RATE_LIMIT_CONFIG.BUCKET_CAPACITY - 2,
      )
      expect(status3.tokensRemaining).toBe(
        RATE_LIMIT_CONFIG.BUCKET_CAPACITY - 3,
      )
    })
  })

  describe('Rate Limit Status', () => {
    it('should return correct status for new user', () => {
      const status = getRateLimitStatus('new-user')

      expect(status.tokensRemaining).toBe(RATE_LIMIT_CONFIG.BUCKET_CAPACITY)
      expect(status.capacity).toBe(RATE_LIMIT_CONFIG.BUCKET_CAPACITY)
      expect(status.refillRate).toBe(RATE_LIMIT_CONFIG.REFILL_RATE)
      expect(status.nextRefillIn).toBe(0)
    })

    it('should return correct status after consuming tokens', () => {
      const userId = 'test-user'
      const tokensConsumed = 3

      for (let i = 0; i < tokensConsumed; i++) {
        isRateLimited(userId)
      }

      const status = getRateLimitStatus(userId)
      expect(status.tokensRemaining).toBe(
        RATE_LIMIT_CONFIG.BUCKET_CAPACITY - tokensConsumed,
      )
    })

    it('should calculate next refill time correctly', () => {
      const userId = 'test-user'

      // Consume a token
      isRateLimited(userId)

      // Advance time partway to next refill
      const partialTime = Math.floor(RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS / 3)
      currentTime += partialTime

      const status = getRateLimitStatus(userId)
      expect(status.nextRefillIn).toBe(
        RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS - partialTime,
      )
    })
  })

  describe('Rate Limit Statistics', () => {
    it('should return correct stats for no active users', () => {
      const stats = getRateLimitStats()

      expect(stats.activeUsers).toBe(0)
      expect(stats.totalTokensInCirculation).toBe(0)
      expect(stats.config).toEqual(RATE_LIMIT_CONFIG)
    })

    it('should return correct stats with active users', () => {
      const users = ['user-1', 'user-2', 'user-3']

      // Each user consumes 1 token
      users.forEach((user) => isRateLimited(user))

      const stats = getRateLimitStats()
      expect(stats.activeUsers).toBe(3)
      expect(stats.totalTokensInCirculation).toBe(
        3 * (RATE_LIMIT_CONFIG.BUCKET_CAPACITY - 1),
      )
    })
  })

  describe('Cleanup and Memory Management', () => {
    it('should initialize and cleanup without errors', () => {
      expect(() => initializeRateLimiter()).not.toThrow()
      expect(() => cleanupRateLimiter()).not.toThrow()
    })

    it('should handle multiple initializations safely', () => {
      initializeRateLimiter()
      initializeRateLimiter()

      expect(() => cleanupRateLimiter()).not.toThrow()
    })

    it('should handle cleanup without initialization', () => {
      expect(() => cleanupRateLimiter()).not.toThrow()
    })
  })

  describe('Logging Behavior', () => {
    it('should log when user first hits rate limit but not on subsequent hits', () => {
      const userId = 'logging-test-user'

      // Spy on logger methods
      const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {})

      // Consume all tokens
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(userId)
      }

      // Clear previous calls
      warnSpy.mockClear()

      // First rate limit hit should log
      expect(isRateLimited(userId)).toBe(true)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tokensRemaining: 0,
        }),
        'User hit rate limit',
      )

      // Subsequent rate limit hits should NOT log
      warnSpy.mockClear()
      expect(isRateLimited(userId)).toBe(true)
      expect(isRateLimited(userId)).toBe(true)
      expect(warnSpy).toHaveBeenCalledTimes(0)
    })

    it('should log when rate limit is removed after token refill', () => {
      const userId = 'recovery-test-user'

      // Spy on logger methods
      const infoSpy = spyOn(logger, 'info').mockImplementation(() => {})

      // Consume all tokens and hit rate limit
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(userId)
      }
      isRateLimited(userId) // Hit rate limit

      // Clear previous calls
      infoSpy.mockClear()

      // Advance time to refill tokens
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS

      // First request after refill should log recovery
      expect(isRateLimited(userId)).toBe(false)
      expect(infoSpy).toHaveBeenCalledTimes(1)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tokensRemaining: RATE_LIMIT_CONFIG.REFILL_RATE - 1, // One token consumed
        }),
        'User rate limit removed - tokens refilled',
      )

      // Subsequent requests should not log recovery
      infoSpy.mockClear()
      expect(isRateLimited(userId)).toBe(false)
      expect(infoSpy).toHaveBeenCalledTimes(0)
    })
  })

  describe('Edge Cases', () => {
    it('should handle very rapid consecutive requests', () => {
      const userId = 'rapid-user'

      // Make rapid requests without advancing time
      const results = []
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY + 5; i++) {
        results.push(isRateLimited(userId))
      }

      // First BUCKET_CAPACITY should be allowed
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        expect(results[i]).toBe(false)
      }

      // Remaining should be rate limited
      for (let i = RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i < results.length; i++) {
        expect(results[i]).toBe(true)
      }
    })

    it('should handle zero refill rate gracefully', () => {
      const userId = 'zero-refill-user'

      // Mock RATE_LIMIT_CONFIG temporarily
      const originalRefillRate = RATE_LIMIT_CONFIG.REFILL_RATE
      ;(RATE_LIMIT_CONFIG as any).REFILL_RATE = 0

      try {
        // Consume all tokens
        for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
          isRateLimited(userId)
        }

        // Advance time
        currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS * 2

        // Should still be rate limited (no refill)
        expect(isRateLimited(userId)).toBe(true)
      } finally {
        // Restore original config
        ;(RATE_LIMIT_CONFIG as any).REFILL_RATE = originalRefillRate
      }
    })

    it('should handle large time jumps correctly', () => {
      const userId = 'time-jump-user'

      // Consume all tokens
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        isRateLimited(userId)
      }

      // Jump far into the future
      currentTime += RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS * 1000

      // Should have full capacity again (but not more)
      for (let i = 0; i < RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        expect(isRateLimited(userId)).toBe(false)
      }

      expect(isRateLimited(userId)).toBe(true)
    })
  })
})
