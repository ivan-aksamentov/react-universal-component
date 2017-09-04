// @flow
import type {
  Tools,
  ModuleOptions,
  Ids,
  Config,
  ConfigFunc,
  Props,
  Load,
  OnLoad
} from './flowTypes'

import {
  isWebpack,
  tryRequire,
  resolveExport,
  callForString,
  loadFromPromiseCache,
  cacheProm,
  findExport
} from './utils'

export const IS_TEST = process.env.NODE_ENV === 'test'
export const isServer = typeof window === 'undefined' || IS_TEST

declare var __webpack_require__: Function
declare var __webpack_modules__: Object

export const CHUNK_NAMES = new Set()
export const MODULE_IDS = new Set()
export const MODULES: Map<string, any> = new Map()
export const ON_LOAD_CALLBACKS: Map<any, Set<OnLoad>> = new Map()

export default function requireUniversalModule<Props: Props>(
  universalConfig: Config | ConfigFunc,
  options: ModuleOptions,
  props: Props,
  prevProps?: Props
): Tools {
  const {
    key,
    timeout = 15000,
    onLoad,
    onError,
    isDynamic,
    promCache
  } = options

  const config = getConfig(isDynamic, universalConfig, options, props)
  const { chunkName, path, resolve, load } = config
  const asyncOnly = !path && !resolve

  const requireSync = (props: Object, context: Object): ?any => {
    let mod = MODULES.get(callForString(chunkName, props))

    if (!mod) {
      if (!isWebpack() && path) {
        const modulePath = callForString(path, props) || ''
        mod = tryRequire(modulePath)
      }
      else if (isWebpack() && resolve) {
        const weakId = callForString(resolve, props)

        if (__webpack_modules__[weakId]) {
          mod = tryRequire(weakId)
        }
      }
    }

    if (!mod) return

    resolveExport(
      mod,
      onLoad,
      chunkName,
      props,
      context,
      MODULES,
      ON_LOAD_CALLBACKS,
      true
    )

    return findExport(mod, key)
  }

  const requireAsync = (props: Object, context: Object): Promise<?any> => {
    const cachedMod = MODULES.get(callForString(chunkName, props))
    if (cachedMod) {
      // in case if called with new onLoad function
      resolveExport(
        cachedMod,
        onLoad,
        chunkName,
        props,
        context,
        MODULES,
        ON_LOAD_CALLBACKS
      )
      return Promise.resolve(findExport(cachedMod, key))
    }

    const cachedPromise = loadFromPromiseCache(chunkName, props, promCache)
    if (cachedPromise) return cachedPromise

    const prom = new Promise((res, rej) => {
      const reject = error => {
        error = error || new Error('timeout exceeded')
        clearTimeout(timer)
        if (onError) {
          const isServer = typeof window === 'undefined'
          const info = { isServer }
          onError(error, info)
        }
        rej(error)
      }

      // const timer = timeout && setTimeout(reject, timeout)
      const timer = timeout && setTimeout(reject, timeout)

      const resolve = mod => {
        clearTimeout(timer)

        resolveExport(
          mod,
          onLoad,
          chunkName,
          props,
          context,
          MODULES,
          ON_LOAD_CALLBACKS
        )

        const exp = mod && findExport(mod, key)
        if (exp) return res(exp)

        reject(new Error('export not found'))
      }

      const request = load(props, { resolve, reject })

      // if load doesn't return a promise, it must call resolveImport
      // itself. Most common is the promise implementation below.
      if (!request || typeof request.then !== 'function') return
      request.then(resolve).catch(reject)
    })

    cacheProm(prom, chunkName, props, promCache)
    return prom
  }

  const addModule = (props: Object): void => {
    if (isServer) {
      if (chunkName) {
        const name = callForString(chunkName, props)
        if (name) CHUNK_NAMES.add(name)
        if (!IS_TEST) return // makes tests way smaller to run both kinds
      }

      if (isWebpack()) {
        const weakId = callForString(resolve, props)
        if (weakId) MODULE_IDS.add(weakId)
      }
      else if (!isWebpack()) {
        const modulePath = callForString(path, props)
        if (modulePath) MODULE_IDS.add(modulePath)
      }
    }
  }

  const shouldUpdate = (next, prev): boolean => {
    if (asyncOnly) {
      const cacheKey = callForString(chunkName, next)

      const config = getConfig(isDynamic, universalConfig, options, prev)
      const prevCacheKey = callForString(config.chunkName, prev)

      return cacheKey !== prevCacheKey
    }

    // below is what the babel-plugin triggers

    if (!prevProps) return false

    const cacheKey = callForString(chunkName, props)

    const config = getConfig(isDynamic, universalConfig, options, prevProps)
    const prevCacheKey = callForString(config.chunkName, prevProps)

    return cacheKey !== prevCacheKey
  }

  return {
    requireSync,
    requireAsync,
    addModule,
    shouldUpdate,
    asyncOnly
  }
}

export const flushChunkNames = (): Ids => {
  const chunks = Array.from(CHUNK_NAMES)
  CHUNK_NAMES.clear()
  // do not clear MODULES as they won't change
  ON_LOAD_CALLBACKS.clear()
  return chunks
}

export const flushModuleIds = (): Ids => {
  const ids = Array.from(MODULE_IDS)
  MODULE_IDS.clear()
  // do not clear MODULES as they won't change
  ON_LOAD_CALLBACKS.clear()
  return ids
}

// for test purpose
export const clearModulesCache = () => {
  MODULES.clear()
}

const getConfig = (
  isDynamic: ?boolean,
  universalConfig: Config | ConfigFunc,
  options: ModuleOptions,
  props: Props
): Config => {
  if (isDynamic) {
    return typeof universalConfig === 'function'
      ? universalConfig(props)
      : universalConfig
  }

  const load: Load =
    typeof universalConfig === 'function'
      ? universalConfig
      : // $FlowIssue
        () => universalConfig

  return {
    file: 'default',
    id: options.id || 'default',
    chunkName: options.chunkName || 'default',
    resolve: options.resolve || '',
    path: options.path || '',
    load
  }
}
