import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ID, REDIRECT_PATH, STS_TOKEN_ENDPOINT,
  RefreshTokenExpiredError, RefreshTokenReusedError, credentialFromTokenResponse,
  exchangeAuthorizationCode, exchangeRefreshToken, isRefreshTokenReusedError,
  generateDpopKeyPair, generatePkcePair, requestToken, signDpopJws,
} from '../../src/oauth.js'

describe('generatePkcePair', () => {
  it('produces a 43-128 char verifier and a base64url S256 challenge', () => {
    const pair = generatePkcePair()
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128)
    const expected = createHash('sha256').update(pair.codeVerifier).digest('base64url')
    expect(pair.codeChallenge).toBe(expected)
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('generateDpopKeyPair / signDpopJws', () => {
  it('generates a P-256 ES256 JWK pair and signs a dpop+jwt JWS', async () => {
    const pair = await generateDpopKeyPair()
    expect(pair.publicKeyJwk.kty).toBe('EC')
    expect(pair.publicKeyJwk.crv).toBe('P-256')
    expect(pair.privateKeyJwk.d).toBeTruthy()

    const jws = await signDpopJws(pair, 'POST', STS_TOKEN_ENDPOINT)
    const [headerB64, payloadB64] = jws.split('.')
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString())
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    expect(header).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' })
    expect(header.jwk).toEqual(pair.publicKeyJwk)
    expect(payload.htm).toBe('POST')
    expect(payload.htu).toBe(STS_TOKEN_ENDPOINT)
    expect(typeof payload.iat).toBe('number')
    expect(payload.jti).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exports the client constants expected by the portal', () => {
    expect(CLIENT_ID).toBe('codearts-agent')
    expect(REDIRECT_PATH).toBe('/oauth/callback')
    expect(STS_TOKEN_ENDPOINT).toBe('https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens')
  })
})

describe('requestToken / exchangeAuthorizationCode', () => {
  it('posts form-encoded body with DPoP header and resolves credentials', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({
        credentials: {
          access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
          expiration: '2026-08-15T00:00:00Z',
        },
        refresh_token: 'RT',
      }), { status: 200 }))
    const pair = await generateDpopKeyPair()
    const token = await exchangeAuthorizationCode('CODE', 'VERIFIER', 43123, pair, fetcher as unknown as typeof fetch)
    expect(token.credentials?.access_key_id).toBe('AK')
    expect(token.refresh_token).toBe('RT')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(STS_TOKEN_ENDPOINT)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('client_id')).toBe('codearts-agent')
    expect(body.get('code')).toBe('CODE')
    expect(body.get('code_verifier')).toBe('VERIFIER')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:43123/oauth/callback')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const dpop = headers['DPoP']
    expect(dpop).toBeTruthy()
    const payload = JSON.parse(Buffer.from(dpop!.split('.')[1], 'base64url').toString())
    expect(payload).toMatchObject({ htm: 'POST', htu: STS_TOKEN_ENDPOINT })
  })

  it('throws RefreshTokenExpiredError on invalid_grant', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    await expect(exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError on error_code InvalidDPoPHeader', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        error: 'invalid_dpop', error_code: 'InvalidDPoPHeader', error_msg: 'DPoP proof invalid',
      }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    await expect(exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws a plain Error on other failures', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const pair = await generateDpopKeyPair()
    await expect(requestToken({ grant_type: 'refresh_token' }, pair, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/failed/)
  })

  /**
   * `STS5.1806 the refresh token has been used` 在**一次性轮换**下通常意味着
   * 另一条并发路径刚刚成功消费了这份令牌并写回了新凭据 —— 那是「我们手里这份
   * 过期了」，**不是**「登录失效了」。
   *
   * 故它必须是**独立类型**：若归入 `RefreshTokenExpiredError` 终态，调度器会
   * 停止续期并要求重新登录，而存储里其实躺着一份完全可用的新凭据。
   */
  it('classifies STS5.1806 as RefreshTokenReusedError（不是终态 Expired）', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        error_code: 'STS5.1806',
        error_msg: 'the refresh token has been used',
      }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    const error = await exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenReusedError)
    // 关键反面判据：不得被当成终态 —— 否则并发消费会被误报成「请重新登录」。
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    // 结构化判定同样只看该码 / 该英文原文。
    expect(isRefreshTokenReusedError({ error_code: 'STS5.1806' })).toBe(true)
    expect(isRefreshTokenReusedError({ error_msg: 'The refresh token has been used' })).toBe(true)
    expect(isRefreshTokenReusedError({ error: 'invalid_grant' })).toBe(false)
    expect(isRefreshTokenReusedError(null)).toBe(false)
  })
})

describe('credentialFromTokenResponse', () => {
  it('maps credentials + refresh fields into the stored JSON shape', () => {
    const pair = { privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const credential = credentialFromTokenResponse({
      credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expiration: '2026-08-15T00:00:00Z' },
      refresh_token: 'RT',
    }, pkce, pair)
    expect(credential).toMatchObject({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
      code_verifier: 'V',
    })
    expect(credential.dpop_private_key_jwk).toEqual(pair.privateKeyJwk)
  })
})
