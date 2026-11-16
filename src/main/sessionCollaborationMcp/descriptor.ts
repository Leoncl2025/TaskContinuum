import { COLLABORATION_MCP_DESCRIPTOR, CollaborationError } from '../../shared/sessionCollaboration'
import type { LocalCollaborationEndpoint } from '../../shared/sessionCollaboration'
import { FileTransferError } from '../../shared/fileTransfer'
import { defaultDataDirectory, readEndpoint, removeEndpoint, writeEndpoint } from '../fileTransferMcp/descriptor'

export { defaultDataDirectory }

function wrapDescriptorError(error: unknown, fallbackMessage: string): never {
  if (error instanceof CollaborationError) throw error
  if (error instanceof FileTransferError) {
    throw new CollaborationError(error.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'UNAVAILABLE', fallbackMessage)
  }
  throw new CollaborationError('UNAVAILABLE', fallbackMessage)
}

export async function readCollaborationEndpoint(directory: string): Promise<LocalCollaborationEndpoint> {
  try {
    return await readEndpoint(directory, COLLABORATION_MCP_DESCRIPTOR)
  } catch (error) {
    wrapDescriptorError(error, 'No valid local session collaboration bridge is available.')
  }
}

export async function writeCollaborationEndpoint(directory: string, endpoint: LocalCollaborationEndpoint): Promise<void> {
  try {
    await writeEndpoint(directory, endpoint, COLLABORATION_MCP_DESCRIPTOR)
  } catch {
    throw new CollaborationError('ACCESS_DENIED', 'Could not publish a private local session collaboration descriptor.')
  }
}

export async function removeCollaborationEndpoint(directory: string, endpoint: LocalCollaborationEndpoint): Promise<void> {
  await removeEndpoint(directory, endpoint, COLLABORATION_MCP_DESCRIPTOR)
}
