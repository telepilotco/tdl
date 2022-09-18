// @flow

import { resolve as resolvePath } from 'path'
import EventEmitter from 'eventemitter3'
import Debug from 'debug'
import uuidv4 from '../vendor/uuidv4'
import { deepRenameKey, deepRenameKey_, mergeDeepRight } from './util'
import * as prompt from './prompt'
import { Version } from './version'

import type { TDLibClient, ITDLibJSON } from 'tdl-shared'
import type {
  ConfigType,
  StrictConfigType,
  LoginDetails,
  StrictLoginDetails,
  LoginUser,
  LoginBot
} from './types'
import type {
  TDFunction,
  // TDObject,
  Update as Td$Update,
  updateAuthorizationState as Td$updateAuthorizationState,
  // updateOption as Td$updateOption,
  error as Td$error,
  ConnectionState as Td$ConnectionState,
  Invoke,
  Execute
} from 'tdlib-types'

const debug = Debug('tdl:client')
const debugEmitter = Debug('tdl:client:emitter')
const debugRes = Debug('tdl:client:response')
const debugReq = Debug('tdl:client:request')

const defaultLoginDetails: StrictLoginDetails = {
  type: 'user',
  getPhoneNumber: prompt.getPhoneNumber,
  getEmailAddress: prompt.getEmailAddress,
  getEmailCode: prompt.getEmailCode,
  confirmOnAnotherDevice: prompt.confirmOnAnotherDevice,
  getAuthCode: prompt.getAuthCode,
  getPassword: prompt.getPassword,
  getName: prompt.getName
}

const defaultOptions: $Exact<StrictConfigType> = {
  databaseDirectory: '_td_database',
  filesDirectory: '_td_files',
  databaseEncryptionKey: '',
  verbosityLevel: 2,
  receiveTimeout: 10,
  skipOldUpdates: false,
  useTestDc: false,
  useMutableRename: false,
  useDefaultVerbosityLevel: false,
  disableAuth: false,
  tdlibParameters: {
    use_message_database: true,
    use_secret_chats: false,
    system_language_code: 'en',
    application_version: '1.0',
    device_model: 'Unknown device',
    system_version: 'Unknown',
    enable_storage_optimizer: true
  }
}

type DeferredPromise<R, E> = {
  resolve: (result: R) => void,
  reject: (error: E) => void
}

// Flow was too slow with `TDObject`
type PendingPromise = DeferredPromise<any/* TDObject */, Td$error>

class TdlDeferred<R, E> {
  _innerDefer: ?DeferredPromise<R, E>
  _done: boolean = false

  // Not done or defer not set
  isPending (): boolean {
    return !this._done
  }

  isDone (): boolean {
    return this._done
  }

  isDeferSet (): boolean {
    return this._innerDefer != null
  }

  setDefer (defer: DeferredPromise<R, E>): void {
    this._innerDefer = defer
  }

  resolve (result: R): void {
    if (this._done || !this._innerDefer) return
    this._done = true
    this._innerDefer.resolve(result)
  }

  reject (error: E): void {
    if (this._done || !this._innerDefer) return
    this._done = true
    this._innerDefer.reject(error)
  }
}

export class TdlError extends Error {
  +err: any
  constructor (err: any, msg?: string) {
    super(msg)
    this.err = err
  }
}

export type On =
  & ((event: 'update', listener: (update: Td$Update) => void) => Client)
  & ((event: 'error', listener: (err: Td$error | TdlError) => void) => Client)
  & ((event: 'destroy', listener: () => void) => Client)
  & ((event: 'auth-needed', listener: () => void) => Client)
  & ((event: 'auth-not-needed', listener: () => void) => Client)
  & ((event: 'response', listener: (res: any) => void) => Client)

export type Emit =
  & ((event: 'update', update: Td$Update) => void)
  & ((event: 'error', err: Td$error | TdlError) => void)
  & ((event: 'destroy') => void)
  & ((event: 'auth-needed') => void)
  & ((event: 'auth-not-needed') => void)
  & ((event: 'response', res: any) => void)

export type Off =
  & ((event: 'update', listener: (...args: any[]) => any, once?: boolean) => void)
  & ((event: 'error', listener: (...args: any[]) => any, once?: boolean) => void)
  & ((event: 'destroy', listener: (...args: any[]) => any, once?: boolean) => void)
  & ((event: 'auth-needed', listener: (...args: any[]) => any, once?: boolean) => void)
  & ((event: 'auth-not-needed', listener: (...args: any[]) => any, once?: boolean) => void)
  & ((event: 'response', listener: (...args: any[]) => any, once?: boolean) => void)

const empty = () => ({})

function invariant (cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const TDLIB_1_8_6 = new Version('1.8.6')
const TDLIB_DEFAULT = new Version('1.8.0')

const TDL_MAGIC = '6c47e6b71ea'

// Note: The public methods in Client are defined as properties.
// The users of the library are not meant to extend Client.

// Many of the functions in Client contain some complicated control flow,
// but it should be fine on a small scale.

export class Client {
  +_options: StrictConfigType;
  +_emitter: EventEmitter = new EventEmitter();
  +_fetching: Map<string, PendingPromise> = new Map();
  +_tdlib: ITDLibJSON;
  _client: ?TDLibClient
  _initialized: boolean = false
  _paused: boolean = false
  _connectionState: Td$ConnectionState = { _: 'connectionStateConnecting' }
  _connectDefer: TdlDeferred<void, any> = new TdlDeferred()
  _authNeeded: boolean = false
  _loginDetails: ?StrictLoginDetails
  _loginDefer: TdlDeferred<void, any> = new TdlDeferred()
  _version: Version = TDLIB_DEFAULT

  constructor (tdlibInstance: ITDLibJSON, options: ConfigType = {}) {
    this._options = (mergeDeepRight(defaultOptions, options): StrictConfigType)

    if (!options.apiId && !options.tdlibParameters?.api_id)
      throw new TypeError('Valid api_id must be provided.')

    if (!options.apiHash && !options.tdlibParameters?.api_hash)
      throw new TypeError('Valid api_hash must be provided.')

    this._tdlib = tdlibInstance
  }

  static create (tdlibInstance: ITDLibJSON, options: ConfigType = {}): Client {
    return new Client(tdlibInstance, options)
  }

  getBackendName = (): string => {
    return this._tdlib.getName()
  }

  getVersion = (): string => {
    if (this._version === TDLIB_DEFAULT)
      throw new Error('Unknown TDLib version')
    return this._version.toString()
  }

  _catchError (err: Td$error | TdlError): void {
    debug('catchError', err)

    const fn = d => d.isPending()
    const defers = [this._connectDefer, this._loginDefer].filter(fn)

    if (defers.length === 0) {
      this.emit('error', err)
      return
    }

    for (const deferred of defers)
      deferred.reject(err)
  }

  _rejectConnectAndLogin (err: Error): void {
    this._connectDefer.reject(err)
    this._loginDefer.reject(err)
  }

  _init (): void {
    try {
      if (!this._options.useDefaultVerbosityLevel) {
        debug('_init: setLogVerbosityLevel', this._options.verbosityLevel)
        this._tdlib.execute(null, {
          '@type': 'setLogVerbosityLevel',
          new_verbosity_level: this._options.verbosityLevel
        })
      }

      this._client = this._tdlib.create()
    } catch (e) {
      this._catchError(new TdlError(e, 'Error while creating client'))
      return
    }

    this._initialized = true

    if (this._options.disableAuth)
      this._connectDefer.resolve()

    this._loop()
      .catch(e => this._catchError(new TdlError(e)))
  }

  connect = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (this._initialized) {
        const err = this._client
          ? Error('The client is already initialized')
          : Error('Cannot re-initialize a destroyed client')
        return reject(err)
      }
      this._connectDefer.setDefer({ resolve, reject })
      this._init()
    })
  }

  login = (getLoginDetails: () => LoginDetails = empty): Promise<void> => {
    debug('client.login()')
    this._emitter.once('auth-needed', () => {
      this._loginDetails = (mergeDeepRight(
        defaultLoginDetails, getLoginDetails()): $FlowIgnore)
      debug('set _loginDetails to', this._loginDetails)
    })
    return new Promise((resolve, reject) => {
      this._loginDefer.setDefer({ resolve, reject })
      this._emitter.emit('_login')
    })
  }

  // Wait until the 'login' function is called
  _waitLogin (): Promise<void> {
    debug('waitLogin', this._loginDefer)
    return new Promise(resolve => {
      if (this._loginDefer.isDeferSet()) return resolve()
      this._emitter.once('_login', () => resolve())
    })
  }

  _authHasNeeded (): StrictLoginDetails {
    if (this._authNeeded) {
      invariant(this._loginDetails != null,
        '_authHasNeeded: (_authNeeded true) loginDetails should be set')
      return this._loginDetails
    }
    this._authNeeded = true
    this.emit('auth-needed')
    invariant(this._loginDetails != null,
      '_authHasNeeded: (_authNeeded false) loginDetails should be set')
    return this._loginDetails
  }

  connectAndLogin = async (fn: () => LoginDetails = empty): Promise<void> => {
    await this.connect()
    return this.login(fn)
  }

  /** @deprecated */
  pause = (): void => {
    if (!this._paused) {
      debug('pause')
      this._paused = true
    } else {
      debug('pause (no-op)')
    }
  }

  /** @deprecated */
  resume = (): void => {
    if (this._paused) {
      debug('resume')
      this._paused = false
      this._emitter.emit('_resume')
    } else {
      debug('resume (no-op)')
    }
  }

  // Wait until the 'resume' function is called
  _waitResume (): Promise<void> {
    return new Promise(resolve => {
      if (!this._paused) resolve()
      this._emitter.once('_resume', () => resolve())
    })
  }

  on: On = (event, listener) => {
    this._emitter.on(event, listener)
    return this
  }

  once: On = (event, listener) => {
    this._emitter.once(event, listener)
    return this
  }

  off: Off = (event, listener, once = false) => {
    this._emitter.removeListener(event, listener, undefined, once)
  }

  addListener: On = this.on

  removeListener: Off = this.off

  emit: Emit = (event, value) => {
    debugEmitter('emit', event, value)
    this._emitter.emit(event, value)
  }

  invoke: Invoke = async request => {
    const id = uuidv4()
    // $FlowIgnore[prop-missing]
    request['@extra'] = id
    const receiveResponse = new Promise((resolve, reject) => {
      // This promise must not be rejected with values other than Td$error
      // for Fluture types to be correct
      try {
        const defer = { resolve, reject }
        this._fetching.set(id, defer)
      } catch (e) {
        this._catchError(new TdlError(e))
      }
    })
    this._send(request)
    return receiveResponse
  }

  destroy = (): void => {
    if (!this._client) return
    this._tdlib.destroy(this._client)
    this._client = null
    this.resume()
    this.emit('destroy')
  }

  // Sends { _: 'close' } and waits until the client gets destroyed
  close = (): Promise<void> => {
    debug('close')
    return new Promise(resolve => {
      if (!this._client) return resolve()
      // TODO: call this.resume() here?
      // If the client is paused, we can't receive authorizationStateClosed
      // and destroy won't be called
      this._sendTdl({ _: 'close' })
      this._emitter.once('destroy', () => resolve())
    })
  }

  setLogFatalErrorCallback = (fn: null | (errorMessage: string) => void): void => {
    this._tdlib.setLogFatalErrorCallback(fn)
  }

  // tdl renames '@type' to '_'.
  // Initially it was because Flow didn't support disjoint unions
  // if the tag is referenced via square brackets.
  // (https://flow.org/en/docs/lang/refinements/)
  // It was fixed, but I kept the renaming, since it's more convenient
  // to write if (o._ === '...') instead of if (o['@type'] === '...')

  execute: Execute = request => {
    debugReq('execute', request)
    if (!this._client) return null
    const { _client: client } = this
    const tdRequest = deepRenameKey('_', '@type', request)
    const tdResponse = this._tdlib.execute(client, tdRequest)
    return tdResponse && deepRenameKey('@type', '_', tdResponse)
  }

  _send (request: TDFunction): void {
    debugReq('send', request)
    if (!this._client) return
    const { _client: client } = this
    const tdRequest = deepRenameKey('_', '@type', request)
    this._tdlib.send(client, tdRequest)
  }

  _sendTdl (request: TDFunction): void {
    // $FlowIgnore[prop-missing]
    this._send({ ...request, '@extra': TDL_MAGIC })
  }

  async _receive (timeout: number = this._options.receiveTimeout): Promise<any/*TDObject*/ | null> {
    if (!this._client) return null
    const tdResponse = await this._tdlib.receive(this._client, timeout)
    // Note: Immutable rename is used to preserve key order (for better logs)
    return tdResponse && (this._options.useMutableRename
      ? deepRenameKey_('@type', '_', tdResponse)
      : deepRenameKey('@type', '_', tdResponse))
  }

  async _loop (): Promise<void> {
    while (true) {
      try {
        if (this._paused) {
          debug('receive loop: waiting for resume')
          await this._waitResume()
          debug('receive loop: resumed')
        }

        if (!this._client) {
          debug('receive loop: no client')
          break
        }

        const response = await this._receive()

        if (response)
          await this._handleResponse(response)
        else
          debug('receive loop: response is empty')
      } catch (e) {
        this._catchError(new TdlError(e))
      }
    }
    debug('receive loop: end')
  }

  async _handleResponse (res: any): Promise<void> {
    this.emit('response', res)
    debugRes(res)

    if (res._ === 'error')
      return this._handleError(res)

    const id = res['@extra']
    const defer = this._fetching.get(id)

    if (defer) {
      delete res['@extra']
      defer.resolve(res)
      this._fetching.delete(id)
    } else if (id !== TDL_MAGIC) {
      return this._handleUpdate(res)
    } else {
      debug('(TDL_MAGIC) Not emitting response', res)
    }
  }

  async _handleUpdate (update: Td$Update): Promise<void> {
    // updateOption, updateConnectionState, updateAuthorizationState
    // are always emitted, even with skipOldUpdates set to true
    switch (update._) {
      case 'updateOption':
        debug('New option:', update)
        this.emit('update', update)
        if (update.name === 'version' && update.value._ === 'optionValueString')
          this._version = new Version(update.value.value)
        return

      case 'updateConnectionState':
        debug('New connection state:', update.state)
        this._connectionState = update.state
        this.emit('update', update)
        return

      case 'updateAuthorizationState':
        debug('New authorization state:', update.authorization_state._)
        this.emit('update', update)
        if (!this._options.disableAuth)
          this._handleAuth(update).catch(e => this._catchError(new TdlError(e)))
        return

      default:
        const shouldSkip = this._options.skipOldUpdates
          && this._connectionState._ === 'connectionStateUpdating'
        if (shouldSkip) return
        this.emit('update', update)
    }
  }

  async _handleAuth (update: Td$updateAuthorizationState): Promise<void> {
    const authorizationState = update.authorization_state

    switch (authorizationState._) {
      case 'authorizationStateWaitTdlibParameters':
        if (this._version.gte(TDLIB_1_8_6)) {
          // $FlowIgnore[prop-missing]
          if (this._options.tdlibParameters._ != null)
            throw new Error('tdlibParameters must not contain the _ property')
          // $FlowIgnore[prop-missing]
          this._sendTdl({
            _: 'setTdlibParameters',
            database_directory: resolvePath(this._options.databaseDirectory),
            files_directory: resolvePath(this._options.filesDirectory),
            api_id: this._options.apiId,
            api_hash: this._options.apiHash,
            use_test_dc: this._options.useTestDc,
            database_encryption_key: this._options.databaseEncryptionKey,
            ...this._options.tdlibParameters
          })
          return this._connectDefer.resolve()
        }
        return this._sendTdl({
          _: 'setTdlibParameters',
          'parameters': {
            database_directory: resolvePath(this._options.databaseDirectory),
            files_directory: resolvePath(this._options.filesDirectory),
            api_id: this._options.apiId,
            api_hash: this._options.apiHash,
            use_test_dc: this._options.useTestDc,
            ...this._options.tdlibParameters,
            _: 'tdlibParameters'
          }
        })

      // This update can be received in TDLib <= v1.8.5 only
      case 'authorizationStateWaitEncryptionKey':
        this._sendTdl({
          _: 'checkDatabaseEncryptionKey',
          encryption_key: this._options.databaseEncryptionKey
        })
        return this._connectDefer.resolve()

      case 'authorizationStateClosed':
        this._rejectConnectAndLogin(Error('Received authorizationStateClosed'))
        return this.destroy()

      case 'authorizationStateReady':
        if (!this._authNeeded) this.emit('auth-not-needed')
    }

    await this._waitLogin()
    debug('waitLogin end', authorizationState._)

    // TODO: Handle authorizationStateWaitOtherDeviceConfirmation?

    switch (authorizationState._) {
      case 'authorizationStateWaitPhoneNumber': {
        const loginDetails = this._authHasNeeded()

        switch (loginDetails.type) {
          case 'user':
            return this._sendTdl({
              _: 'setAuthenticationPhoneNumber',
              phone_number: await loginDetails.getPhoneNumber(false)
            })
          case 'bot':
            return this._sendTdl({
              _: 'checkAuthenticationBotToken',
              token: await loginDetails.getToken(false)
            })
        }
      }

      // $FlowIgnore[incompatible-type]: TDLib >= v1.8.6 only
      case 'authorizationStateWaitEmailAddress': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return
        // $FlowIgnore[incompatible-call]
        return this._sendTdl({
          _: 'setAuthenticationEmailAddress',
          email_address: await loginDetails.getEmailAddress()
        })
      }

      // $FlowIgnore[incompatible-type]: TDLib >= v1.8.6 only
      case 'authorizationStateWaitEmailCode': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return
        // $FlowIgnore[incompatible-call]
        return this._sendTdl({
          _: 'checkAuthenticationEmailCode',
          code: {
            // Apple ID and Google ID are not supported
            _: 'emailAddressAuthenticationCode',
            code: await loginDetails.getEmailCode()
          }
        })
      }

      case 'authorizationStateWaitOtherDeviceConfirmation': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return
        loginDetails.confirmOnAnotherDevice(authorizationState.link)
        return
      }

      case 'authorizationStateWaitCode': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return

        const code = await loginDetails.getAuthCode(false)
        return this._sendTdl({
          _: 'checkAuthenticationCode',
          code
        })
      }

      case 'authorizationStateWaitRegistration': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return

        const { firstName, lastName = '' } = await loginDetails.getName()
        return this._sendTdl({
          _: 'registerUser',
          first_name: firstName,
          last_name: lastName
        })
      }

      case 'authorizationStateWaitPassword': {
        const loginDetails = this._authHasNeeded()
        if (loginDetails.type !== 'user') return

        const passwordHint = authorizationState.password_hint
        const password = await loginDetails.getPassword(passwordHint, false)
        return this._sendTdl({
          _: 'checkAuthenticationPassword',
          password
        })
      }

      case 'authorizationStateReady':
        return this._loginDefer.resolve()
    }
  }

  _emitErrWithoutExtra (error: Td$error): void {
    // $FlowIgnore[prop-missing]
    delete error['@extra']
    this._catchError(error)
  }

  async _handleError (error: Td$error): Promise<void> {
    // $FlowIgnore[prop-missing]
    const id = error['@extra']
    const defer = this._fetching.get(id)

    if (defer) {
      // $FlowIgnore[prop-missing]
      delete error['@extra']
      defer.reject(error)
      this._fetching.delete(id)
    } else if (id === TDL_MAGIC) {
      const loginDetails = this._loginDetails

      if (!loginDetails) return this._emitErrWithoutExtra(error)

      switch (loginDetails.type) {
        case 'user': return this._handleUserError(error, loginDetails)
        case 'bot': return this._handleBotError(error, loginDetails)
      }
    } else {
      this.emit('error', error)
    }
  }

  async _handleUserError (error: Td$error, loginDetails: LoginUser): Promise<void> {
    switch (error.message) {
      case 'PHONE_CODE_EMPTY':
      case 'PHONE_CODE_INVALID':
        return this._sendTdl({
          _: 'checkAuthenticationCode',
          code: await loginDetails.getAuthCode(true)
        })

      case 'PHONE_NUMBER_INVALID':
        return this._sendTdl({
          _: 'setAuthenticationPhoneNumber',
          phone_number: await loginDetails.getPhoneNumber(true)
        })

      case 'PASSWORD_HASH_INVALID':
        return this._sendTdl({
          _: 'checkAuthenticationPassword',
          password: await loginDetails.getPassword('', true)
        })

      default: this._emitErrWithoutExtra(error)
    }
  }

  async _handleBotError (error: Td$error, loginDetails: LoginBot): Promise<void> {
    switch (error.message) {
      case 'ACCESS_TOKEN_INVALID':
        return this._sendTdl({
          _: 'checkAuthenticationBotToken',
          token: await loginDetails.getToken(true)
        })

      default: this._emitErrWithoutExtra(error)
    }
  }
}
