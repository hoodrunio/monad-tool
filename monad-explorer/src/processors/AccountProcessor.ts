import { Account } from '../model'

/**
 * Account Processor following Single Responsibility Principle
 * Responsible only for processing blockchain accounts
 */
export class AccountProcessor {
  private readonly accounts: Map<string, Account> = new Map()

  /**
   * Processes an account address and creates/updates account entity
   * @param address - Account address
   * @param timestamp - Transaction timestamp
   * @param isContract - Whether the address is a contract
   */
  processAccount(address: string, timestamp: Date, isContract: boolean): void {
    if (!this.accounts.has(address)) {
      this.accounts.set(address, new Account({
        id: address,
        address: address,
        balance: 0n,
        transactionCount: 0,
        isContract: isContract,
        contractCode: null,
        createdAt: timestamp,
        contractType: isContract ? 'Contract' : 'EOA',
        isVerified: false,
        contractName: null,
        ensName: null,
      }))
    }

    const account = this.accounts.get(address)!
    account.transactionCount++
    
    // Update contract status if needed
    if (isContract && !account.isContract) {
      account.isContract = true
      account.contractType = 'Contract'
    }
  }

  /**
   * Gets all processed accounts
   * @returns Array of processed account entities
   */
  getProcessedAccounts(): Account[] {
    return [...this.accounts.values()]
  }

  /**
   * Clears the internal accounts cache
   */
  clear(): void {
    this.accounts.clear()
  }

  /**
   * Gets the number of processed accounts
   * @returns Number of processed accounts
   */
  getAccountCount(): number {
    return this.accounts.size
  }
} 