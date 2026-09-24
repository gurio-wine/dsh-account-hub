/**
 * Account Hub 管理 API 调用函数。
 *
 * Host 侧通过 connection.fetch.register() 注册 HTTP API 端点，
 * Client 侧通过 connection.rpc.call() 调用。
 *
 * 路径格式：
 *   Host 注册：/api/account-hub
 *   Client 调用：connection.rpc.call('/api', <channel 去掉前导斜杠>, { method, payload }, signal)
 *   例：channel = '/account-hub' → connection.rpc.call('/api', 'account-hub', ...)
 *   —— 第二实参即传入 channel 去掉前导 `/` 的结果
 *
 * endpoint 由调用方传入的 channel 派生（`'/account-hub'` → `'account-hub'`），
 * 本文件不持有端点名常量：宿主端点名与客户端通道名是同一事实，只允许有一处声明。
 */

/**
 * 调用 Account Hub 管理 API。
 *
 * @param {import('@deepseek-ai/dsh-connection').Connection} connection
 * @param {string} channel  通道名（如 '/account-hub'）；去掉首个 `/` 即宿主端点名
 * @param {string} method  端点方法名（如 'account.list'）
 * @param {unknown} payload  请求载荷
 * @param {AbortSignal} [signal]  可选的取消信号
 * @returns {Promise<unknown>}  RPC 响应结果
 */
export function callManagementRpc(connection, channel, method, payload, signal) {
  // 使用 DSH 的标准 RPC 模式：
  // connection.rpc.call(mountPoint, endpoint, payload, signal)
  // mountPoint = '/api'，endpoint 由 channel 去掉前导斜杠得到（'/account-hub' → 'account-hub'）
  // payload = { method: 'account.list', payload: { provider: 'buddy-cn' } }
  return connection.rpc.call('/api', channel.replace(/^\//, ''), { method, payload }, signal)
}

/**
 * 解包 RPC 响应结果。
 * DSH connection.rpc.call 返回 { ok, value?, error? } 格式。
 * 如果 ok=true 返回 value，否则抛出 error。
 */
export function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = new Error(result.error?.message || 'Account Hub API 请求失败')
    error.code = result.error?.code
    throw error
  }
  return result
}
