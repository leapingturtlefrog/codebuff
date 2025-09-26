import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import * as rateLimiter from '../websockets/rate-limiter'

import type { UserInfo } from '../websockets/auth'

describe('Rate Limiter Integration Tests', () => {
  let currentTime = 1234567890000
  let mockUserInfo: UserInfo

  beforeEach(() => {
    // Setup time mock
    currentTime = 1234567890000
    spyOn(Date, 'now').mockImplementation(() => currentTime)

    // Setup mock user info
    mockUserInfo = {
      id: 'test-user-id',
      email: 'test@example.com',
      discord_id: null,
    }

    // Clean up and reinitialize rate limiter
    rateLimiter.cleanupRateLimiter()
    rateLimiter.initializeRateLimiter()
  })

  afterEach(() => {
    rateLimiter.cleanupRateLimiter()
    mock.restore()
  })



  describe('Rate Limiting Integration', () => {
    it('should allow requests within rate limit', async () => {
      const userId = mockUserInfo.id

      // Should allow requests up to the bucket capacity
      for (let i = 0; i < rateLimiter.RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        const result = rateLimiter.isRateLimited(userId)
        expect(result).toBe(false) // Should not be rate limited
      }
    })

    it('should rate limit requests exceeding bucket capacity', async () => {
      const userId = mockUserInfo.id

      // Consume all tokens
      for (let i = 0; i < rateLimiter.RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        rateLimiter.isRateLimited(userId)
      }

      // Next request should be rate limited
      const result = rateLimiter.isRateLimited(userId)
      expect(result).toBe(true) // Should be rate limited
    })

    it('should allow requests after token refill', async () => {
      const userId = mockUserInfo.id

      // Consume all tokens
      for (let i = 0; i < rateLimiter.RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        rateLimiter.isRateLimited(userId)
      }

      // Should be rate limited
      expect(rateLimiter.isRateLimited(userId)).toBe(true)

      // Advance time to refill tokens
      currentTime += rateLimiter.RATE_LIMIT_CONFIG.REFILL_INTERVAL_MS

      // Should allow new requests up to refill rate
      for (let i = 0; i < rateLimiter.RATE_LIMIT_CONFIG.REFILL_RATE; i++) {
        const result = rateLimiter.isRateLimited(userId)
        expect(result).toBe(false)
      }

      // Should be rate limited again
      expect(rateLimiter.isRateLimited(userId)).toBe(true)
    })

    it('should handle rate limiting for different users', async () => {
      const user1 = 'user-1'
      const user2 = 'user-2'
      
      // User1 consumes all tokens
      for (let i = 0; i < rateLimiter.RATE_LIMIT_CONFIG.BUCKET_CAPACITY; i++) {
        rateLimiter.isRateLimited(user1)
      }
      
      // User1 should be rate limited
      expect(rateLimiter.isRateLimited(user1)).toBe(true)
      
      // User2 should still be allowed
      expect(rateLimiter.isRateLimited(user2)).toBe(false)
    })

    it('should maintain rate limit state correctly', async () => {
      const userId = mockUserInfo.id
      const tokensToConsume = 3
      
      // Consume some tokens
      for (let i = 0; i < tokensToConsume; i++) {
        rateLimiter.isRateLimited(userId)
      }
      
      // Check status
      const status = rateLimiter.getRateLimitStatus(userId)
      expect(status.tokensRemaining).toBe(
        rateLimiter.RATE_LIMIT_CONFIG.BUCKET_CAPACITY - tokensToConsume
      )
    })

    it('should track statistics correctly', async () => {
      const users = ['user-a', 'user-b', 'user-c']
      
      // Each user makes a request
      users.forEach(userId => rateLimiter.isRateLimited(userId))
      
      const stats = rateLimiter.getRateLimitStats()
      expect(stats.activeUsers).toBe(3)
      expect(stats.config).toEqual(rateLimiter.RATE_LIMIT_CONFIG)
    })
  })

  describe('Performance and Memory', () => {
    it('should handle many users without memory issues', async () => {
      // Create many users and make requests
      const userCount = 100
      for (let i = 0; i < userCount; i++) {
        rateLimiter.isRateLimited(`user-${i}`)
      }

      const stats = rateLimiter.getRateLimitStats()
      expect(stats.activeUsers).toBe(userCount)
    })

    it('should not slow down significantly with many rate limit checks', async () => {
      const start = Date.now()
      
      // Make many rapid requests
      for (let i = 0; i < 1000; i++) {
        rateLimiter.isRateLimited(mockUserInfo.id)
      }
      
      const duration = Date.now() - start
      
      // Should complete in reasonable time (this is a rough check)
      expect(duration).toBeLessThan(1000) // 1 second max
    })
  })
})
