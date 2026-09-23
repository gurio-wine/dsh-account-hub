/**
 * Account Hub 管理页面客户端插件。
 *
 * 注册 Account Hub 设置页面到 DSH settings.section slot。
 */

export const name = 'account-hub-client'
export const inject = ['slots', 'connection']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installAccountHubStyles } from './account-hub-styles.js'
import { ACCOUNT_HUB_RPC_CHANNEL, AccountHubPage } from './account-hub.js'

export function apply(ctx) {
  ctx.effect(() => installAccountHubStyles(), 'account-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, ACCOUNT_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account-hub',
    order: 50,
    label: () => '账号中心',
    inject: () => ({ rpcCall }),
  }, AccountHubPage))
}
