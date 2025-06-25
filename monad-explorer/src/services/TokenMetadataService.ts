import {ethers} from 'ethers'

// Standard ERC20 ABI for metadata calls
const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)', 
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)'
]

// Standard ERC721 ABI
const ERC721_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function supportsInterface(bytes4) view returns (bool)'
]

export interface TokenMetadata {
    name: string
    symbol: string
    decimals: number
    totalSupply: bigint
    tokenType: 'ERC20' | 'ERC721' | 'ERC1155' | 'UNKNOWN'
}

export class TokenMetadataService {
    private provider: ethers.JsonRpcProvider
    private cache: Map<string, TokenMetadata> = new Map()

    constructor(rpcUrl: string) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl)
    }

    async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
        // Check cache first
        if (this.cache.has(tokenAddress.toLowerCase())) {
            return this.cache.get(tokenAddress.toLowerCase())!
        }

        try {
            // Try ERC20 first (most common)
            const metadata = await this.tryERC20(tokenAddress)
            if (metadata) {
                this.cache.set(tokenAddress.toLowerCase(), metadata)
                return metadata
            }

            // Try ERC721
            const nftMetadata = await this.tryERC721(tokenAddress)
            if (nftMetadata) {
                this.cache.set(tokenAddress.toLowerCase(), nftMetadata)
                return nftMetadata
            }

            // Return unknown if all fail
            const unknownMetadata: TokenMetadata = {
                name: `Unknown Token ${tokenAddress.slice(0, 8)}...`,
                symbol: 'UNKNOWN',
                decimals: 18,
                totalSupply: 0n,
                tokenType: 'UNKNOWN'
            }
            this.cache.set(tokenAddress.toLowerCase(), unknownMetadata)
            return unknownMetadata

        } catch (error) {
            console.warn(`Failed to fetch metadata for token ${tokenAddress}:`, error)
            return null
        }
    }

    private async tryERC20(tokenAddress: string): Promise<TokenMetadata | null> {
        try {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider)
            
            const [name, symbol, decimals, totalSupply] = await Promise.all([
                contract.name(),
                contract.symbol(),
                contract.decimals(),
                contract.totalSupply()
            ])

            return {
                name: name || 'Unknown',
                symbol: symbol || 'UNKNOWN',
                decimals: Number(decimals) || 18,
                totalSupply: BigInt(totalSupply.toString()),
                tokenType: 'ERC20'
            }
        } catch (error) {
            return null
        }
    }

    private async tryERC721(tokenAddress: string): Promise<TokenMetadata | null> {
        try {
            const contract = new ethers.Contract(tokenAddress, ERC721_ABI, this.provider)
            
            // Check if it supports ERC721 interface (0x80ac58cd)
            const supportsERC721 = await contract.supportsInterface('0x80ac58cd')
            if (!supportsERC721) {
                return null
            }

            const [name, symbol, totalSupply] = await Promise.all([
                contract.name(),
                contract.symbol(),
                contract.totalSupply().catch(() => 0n) // totalSupply might not exist
            ])

            return {
                name: name || 'Unknown NFT',
                symbol: symbol || 'NFT',
                decimals: 0, // NFTs don't have decimals
                totalSupply: BigInt(totalSupply.toString()),
                tokenType: 'ERC721'
            }
        } catch (error) {
            return null
        }
    }

    // Batch fetch multiple tokens efficiently
    async getTokenMetadataBatch(tokenAddresses: string[]): Promise<Map<string, TokenMetadata>> {
        const results = new Map<string, TokenMetadata>()
        
        // Get unique addresses
        const uniqueAddresses = [...new Set(tokenAddresses.map(addr => addr.toLowerCase()))]
        
        // Process in parallel but with rate limiting
        const batchSize = 10
        for (let i = 0; i < uniqueAddresses.length; i += batchSize) {
            const batch = uniqueAddresses.slice(i, i + batchSize)
            const promises = batch.map(async (address) => {
                const metadata = await this.getTokenMetadata(address)
                if (metadata) {
                    results.set(address, metadata)
                }
            })
            
            await Promise.allSettled(promises)
            
            // Small delay to avoid overwhelming the RPC
            if (i + batchSize < uniqueAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 100))
            }
        }
        
        return results
    }
} 