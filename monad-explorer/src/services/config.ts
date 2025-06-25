import { ServiceConfig } from './types'

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  rpcUrl: process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  batchSize: 50,
  rateLimit: 10,
  cacheTimeout: 3600, // 1 hour
}

export const KNOWN_TOKEN_SIGNATURES = {
  ERC20_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ERC721_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ERC1155_SINGLE: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  ERC1155_BATCH: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'
}

export const ERC_INTERFACE_IDS = {
  ERC20: '0x36372b07', // supportsInterface selector
  ERC721: '0x80ac58cd',
  ERC1155: '0xd9b67a26'
}

export const TOKEN_ABI = {
  ERC20: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)'
  ],
  ERC721: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function supportsInterface(bytes4) view returns (bool)'
  ]
} 