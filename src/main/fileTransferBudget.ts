import { FILE_TRANSFER_LIMITS, FileTransferError } from '../shared/fileTransfer'

export class FileTransferBudget {
  private readonly active = new Map<string, symbol>()

  acquire(deviceId: string): () => void {
    if (this.active.has(deviceId) || this.active.size >= FILE_TRANSFER_LIMITS.concurrent) {
      throw new FileTransferError('BUSY', 'Another file transfer is active for this device, or both global file slots are in use.')
    }
    const lease = Symbol()
    this.active.set(deviceId, lease)
    return () => { if (this.active.get(deviceId) === lease) this.active.delete(deviceId) }
  }
}
