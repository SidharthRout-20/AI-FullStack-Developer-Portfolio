import { describe, expect, it, vi } from 'vitest'

vi.mock('@neon/auth', () => {
  throw new Error('the Neon client must not load for visitors who never signed in')
})

describe('optional sign-in', () => {
  it("doesn't load the auth client or send a token for someone who never signed in", async () => {
    const { accountState, accountToken, loadAccount } = await import('./account')
    await loadAccount()
    expect(accountState()).toEqual({ user: null, ready: true })
    expect(await accountToken()).toBeNull()
  })
})
