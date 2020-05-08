import { ExposedPromise } from '../../utils/exposed-promise'

import { Logger } from '../../utils/Logger'
import { generateGUID } from '../../utils/generate-uuid'
import { BeaconEvent, BeaconEventHandlerFunction, BeaconEventType } from '../../events'
import { BEACON_VERSION } from '../../constants'
import { getAddressFromPublicKey } from '../../utils/crypto'
import { ConnectionContext } from '../../types/ConnectionContext'
import {
  AccountInfo,
  Client,
  TransportType,
  Transport,
  StorageKey,
  BeaconMessageType,
  PermissionScope,
  PermissionResponse,
  NetworkType,
  SignPayloadResponse,
  SignPayloadRequest,
  OperationResponse,
  OperationRequest,
  BroadcastResponse,
  BroadcastRequest,
  BeaconErrorMessage,
  BeaconMessage,
  RequestPermissionInput,
  RequestSignPayloadInput,
  RequestOperationInput,
  RequestBroadcastInput,
  PermissionRequest,
  AppMetadata,
  BeaconBaseMessage,
  Serializer,
  LocalStorage,
  PermissionResponseOutput,
  PermissionRequestInput,
  SignPayloadResponseOutput,
  SignPayloadRequestInput,
  OperationResponseOutput,
  OperationRequestInput,
  BroadcastResponseOutput,
  BroadcastRequestInput,
  BeaconRequestInputMessage,
  BeaconResponseOutputMessage
} from '../..'
import { messageEvents } from '../../beacon-message-events'
import { IgnoredRequestInputProperties } from '../../types/beacon/messages/BeaconRequestInputMessage'
import { checkPermissions } from '../../utils/check-permissions'
import { getAccountIdentifier } from '../../utils/get-account-identifier'
import { DAppClientOptions } from './DAppClientOptions'

const logger = new Logger('DAppClient')

export class DAppClient extends Client {
  private readonly openRequests = new Map<
    string,
    ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >
  >()
  private readonly iconUrl?: string

  private activeAccount: AccountInfo | undefined

  public get isConnected(): Promise<boolean> {
    return this._isConnected.promise
  }

  constructor(config: DAppClientOptions) {
    super({
      storage: config.storage ? config.storage : new LocalStorage(),
      ...config
    })
    this.iconUrl = config.iconUrl

    this.storage
      .get(StorageKey.ACTIVE_ACCOUNT)
      .then(async (activeAccount) => {
        if (activeAccount) {
          await this.setActiveAccount(await this.getAccount(activeAccount))
        }
      })
      .catch((storageError) => {
        console.error(storageError)
      })

    this.handleResponse = (event: BeaconMessage, connectionInfo: ConnectionContext): void => {
      const openRequest = this.openRequests.get(event.id)
      if (openRequest) {
        logger.log('handleResponse', 'found openRequest', event.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errorMessage: BeaconErrorMessage = (event as any) as BeaconErrorMessage
        if (errorMessage.errorType) {
          openRequest.reject(errorMessage)
        } else {
          openRequest.resolve({ message: event, connectionInfo })
        }
        this.openRequests.delete(event.id)
      } else {
        logger.error('handleResponse', 'no request found for id ', event.id)
      }
    }
  }

  public addOpenRequest(
    id: string,
    promise: ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >
  ): void {
    logger.log('addOpenRequest', this.name, `adding request ${id} and waiting for answer`)
    this.openRequests.set(id, promise)
  }

  public async init(_isDapp?: boolean, transport?: Transport): Promise<TransportType> {
    const initResponse = await super.init(true, transport)

    return initResponse
  }

  public async getActiveAccount(): Promise<AccountInfo | undefined> {
    return this.activeAccount
  }

  public async setActiveAccount(account?: AccountInfo): Promise<void> {
    if (!account) {
      return
    }

    this.activeAccount = account

    await this.storage.set(StorageKey.ACTIVE_ACCOUNT, account.accountIdentifier)

    await this.events.emit(BeaconEvent.ACTIVE_ACCOUNT_SET, account)

    return
  }

  public async getAppMetadata(): Promise<AppMetadata> {
    return {
      beaconId: await this.beaconId,
      name: this.name,
      icon: this.iconUrl
    }
  }

  public async connect(): Promise<boolean> {
    return super._connect()
  }

  public async subscribeToEvent<K extends BeaconEvent>(
    internalEvent: K,
    eventCallback: BeaconEventHandlerFunction<BeaconEventType[K]>
  ): Promise<void> {
    await this.events.on(internalEvent, eventCallback)
  }

  public async checkPermissions(type: BeaconMessageType): Promise<boolean> {
    if (type === BeaconMessageType.PermissionRequest) {
      return true
    }

    const accountInfo = this.activeAccount

    if (!accountInfo) {
      throw new Error('No active account set!')
    }

    const permissions = accountInfo.scopes

    return checkPermissions(type, permissions)
  }

  public async requestPermissions(
    input?: RequestPermissionInput
  ): Promise<PermissionResponseOutput> {
    const request: PermissionRequestInput = {
      appMetadata: await this.getAppMetadata(),
      type: BeaconMessageType.PermissionRequest,
      network: input && input.network ? input.network : { type: NetworkType.MAINNET },
      scopes:
        input && input.scopes
          ? input.scopes
          : [PermissionScope.OPERATION_REQUEST, PermissionScope.SIGN]
    }

    const { message, connectionInfo } = await this.makeRequest<
      PermissionRequest,
      PermissionResponse
    >(request).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    await this.handleBeaconError(message)

    const address = await getAddressFromPublicKey(message.pubkey)

    const accountInfo: AccountInfo = {
      accountIdentifier: await getAccountIdentifier(message.pubkey, message.network),
      beaconId: message.beaconId,
      origin: {
        type: connectionInfo.origin,
        id: connectionInfo.id
      },
      address,
      pubkey: message.pubkey,
      network: message.network,
      scopes: message.scopes,
      connectedAt: new Date()
    }

    await this.addAccount(accountInfo)
    await this.setActiveAccount(accountInfo)
    console.log('permissions interception', { message, connectionInfo })

    const { beaconId, network, scopes } = message

    const output: PermissionResponseOutput = { beaconId, address, network, scopes }

    await this.notifySuccess(request, { output, connectionContext: connectionInfo })

    return output
  }

  public async requestSignPayload(
    input: RequestSignPayloadInput
  ): Promise<SignPayloadResponseOutput> {
    if (!input.payload) {
      throw new Error('Payload must be provided')
    }
    if (!this.activeAccount) {
      throw new Error('No active account!')
    }

    const request: SignPayloadRequestInput = {
      type: BeaconMessageType.SignPayloadRequest,
      payload: input.payload,
      sourceAddress: input.sourceAddress || this.activeAccount.address || ''
    }

    const { message, connectionInfo } = await this.makeRequest<
      SignPayloadRequest,
      SignPayloadResponse
    >(request).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })
    await this.handleBeaconError(message)

    const { beaconId, signature } = message

    const output: SignPayloadResponseOutput = { beaconId, signature }

    await this.notifySuccess(request, { output, connectionContext: connectionInfo })

    return output
  }

  public async requestOperation(input: RequestOperationInput): Promise<OperationResponseOutput> {
    if (!input.operationDetails) {
      throw new Error('Operation details must be provided')
    }
    if (!this.activeAccount) {
      throw new Error('No active account!')
    }

    const request: OperationRequestInput = {
      type: BeaconMessageType.OperationRequest,
      network: input.network || { type: NetworkType.MAINNET },
      operationDetails: input.operationDetails as any, // TODO: Fix type,
      sourceAddress: this.activeAccount.address || ''
    }

    const { message, connectionInfo } = await this.makeRequest<OperationRequest, OperationResponse>(
      request
    ).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })
    await this.handleBeaconError(message)

    const { beaconId, transactionHash } = message

    const output: OperationResponseOutput = { beaconId, transactionHash }

    await this.notifySuccess(request, { output, connectionContext: connectionInfo })

    return { beaconId, transactionHash }
  }

  public async requestBroadcast(input: RequestBroadcastInput): Promise<BroadcastResponseOutput> {
    if (!input.signedTransaction) {
      throw new Error('Signed transaction must be provided')
    }

    const request: BroadcastRequestInput = {
      type: BeaconMessageType.BroadcastRequest,
      network: input.network || { type: NetworkType.MAINNET },
      signedTransaction: input.signedTransaction
    }

    const { message, connectionInfo } = await this.makeRequest<BroadcastRequest, BroadcastResponse>(
      request
    ).catch(async (requestError: BeaconErrorMessage) => {
      throw this.handleRequestError(request, requestError)
    })

    await this.handleBeaconError(message)

    const { beaconId, transactionHash } = message

    const output: BroadcastResponseOutput = { beaconId, transactionHash }

    await this.notifySuccess(request, { output, connectionContext: connectionInfo })

    return { beaconId, transactionHash }
  }

  private async handleRequestError(
    request: BeaconRequestInputMessage,
    error: BeaconErrorMessage
  ): Promise<void> {
    console.error('requestError', error)
    this.events
      .emit(messageEvents[request.type].error, error)
      .catch((emitError) => console.warn(emitError))
    throw error
  }

  private async notifySuccess(
    request: BeaconRequestInputMessage,
    response: { output: BeaconResponseOutputMessage; connectionContext: ConnectionContext }
  ): Promise<void> {
    this.events
      .emit(messageEvents[request.type].success, response)
      .catch((emitError) => console.warn(emitError))
  }

  private async handleBeaconError(message: BeaconBaseMessage): Promise<void> {
    const errorMessage = message as BeaconErrorMessage
    if (errorMessage.errorType) {
      console.log('error', errorMessage.errorType)
      throw new Error(errorMessage.errorType)
    }
  }

  private async makeRequest<T extends BeaconRequestInputMessage, U extends BeaconMessage>(
    requestInput: Omit<T, IgnoredRequestInputProperties>
  ): Promise<{
    message: U
    connectionInfo: ConnectionContext
  }> {
    logger.log('makeRequest')
    await this.init()
    await this.connect()
    logger.log('makeRequest', 'after connecting')

    if (await this.addRequestAndCheckIfRateLimited()) {
      this.events
        .emit(BeaconEvent.LOCAL_RATE_LIMIT_REACHED)
        .catch((emitError) => console.warn(emitError))

      throw new Error('rate limit reached')
    }

    if (!(await this.checkPermissions(requestInput.type))) {
      this.events.emit(BeaconEvent.NO_PERMISSIONS).catch((emitError) => console.warn(emitError))

      throw new Error('No permissions to send this request to wallet!')
    }

    this.events
      .emit(messageEvents[requestInput.type].sent)
      .catch((emitError) => console.warn(emitError))

    if (!this.beaconId) {
      throw new Error('BeaconID not defined')
    }

    const request: Omit<T, IgnoredRequestInputProperties> &
      Pick<U, IgnoredRequestInputProperties> = {
      id: generateGUID(),
      version: BEACON_VERSION,
      beaconId: await this.beaconId,
      ...requestInput
    }

    const exposed = new ExposedPromise<
      { message: BeaconMessage; connectionInfo: ConnectionContext },
      BeaconErrorMessage
    >()

    this.addOpenRequest(request.id, exposed)

    const payload = await new Serializer().serialize(request)

    await (await this.transport).send(payload)

    return exposed.promise as any // TODO: fix type
  }
}