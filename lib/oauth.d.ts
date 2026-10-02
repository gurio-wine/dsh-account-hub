import type { CodeArtsCredential } from './types.js';
/** CodeArts Agent 的 OAuth client_id（即其 URI scheme，来自 product.json）。 */
export declare const CLIENT_ID = "codearts-agent";
/** 本地回调路径（对齐真实插件的 AUTH_REDIRECT_URL）。 */
export declare const REDIRECT_PATH = "/oauth/callback";
/** 华为 STS token 端点（对齐真实插件的 IAM_TOKEN_API）。 */
export declare const STS_TOKEN_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
/** token 请求超时（与真实插件一致）。 */
export declare const TOKEN_TIMEOUT_MS = 60000;
/** OAuth 授权码换取。 */
export declare const GRANT_AUTHORIZATION_CODE = "authorization_code";
/** OAuth 刷新令牌换取。 */
export declare const GRANT_REFRESH_TOKEN = "refresh_token";
/** PKCE 配对：验证器 + S256 挑战。 */
export interface PkcePair {
    codeVerifier: string;
    codeChallenge: string;
}
/** DPoP ES256 公钥 JWK（不含私钥材料）。 */
export interface DpopPublicJwk {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
}
/** DPoP ES256 私钥 JWK（仅持久化 privateKeyJwk）。 */
export interface DpopPrivateJwk extends DpopPublicJwk {
    d: string;
}
/** DPoP 密钥对（JWK 形式）。 */
export interface DpopKeyPair {
    privateKeyJwk: DpopPrivateJwk;
    publicKeyJwk: DpopPublicJwk;
}
/** /v1/oauth2/tokens 的响应体（换取所需字段）。 */
export interface TokenResponse {
    credentials?: {
        access_key_id?: string;
        secret_access_key?: string;
        security_token?: string;
        expiration?: string;
    };
    refresh_token?: string;
    error?: string;
    error_code?: string;
    error_msg?: string;
}
/** 生成 PKCE 配对：verifier 随机 48 字节 base64url，challenge 为 S256。 */
export declare function generatePkcePair(): PkcePair;
/** 生成 ES256（P-256）DPoP 密钥对，JWK 形式。 */
export declare function generateDpopKeyPair(): Promise<DpopKeyPair>;
/** 用持久化的 DPoP 私钥签发 dpop+jwt JWS（htm=HTTP 方法，htu=完整 URL）。 */
export declare function signDpopJws(keyPair: DpopKeyPair, htm: string, htu: string): Promise<string>;
/** refresh_token 已失效/被拒绝时抛出的错误；调度器据此停止续期。 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/**
 * refresh_token **已被使用过**（`STS5.1806 the refresh token has been used`）。
 *
 * ⚠️ **刻意不是** {@link RefreshTokenExpiredError}：刷新令牌是**一次性轮换**的，
 * 「已使用」通常意味着**另一条并发路径刚刚成功消费了它并写回了新令牌** ——
 * 那是「我们手里这份过期了」，而不是「登录失效了」。若把它归入终态，调度器会
 * 停止续期并要求用户重新登录，而存储里其实躺着一份**完全可用**的新凭据。
 *
 * 正确的处置是**重读存储**：拿到别人写回的新 `refresh_token` 再试一次
 * （见 `src/service.ts` 的 `exchangeWithReuseRetry`）。只有重读后**令牌没变**
 * （说明没有并发消费者）才该走失败分类。
 */
export declare class RefreshTokenReusedError extends Error {
    constructor(message: string);
}
/**
 * 判定错误体是否为「refresh_token 已被使用」（一次性轮换下的并发消费信号）。
 *
 * 判据取**后端错误码 `STS5.1806` 与英文原文**两条：前者与语言无关、是主判据；
 * 后者是网关只回文案时的兜底（两者都未见反例）。
 */
export declare function isRefreshTokenReusedError(data: TokenResponse | null): boolean;
/** 向 STS token 端点发起一次带 DPoP 的 token 请求。 */
export declare function requestToken(body: Record<string, string>, keyPair: DpopKeyPair, fetcher?: typeof fetch): Promise<TokenResponse>;
/** 授权码换取（登录回调收到 code 后调用）。 */
export declare function exchangeAuthorizationCode(code: string, codeVerifier: string, port: number, keyPair: DpopKeyPair, fetcher?: typeof fetch): Promise<TokenResponse>;
/** 刷新令牌换取（静默续期）。 */
export declare function exchangeRefreshToken(refreshToken: string, codeVerifier: string, keyPair: DpopKeyPair, fetcher?: typeof fetch): Promise<TokenResponse>;
/** 将 token 响应组装为持久化凭据 JSON（含刷新所需字段）。 */
export declare function credentialFromTokenResponse(token: TokenResponse, pkce: PkcePair, keyPair: DpopKeyPair): CodeArtsCredential;
/** 从持久化的私钥 JWK 恢复 DPoP 密钥对（公钥可从私钥 JWK 的 x/y 字段重建）。 */
export declare function keyPairFromStoredJwk(jwk: DpopPrivateJwk): DpopKeyPair;
//# sourceMappingURL=oauth.d.ts.map